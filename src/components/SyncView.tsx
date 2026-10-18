// src/components/SyncView.tsx — Schermata Sync live (M3a.3 — Deliverable 6 redesign).
//
// DUE PROVIDER attivi contemporaneamente (vedi brief M3a.3):
//   1. SupabaseYjsProvider (primary, sempre attivo, relay + offline storage)
//   2. IrohYjsProvider (secondary, p2p diretto low-latency)
//
// Il SyncManager è istanziato da App.tsx al boot (vedi App.tsx::bootSync()).
// SyncView NON avvia/disattiva il sync — legge lo stato corrente e offre:
//   1. Visualizzazione identità (peer_key + display_name + [salva])
//   2. Stato connessione dual-provider (● Supabase + ●/○ Iroh)
//   3. Lista peer conosciuti (sync_peers trusted) con [connetti]/[rimuovi]
//   4. Aggiungi nuovo peer (input + [connetti e salva])
//   5. Box info (Supabase sempre attivo, Iroh opzionale)
//
// Boot sequence (App.tsx):
//   1. initYjsBridge() → listener yPlayers.observe etc.
//   2. SyncManager + addProvider(Supabase) [sempre]
//   3. Se sync_identity esiste → addProvider(Iroh) + auto-connect trusted peers
//   4. connectAll()
//
// Vincolo HARD #14: Pairing esplicito (peer key scambiata out-of-band).
// Vincolo HARD #21: Iroh opzionale — se non disponibile, Supabase basta.

import { useEffect, useState, useCallback, useRef } from "react";
import { api, isDesktop } from "@/api/tauri";
import { getSyncManager } from "@/lib/sync/SyncManager";
import { setMyIdentity } from "@/lib/sync/yjsCursors";
import { ydoc } from "@/lib/sync/yjsDocuments";
import { IrohYjsProvider } from "@/lib/sync/IrohYjsProvider";
import type { SyncIdentity, TrustedPeer } from "@/types/sync";

// ----------------------------------------------------------------------
// Stati locali UI
// ----------------------------------------------------------------------

interface ConnectionState {
  /** True se SupabaseYjsProvider è connesso (sempre true salvo errori rete). */
  supabaseConnected: boolean;
  /** True se IrohYjsProvider è connesso (false se peer_key non ancora creata). */
  irohConnected: boolean;
  /** Peer key Iroh corrente (NodeId base32). Null se non ancora avviato. */
  peerKey: string | null;
  /** Identità sync persistita (letta da sync_identity table). */
  identity: SyncIdentity | null;
  /** Lista peer fidati salvati (sync_peers trusted=1). */
  trustedPeers: TrustedPeer[];
  /** Peer attualmente connessi via Iroh (subset dei trusted, live state). */
  connectedPeers: string[];
  /** Nome display (input locale, sync con backend su [salva]). */
  displayNameInput: string;
  /** True se è in corso un'operazione (avvio Iroh, connect, save name). */
  busy: boolean;
  /** Messaggio di errore (stringa), null se tutto OK. */
  error: string | null;
  /** True se il nome è stato appena salvato (per feedback UX "salvato!"). */
  nameSaved: boolean;
  /** True se la peer_key è stata appena copiata (per feedback "copiato!"). */
  copied: boolean;
}

const initialState: ConnectionState = {
  supabaseConnected: false,
  irohConnected: false,
  peerKey: null,
  identity: null,
  trustedPeers: [],
  connectedPeers: [],
  displayNameInput: "",
  busy: false,
  error: null,
  nameSaved: false,
  copied: false,
};

// ----------------------------------------------------------------------
// Componente principale
// ----------------------------------------------------------------------

