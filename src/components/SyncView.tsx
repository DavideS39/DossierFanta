// src/components/SyncView.tsx — Schermata Sync live (M3a — B.5).
//
// Layout (mockup brief B.5):
//   ┌─ SYNC LIVE ──────────────────────────────────────┐
//   │ Il tuo peer key:                                  │
//   │ ┌────────────────────────────────────────────┐    │
//   │ │ abc23-def45-ghi78-jkl90-mno12-pqr34        │    │
//   │ │ [copia]                                     │    │
//   │ └────────────────────────────────────────────┘    │
//   │ Peer connessi: 1                                  │
//   │ ● marco (connesso · ●live)                        │
//   │ Connetti nuovo peer:                              │
//   │ ┌────────────────────────────────────────────┐    │
//   │ │ inserisci peer key...                      │    │
//   │ └────────────────────────────────────────────┘    │
//   │ [connetti]                                        │
//   │ Stato sync:                                       │
//   │ ● Live (modifiche propagate in tempo reale)       │
//   │ ○ Offline (modifiche bufferizzate)                 │
//   └───────────────────────────────────────────────────┘
//
// Pairing flow (brief B.5):
//  1. Utente A apre Sync → vede il proprio peer key
//  2. Utente A condivide peer key a Utente B (out-of-band)
//  3. Utente B apre Sync → inserisce peer key di A → click "connetti"
//  4. Iroh stabilisce connessione (NAT traversal automatico, ~2-5 sec)
//  5. Sync iniziale: scambio state vector + diff Yjs
//  6. Stato "●Live" verde. Da qui, modifiche propagate in ~30-80ms (QUIC)
//     o ~150-300ms (con relay).
//
// Vincolo HARD #14: Pairing esplicito (peer key scambiata out-of-band).
// Niente auto-discovery su internet.

import { useEffect, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isDesktop } from "@/api/tauri";
import {
  applyRemoteUpdate,
  initYjsBridge,
  initialSync,
} from "@/lib/sync/yjsDocuments";
import {
  setMyIdentity,
  startCursorsCleanup,
  stopCursorsCleanup,
} from "@/lib/sync/yjsCursors";
import type { SyncStatus, PeerKey, SyncUpdateReceivedEvent } from "@/types/sync";

// ----------------------------------------------------------------------
// Stato locale UI (mock per anteprima web se non in Tauri)
// ----------------------------------------------------------------------

const initialStatus: SyncStatus = {
  started: false,
  peerKey: null,
  connectedPeers: [],
  status: "offline",
  lastUpdateAt: null,
  updatesReceived: 0,
  updatesSent: 0,
};

// ----------------------------------------------------------------------
// Componente principale
// ----------------------------------------------------------------------