export function SyncView(): React.ReactElement {
  const [state, setState] = useState<ConnectionState>(initialState);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Funzione di refresh unico stato da SyncManager + API ---
  const refresh = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const syncManager = getSyncManager();
      const connectedProviders = syncManager.getConnectedProviders();
      const supabaseConnected = connectedProviders.includes("supabase");
      const irohConnected = connectedProviders.includes("iroh");

      const [identity, trustedPeers, connectedPeers] = await Promise.all([
        api.getSyncIdentity(),
        api.listTrustedPeers(),
        api.irohGetConnectedPeers().catch(() => [] as string[]),
      ]);

      setState((s) => ({
        ...s,
        supabaseConnected,
        irohConnected,
        peerKey: identity?.peerKey ?? null,
        identity,
        trustedPeers,
        connectedPeers,
        // Non sovrascrivere displayNameInput se l'utente sta editando
        displayNameInput:
          s.displayNameInput || identity?.displayName || "",
      }));
    } catch (err) {
      console.warn("[SyncView] refresh fallito:", err);
    }
  }, []);

  // --- Boot effect: refresh + polling 2s per status realtime ---
  useEffect(() => {
    void refresh();
    pollTimer.current = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [refresh]);

  // --- Avvia Iroh manualmente (se peer_key non ancora creata) ---
  const handleStartIroh = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      // irohStartNode genera la SecretKey (se non esiste) e la salva in
      // sync_identity, poi avvia il nodo Iroh. Il provider IrohYjsProvider
      // deve essere registrato qui (App.tsx non l'ha fatto al boot perché
      // non c'era ancora sync_identity).
      const peerKey = await api.irohStartNode();
      setMyIdentity(peerKey, undefined);
      // Registra dinamicamente IrohYjsProvider nel SyncManager.
      const syncManager = getSyncManager();
      // Se non è già registrato, lo istanziamo ora.
      if (!syncManager.getProvider("iroh")) {
        const provider = new IrohYjsProvider(ydoc);
        syncManager.addProvider(provider);
        await provider.connect();
      }
      // Auto-connect trusted peers salvati.
      const trusted = await api.listTrustedPeers();
      if (trusted.length > 0) {
        const irohProvider = syncManager.getProvider<IrohYjsProvider>("iroh");
        if (irohProvider) {
          void irohProvider.connectToSavedPeers(trusted.map((p) => p.peerId));
        }
      }
      await refresh();
    } catch (err) {
      setState((s) => ({
        ...s,
        error: `Avvio Iroh fallito: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setState((s) => ({ ...s, busy: false }));
    }
  }, [refresh]);

  // --- Salva display_name ---
  const handleSaveName = useCallback(async () => {
    const name = state.displayNameInput.trim();
    if (!name) return;
    setState((s) => ({ ...s, busy: true, error: null, nameSaved: false }));
    try {
      await api.setSyncDisplayName(name);
      setMyIdentity(state.peerKey ?? "unknown", name);
      setState((s) => ({ ...s, busy: false, nameSaved: true }));
      // Reset "salvato!" dopo 2s
      setTimeout(() => {
        setState((s) => ({ ...s, nameSaved: false }));
      }, 2000);
      await refresh();
    } catch (err) {
      setState((s) => ({
        ...s,
        busy: false,
        error: `Salvataggio nome fallito: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }, [state.displayNameInput, state.peerKey, refresh]);

  // --- Copia peer_key negli appunti ---
  const handleCopy = useCallback(async () => {
    if (!state.peerKey) return;
    try {
      await navigator.clipboard.writeText(state.peerKey);
      setState((s) => ({ ...s, copied: true }));
      setTimeout(() => setState((s) => ({ ...s, copied: false })), 2000);
    } catch {
      // Fallback: prompt manuale
      window.prompt("Copia la peer key:", state.peerKey);
    }
  }, [state.peerKey]);

  // --- Connetti nuovo peer ---
  const [newPeerKey, setNewPeerKey] = useState("");
  const handleConnectNew = useCallback(async () => {
    const pk = newPeerKey.trim();
    if (!pk) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      // Prima avvia Iroh se non ancora attivo
      if (!state.peerKey) {
        await api.irohStartNode();
        const syncManager = getSyncManager();
        if (!syncManager.getProvider("iroh")) {
          syncManager.addProvider(new IrohYjsProvider(ydoc));
        }
      }
      const connected = await api.irohConnectByPeerKeyV2(pk);
      if (!connected) {
        setState((s) => ({
          ...s,
          busy: false,
          error: `Connessione a ${pk.slice(0, 16)}... fallita. Peer dietro NAT senza relay? Riprova tra 30s.`,
        }));
        return;
      }
      setNewPeerKey("");
      await refresh();
    } catch (err) {
      setState((s) => ({
        ...s,
        busy: false,
        error: `Connessione fallita: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
  }, [newPeerKey, state.peerKey, refresh]);

  // --- Disconnetti un peer ---
  const handleDisconnectPeer = useCallback(
    async (peerKey: string) => {
      try {
        await api.irohDisconnectPeer(peerKey);
        await refresh();
      } catch (err) {
        setState((s) => ({
          ...s,
          error: `Disconnessione fallita: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    },
    [refresh]
  );

  // --- Rimuovi un peer dai trusted ---
  const handleRemovePeer = useCallback(
    async (peerKey: string) => {
      if (
        !window.confirm(
          `Rimuovere ${peerKey.slice(0, 16)}... dai peer fidati? Potrai ri-aggiungerlo incollando la peer key.`
        )
      )
        return;
      try {
        await api.removeTrustedPeer(peerKey);
        await api.irohDisconnectPeer(peerKey);
        await refresh();
      } catch (err) {
        setState((s) => ({
          ...s,
          error: `Rimozione peer fallita: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    },
    [refresh]
  );

  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------

  // Anteprima web (mock): messaggio informativo
  if (!isDesktop) {
    return (
      <section
        style={{
          width: "560px",
          maxWidth: "90vw",
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          padding: "24px",
          boxShadow: "0 12px 24px rgba(43,27,18,0.08), 0 4px 8px rgba(43,27,18,0.12)",
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "18px",
            color: "var(--ink)",
            marginBottom: "12px",
          }}
        >
          Sync Live
        </h2>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "13px",
            color: "var(--ink-soft)",
            lineHeight: 1.5,
          }}
        >
          Anteprima web — sync live disponibile solo nel binario Tauri. Avvia
          l'app con `npm run tauri:dev` per testare Supabase + Iroh.
        </p>
      </section>
    );
  }

  return (
    <section
      style={{
        width: "640px",
        maxWidth: "90vw",
        maxHeight: "85vh",
        overflowY: "auto",
        background: "var(--paper)",
        border: "2px solid var(--ink)",
        padding: "24px",
        boxShadow:
          "0 12px 24px rgba(43,27,18,0.08), 0 4px 8px rgba(43,27,18,0.12), 0 1px 2px rgba(43,27,18,0.20)",
        fontFamily: "var(--font-body)",
        color: "var(--ink)",
      }}
    >
      <h2
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "20px",
          color: "var(--ink)",
          marginBottom: "20px",
          borderBottom: "2px solid var(--ink-soft)",
          paddingBottom: "8px",
        }}
      >
        Sync Live
      </h2>

      {/* --- IDENTITÀ --- */}
      <div style={{ marginBottom: "20px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "13px",
            color: "var(--ink-soft)",
            marginBottom: "8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          La tua identità
        </div>
        {state.identity ? (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "8px 12px",
                background: "var(--paper-dim)",
                border: "1px solid rgba(43,27,18,0.2)",
                marginBottom: "8px",
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: "var(--green)", fontSize: "16px" }}>●</span>
              <span style={{ fontFamily: "var(--font-display)", fontSize: "14px" }}>
                {state.identity.displayName || "anonimo"}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono, var(--font-body))",
                  fontSize: "11px",
                  color: "var(--ink-soft)",
                  wordBreak: "break-all",
                }}
              >
                peer key: {state.peerKey?.slice(0, 32)}…
              </span>
              <button
                type="button"
                onClick={handleCopy}
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "11px",
                  padding: "4px 10px",
                  background: state.copied ? "var(--green)" : "var(--ink)",
                  color: "var(--paper)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {state.copied ? "copiato!" : "copia"}
              </button>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "12px",
                color: "var(--ink-soft)",
                marginBottom: "12px",
              }}
            >
              <span style={{ color: "var(--green)" }}>✓</span>
              <span>salvata permanentemente (stabile cross-boot)</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <label
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "12px",
                  color: "var(--ink-soft)",
                }}
              >
                nome:
              </label>
              <input
                type="text"
                value={state.displayNameInput}
                onChange={(e) =>
                  setState((s) => ({ ...s, displayNameInput: e.target.value }))
                }
                placeholder="es. marco"
                maxLength={64}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-body)",
                  fontSize: "13px",
                  padding: "6px 10px",
                  background: "var(--paper)",
                  border: "1px solid var(--ink-soft)",
                  color: "var(--ink)",
                }}
              />
              <button
                type="button"
                onClick={handleSaveName}
                disabled={state.busy || !state.displayNameInput.trim()}
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "12px",
                  padding: "6px 14px",
                  background: state.nameSaved ? "var(--green)" : "var(--ink)",
                  color: "var(--paper)",
                  border: "none",
                  cursor: state.busy ? "wait" : "pointer",
                }}
              >
                {state.nameSaved ? "salvato!" : "salva"}
              </button>
            </div>
          </>
        ) : (
          <div
            style={{
              padding: "12px",
              background: "var(--paper-dim)",
              border: "1px dashed var(--ink-soft)",
            }}
          >
            <p
              style={{
                fontSize: "13px",
                color: "var(--ink-soft)",
                marginBottom: "8px",
                lineHeight: 1.5,
              }}
            >
              Nessuna identità sync ancora creata. Avvia Iroh per generare una
              peer_key stabile (salvata su SQLite, cross-boot). La potrai
              condividere out-of-band con il tuo amico per il pairing.
            </p>
            <button
              type="button"
              onClick={handleStartIroh}
              disabled={state.busy}
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "13px",
                padding: "8px 16px",
                background: "var(--blue, #2C4A6B)",
                color: "var(--paper)",
                border: "none",
                cursor: state.busy ? "wait" : "pointer",
              }}
            >
              {state.busy ? "avvio in corso…" : "Avvia Iroh"}
            </button>
          </div>
        )}
      </div>

      {/* --- STATO CONNESSIONE --- */}
      <div
        style={{
          marginBottom: "20px",
          padding: "12px",
          background: "var(--paper-dim)",
          border: "1px solid rgba(43,27,18,0.15)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "12px",
            color: "var(--ink-soft)",
            marginBottom: "8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Stato connessione
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            fontFamily: "var(--font-body)",
            fontSize: "13px",
          }}
        >
          <div>
            <span
              style={{
                color: state.supabaseConnected ? "var(--green)" : "var(--red)",
              }}
            >
              {state.supabaseConnected ? "●" : "○"}
            </span>{" "}
            <strong>Supabase:</strong>{" "}
            {state.supabaseConnected
              ? "connesso (relay + offline storage)"
              : "non connesso (verifica URL/key in syncConfig.ts)"}
          </div>
          <div>
            <span
              style={{
                color: state.irohConnected ? "var(--green)" : "var(--amber, #B8860B)",
              }}
            >
              {state.irohConnected ? "●" : "○"}
            </span>{" "}
            <strong>Iroh diretto:</strong>{" "}
            {state.irohConnected
              ? `${state.connectedPeers.length} peer attivo (${state.connectedPeers.length > 0 ? "~50ms" : "in attesa"})`
              : state.identity
              ? "nessun peer connesso (solo relay Supabase)"
              : "non avviato — genera una peer_key per attivare"}
          </div>
        </div>
      </div>

      {/* --- PEER CONOSCIUTI --- */}
      <div style={{ marginBottom: "20px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "12px",
            color: "var(--ink-soft)",
            marginBottom: "8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Peer conosciuti (Iroh) — {state.trustedPeers.length} salvati
        </div>
        {state.trustedPeers.length === 0 ? (
          <div
            style={{
              padding: "12px",
              background: "var(--paper-dim)",
              border: "1px dashed var(--ink-soft)",
              fontSize: "12px",
              color: "var(--ink-soft)",
            }}
          >
            Nessun peer conosciuto. Aggiungi un amico incollando la sua peer_key
            qui sotto.
          </div>
        ) : (
          <div
            style={{
              border: "1px solid rgba(43,27,18,0.2)",
              background: "var(--paper-dim)",
            }}
          >
            {state.trustedPeers.map((peer, idx) => {
              const isOnline = state.connectedPeers.includes(peer.peerId);
              return (
                <div
                  key={peer.peerId}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    padding: "10px 12px",
                    borderBottom:
                      idx < state.trustedPeers.length - 1
                        ? "1px solid rgba(43,27,18,0.15)"
                        : "none",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        color: isOnline ? "var(--green)" : "var(--ink-soft)",
                      }}
                    >
                      {isOnline ? "●" : "○"}
                    </span>
                    <strong style={{ fontSize: "13px" }}>
                      {peer.displayName || peer.peerId.slice(0, 16) + "…"}
                    </strong>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, var(--font-body))",
                        fontSize: "10px",
                        color: "var(--ink-soft)",
                        wordBreak: "break-all",
                      }}
                    >
                      ({peer.peerId.slice(0, 24)}…)
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "11px",
                      color: "var(--ink-soft)",
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      stato:{" "}
                      {isOnline ? (
                        <>
                          <strong style={{ color: "var(--green)" }}>online</strong>{" "}
                          · ●live (latenza ~50ms via QUIC diretto)
                        </>
                      ) : (
                        <>
                          <strong>offline</strong> · modifiche via Supabase
                          (recuperate al suo prossimo avvio)
                        </>
                      )}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                    {isOnline ? (
                      <button
                        type="button"
                        onClick={() => handleDisconnectPeer(peer.peerId)}
                        style={btnSecondaryStyle}
                      >
                        disconnetti
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          setState((s) => ({ ...s, busy: true, error: null }));
                          try {
                            const ok = await api.irohConnectByPeerKeyV2(
                              peer.peerId
                            );
                            if (!ok) {
                              setState((s) => ({
                                ...s,
                                error: `Riconnessione a ${peer.peerId.slice(0, 16)}… fallita (timeout 10s).`,
                              }));
                            }
                          } finally {
                            setState((s) => ({ ...s, busy: false }));
                            void refresh();
                          }
                        }}
                        disabled={state.busy}
                        style={btnSecondaryStyle}
                      >
                        connetti
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemovePeer(peer.peerId)}
                      style={{
                        ...btnSecondaryStyle,
                        color: "var(--red)",
                        borderColor: "var(--red)",
                      }}
                    >
                      rimuovi
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* --- AGGIUNGI NUOVO PEER --- */}
      <div style={{ marginBottom: "20px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "12px",
            color: "var(--ink-soft)",
            marginBottom: "8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Aggiungi nuovo peer (Iroh)
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={newPeerKey}
            onChange={(e) => setNewPeerKey(e.target.value)}
            placeholder="incolla peer key (NodeId base32)..."
            style={{
              flex: 1,
              fontFamily: "var(--font-mono, var(--font-body))",
              fontSize: "12px",
              padding: "6px 10px",
              background: "var(--paper)",
              border: "1px solid var(--ink-soft)",
              color: "var(--ink)",
            }}
          />
          <button
            type="button"
            onClick={handleConnectNew}
            disabled={state.busy || !newPeerKey.trim()}
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "12px",
              padding: "6px 14px",
              background: "var(--blue, #2C4A6B)",
              color: "var(--paper)",
              border: "none",
              cursor: state.busy ? "wait" : "pointer",
            }}
          >
            {state.busy ? "…" : "connetti e salva"}
          </button>
        </div>
      </div>

      {/* --- INFO --- */}
      <div
        style={{
          padding: "12px",
          background: "var(--paper-dim)",
          border: "1px dashed rgba(43,27,18,0.3)",
          fontSize: "11px",
          color: "var(--ink-soft)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ fontFamily: "var(--font-display)" }}>Supabase:</strong>{" "}
        sempre attivo, garantisce sync anche offline. Modifiche bufferizzate e
        propagate al rientro. Latenza ~100ms (WebSocket relay).
        <br />
        <strong style={{ fontFamily: "var(--font-display)" }}>Iroh:</strong>{" "}
        connessione diretta p2p via QUIC, latenza minore (~50ms) quando entrambi
        online. Opzionale — se non disponibile, Supabase basta.
      </div>

      {/* --- ERROR --- */}
      {state.error && (
        <div
          style={{
            marginTop: "16px",
            padding: "10px 12px",
            background: "rgba(139,46,31,0.08)",
            border: "1px solid var(--red)",
            color: "var(--red)",
            fontFamily: "var(--font-body)",
            fontSize: "12px",
          }}
        >
          {state.error}
        </div>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------
// Style helpers
// ----------------------------------------------------------------------

const btnSecondaryStyle: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "11px",
  padding: "4px 10px",
  background: "transparent",
  color: "var(--ink)",
  border: "1px solid var(--ink-soft)",
  cursor: "pointer",
};