export function SyncView(): React.ReactElement {
  const [status, setStatus] = useState<SyncStatus>(initialStatus);
  const [newPeerKey, setNewPeerKey] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- Boot: inizializza Yjs bridge + cursori cleanup + listener sync-update-received ----
  //
  // M3a.2 (PB4-B fix) — Registra il listener per l'evento Tauri
  // `sync-update-received`. Questo evento è emesso:
  //  - Dal subscribe loop di `iroh_start_node` (sync.rs) quando arriva un
  //    update via Iroh gossip (path p2p a distanza).
  //  - Da `handle_peer` (sync_lan.rs) quando arriva un `Message::Binary`
  //    via WebSocket LAN (path fallback LAN-only).
  //
  // Il payload contiene `update_bytes` (array di u8 0-255). Lo converto in
  // `Uint8Array` e chiamo `applyRemoteUpdate(bytes)` → `Y.applyUpdate(ydoc, bytes)`
  // → triggera i listener `yPlayers.observe` / `yNotes.observe` /
  // `yAuction.observe` → chiamano `save_*_from_sync` → SQLite del peer
  // ricevente aggiornato con `updated_by='sync-live'`.
  //
  // In M3a.1 NESSUN frontend registrava questo listener → Y.Doc frontend del
  // peer ricevente restava vuoto → NESSUN listener observe triggerato →
  // SQLite del peer ricevente MAI aggiornato (bug PB4-B bloccante).
  useEffect(() => {
    const cleanupYjs = initYjsBridge();
    startCursorsCleanup();

    // Listener per sync-update-received (path Iroh + path LAN-only).
    // In anteprima web (mock) non registra: non c'è Tauri runtime.
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    if (isDesktop) {
      listen<SyncUpdateReceivedEvent>("sync-update-received", (event) => {
        const { update_bytes, from_peer, bytes_len } = event.payload;
        if (!update_bytes || update_bytes.length === 0) {
          console.warn(
            "[SyncView] sync-update-received con payload vuoto (bytes_len=",
            bytes_len,
            "from_peer=",
            from_peer,
            ") — update non applicato"
          );
          return;
        }
        try {
          const bytes = new Uint8Array(update_bytes);
          applyRemoteUpdate(bytes);
          if (import.meta.env?.DEV) {
            console.debug(
              `[SyncView] sync-update-received: ${bytes_len} bytes da ${from_peer.slice(0, 16)}...`
            );
          }
        } catch (err) {
          console.error(
            "[SyncView] applyRemoteUpdate fallito (bytes_len=",
            bytes_len,
            "from_peer=",
            from_peer,
            "):",
            err
          );
        }
      })
        .then((un) => {
          if (cancelled) {
            // Il componente si è smontato durante l'await di listen()
            un();
            return;
          }
          unlistenFn = un;
        })
        .catch((err) => {
          console.error("[SyncView] listen('sync-update-received') fallito:", err);
        });
    }

    return () => {
      cleanupYjs();
      stopCursorsCleanup();
      cancelled = true;
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
    };
  }, []);

  // ---- Polling stato peer connessi (ogni 2s) ----
  useEffect(() => {
    if (!status.started) return;
    const interval = setInterval(async () => {
      try {
        const peers = isDesktop ? await api.irohGetConnectedPeers() : [];
        setStatus((s) => ({
          ...s,
          connectedPeers: peers,
          status: peers.length > 0 ? "live" : "offline",
        }));
      } catch (err) {
        console.debug("[SyncView] poll peers skip:", err);
      }
    }, 2_000);
    return () => clearInterval(interval);
  }, [status.started]);

  // ---- Azione: avvia nodo Iroh (lazy, solo su click) ----
  const handleStartNode = useCallback(async () => {
    setIsStarting(true);
    setError(null);
    try {
      const peerKey = isDesktop ? await api.irohStartNode() : "mock-peer-key-abc123";
      // Imposta identità locale per cursori
      setMyIdentity(peerKey, undefined);
      // Avvia listener per updates remoti (task di background Rust)
      if (isDesktop) {
        await api.irohSubscribeUpdates();
      }
      setStatus((s) => ({
        ...s,
        started: true,
        peerKey,
        status: "offline", // offline finché non si connette un peer
      }));
    } catch (err) {
      setError(`Errore avvio nodo Iroh: ${err}`);
    } finally {
      setIsStarting(false);
    }
  }, []);

  // ---- Azione: connetti a peer remoto ----
  const handleConnect = useCallback(async () => {
    if (!newPeerKey.trim()) return;
    setIsConnecting(true);
    setError(null);
    try {
      const ok = isDesktop
        ? await api.irohConnectByPeerKey(newPeerKey.trim())
        : true;
      if (ok) {
        // Sync iniziale
        await initialSync();
        setStatus((s) => ({
          ...s,
          connectedPeers: [...s.connectedPeers, newPeerKey.trim()],
          status: "live",
          lastUpdateAt: new Date().toISOString(),
        }));
        setNewPeerKey("");
      } else {
        setError("Connessione fallita — peer key non valida o peer irraggiungibile.");
      }
    } catch (err) {
      setError(`Errore connessione: ${err}`);
    } finally {
      setIsConnecting(false);
    }
  }, [newPeerKey]);

  // ---- Azione: disconnetti peer ----
  const handleDisconnect = useCallback(
    async (peerKey: PeerKey) => {
      try {
        if (isDesktop) await api.irohDisconnectPeer(peerKey);
        setStatus((s) => {
          const remaining = s.connectedPeers.filter((p) => p !== peerKey);
          return {
            ...s,
            connectedPeers: remaining,
            status: remaining.length > 0 ? "live" : "offline",
          };
        });
      } catch (err) {
        setError(`Errore disconnessione: ${err}`);
      }
    },
    []
  );

  // ---- Azione: copia peer key ----
  const handleCopy = useCallback(() => {
    if (!status.peerKey) return;
    navigator.clipboard
      .writeText(status.peerKey)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      })
      .catch(() => setError("Copia fallita — clipboard non disponibile."));
  }, [status.peerKey]);

  // ----------------------------------------------------------------------
  // Render
  // ----------------------------------------------------------------------

  return (
    <section
      className="sync-view"
      style={{
        maxWidth: "640px",
        margin: "0 auto",
        padding: "24px",
        background: "#F7F3E8",
        borderRadius: "12px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#2C4A6B",
      }}
    >
      <h2
        style={{
          fontSize: "20px",
          fontWeight: 700,
          margin: "0 0 16px 0",
          letterSpacing: "-0.01em",
        }}
      >
        Sync Live
      </h2>

      {!isDesktop && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: "16px",
            background: "#FFF4D6",
            border: "1px solid #E0C971",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#7A5C00",
          }}
        >
          Anteprima web — Iroh disattivato. Avvia l'app Tauri per il sync reale.
        </div>
      )}

      {/* --- Il tuo peer key --- */}
      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#5A6B7E",
            marginBottom: "6px",
          }}
        >
          Il tuo peer key
        </label>
        {status.peerKey ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              background: "#FFFFFF",
              border: "1px solid #D6CFC0",
              borderRadius: "6px",
              padding: "8px 10px",
            }}
          >
            <code
              style={{
                flex: 1,
                fontSize: "12px",
                fontFamily: "Sarasa Mono SC, monospace",
                color: "#2C4A6B",
                overflowWrap: "break-word",
                wordBreak: "break-all",
              }}
            >
              {status.peerKey}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                background: copied ? "#5A9E6B" : "#2C4A6B",
                color: "#FFFFFF",
                border: "none",
                borderRadius: "4px",
                padding: "6px 10px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {copied ? "copiato!" : "copia"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleStartNode}
            disabled={isStarting}
            style={{
              background: "#2C4A6B",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "6px",
              padding: "10px 16px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: isStarting ? "wait" : "pointer",
              opacity: isStarting ? 0.6 : 1,
            }}
          >
            {isStarting ? "avvio in corso..." : "Avvia nodo Iroh"}
          </button>
        )}
      </div>

      {/* --- Peer connessi --- */}
      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#5A6B7E",
            marginBottom: "6px",
          }}
        >
          Peer connessi: {status.connectedPeers.length}
        </label>
        {status.connectedPeers.length === 0 ? (
          <div
            style={{
              padding: "10px",
              background: "#FFFFFF",
              border: "1px dashed #D6CFC0",
              borderRadius: "6px",
              fontSize: "12px",
              color: "#9A8F7E",
              fontStyle: "italic",
            }}
          >
            Nessun peer connesso. Condividi la tua peer key o inseriscine una
            remota qui sotto.
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {status.connectedPeers.map((peer, idx) => (
              <li
                key={peer}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  background: "#FFFFFF",
                  border: "1px solid #D6CFC0",
                  borderRadius: "6px",
                  marginBottom: "4px",
                  fontSize: "13px",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "#5A9E6B",
                    marginRight: "4px",
                  }}
                  aria-hidden="true"
                />
                <code
                  style={{
                    flex: 1,
                    fontFamily: "Sarasa Mono SC, monospace",
                    fontSize: "12px",
                    color: "#2C4A6B",
                    overflowWrap: "break-word",
                    wordBreak: "break-all",
                  }}
                >
                  peer {idx + 1} · {peer.slice(0, 16)}...
                </code>
                <button
                  type="button"
                  onClick={() => handleDisconnect(peer)}
                  style={{
                    background: "transparent",
                    color: "#A04040",
                    border: "1px solid #D6C0C0",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                >
                  disconnetti
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- Connetti nuovo peer --- */}
      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#5A6B7E",
            marginBottom: "6px",
          }}
        >
          Connetti nuovo peer
        </label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={newPeerKey}
            onChange={(e) => setNewPeerKey(e.target.value)}
            placeholder="inserisci peer key..."
            disabled={!status.started || isConnecting}
            style={{
              flex: 1,
              padding: "8px 10px",
              border: "1px solid #D6CFC0",
              borderRadius: "6px",
              fontSize: "12px",
              fontFamily: "Sarasa Mono SC, monospace",
              background: "#FFFFFF",
              color: "#2C4A6B",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={handleConnect}
            disabled={!status.started || isConnecting || !newPeerKey.trim()}
            style={{
              background:
                !status.started || isConnecting || !newPeerKey.trim()
                  ? "#9A8F7E"
                  : "#2C4A6B",
              color: "#FFFFFF",
              border: "none",
              borderRadius: "6px",
              padding: "8px 14px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: isConnecting ? "wait" : "pointer",
              opacity: isConnecting ? 0.6 : 1,
            }}
          >
            {isConnecting ? "connessione..." : "connetti"}
          </button>
        </div>
      </div>

      {/* --- Stato sync --- */}
      <div>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 600,
            color: "#5A6B7E",
            marginBottom: "6px",
          }}
        >
          Stato sync
        </label>
        <div
          style={{
            padding: "10px 12px",
            background: "#FFFFFF",
            border: "1px solid #D6CFC0",
            borderRadius: "6px",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background:
                status.status === "live"
                  ? "#5A9E6B"
                  : status.status === "connecting"
                  ? "#E0C971"
                  : "#9A8F7E",
            }}
            aria-hidden="true"
          />
          {status.status === "live" && (
            <span>
              <strong>Live</strong> — modifiche propagate in tempo reale
              {status.lastUpdateAt && (
                <span style={{ color: "#9A8F7E", marginLeft: "6px" }}>
                  (ultimo update: {new Date(status.lastUpdateAt).toLocaleTimeString()})
                </span>
              )}
            </span>
          )}
          {status.status === "offline" && (
            <span>
              <strong>Offline</strong> — modifiche bufferizzate, propagate al
              rientro di un peer
            </span>
          )}
          {status.status === "connecting" && (
            <span>
              <strong>Connessione in corso...</strong>
            </span>
          )}
        </div>
      </div>

      {/* --- Errore --- */}
      {error && (
        <div
          style={{
            marginTop: "16px",
            padding: "10px 12px",
            background: "#F4DCDC",
            border: "1px solid #D6A0A0",
            borderRadius: "6px",
            fontSize: "12px",
            color: "#A04040",
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}
