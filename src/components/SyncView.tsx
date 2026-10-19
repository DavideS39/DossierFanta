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
import { getSupabaseClient, cleanupExpiredPairings } from "@/lib/sync/supabaseClient";
import { setMyIdentity } from "@/lib/sync/yjsCursors";
import { ydoc } from "@/lib/sync/yjsDocuments";
import { IrohYjsProvider } from "@/lib/sync/IrohYjsProvider";
import { SupabaseYjsProvider } from "@/lib/sync/SupabaseYjsProvider";
import type { SyncIdentity, TrustedPeer, Pairing, PairingPending } from "@/types/sync";

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
  // M3a.4 + M3a.5 — Pairing state
  /** Pairings salvati (sync_pairings). Ogni pairing = un canale cifrato con un peer. */
  pairings: Pairing[];
  /** Codici pairing in corso (initiator side, sync_pairings_pending). */
  pendingPairings: PairingPending[];
  /** Input per "inserisci codice ricevuto" (responder side). */
  joinCodeInput: string;
  /** Codice appena generato (initiator side, display temporaneo). */
  generatedCode: string | null;
  /** Stato del flow pairing corrente. */
  pairingFlow: "idle" | "creating" | "awaiting_response" | "joining" | "completing" | "error";
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
  // M3a.4 + M3a.5
  pairings: [],
  pendingPairings: [],
  joinCodeInput: "",
  generatedCode: null,
  pairingFlow: "idle",
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

      const [identity, trustedPeers, connectedPeers, pairings, pendingPairings] = await Promise.all([
        api.getSyncIdentity(),
        api.listTrustedPeers(),
        api.irohGetConnectedPeers().catch(() => [] as string[]),
        api.listPairings().catch(() => [] as Pairing[]),
        api.listPendingPairings().catch(() => [] as PairingPending[]),
      ]);

      setState((s) => ({
        ...s,
        supabaseConnected,
        irohConnected,
        peerKey: identity?.peerKey ?? null,
        identity,
        trustedPeers,
        connectedPeers,
        pairings,
        pendingPairings,
        // Non sovrascrivere displayNameInput se l'utente sta editando
        displayNameInput:
          s.displayNameInput || identity?.displayName || "",
      }));
    } catch (err) {
      console.warn("[SyncView] refresh fallito:", err);
    }
  }, []);

  // --- Boot effect: refresh + polling 5s per status realtime + cleanup expired pairings ---
  useEffect(() => {
    void refresh();
    pollTimer.current = setInterval(() => {
      void refresh();
      // M3a.5 — cleanup codici pairing scaduti su Supabase (>5min)
      void cleanupExpiredPairings(5);
    }, 5000);
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

  // M3a.5 — handleConnectNew e handleDisconnectPeer sono stati RIMOSSI.
  // Erano usati dalla sezione "Aggiungi nuovo peer" (peer_key paste) e
  // "Trusted peers" (lista peer connessi). Entrambe le sezioni sono state
  // rimosse in favore del pairing flow 8-cifre + ECDH (handleCreatePairing,
  // handleJoinPairing, handlePairingResponse, handleCancelPairing).
  // La gestione disconnessione/rimozione peer è ora demandata a
  // `handleRemovePeer` (rimuove pairing + Iroh trusted peer).

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
        // M3a.4 — rimuove anche il pairing cifrato (Supabase channel).
        await api.deletePairing(peerKey);
        // Rimuove il canale dal SupabaseYjsProvider (se in esecuzione).
        const syncManager = getSyncManager();
        const supabaseProvider = syncManager.getProvider("supabase") as
          | SupabaseYjsProvider
          | undefined;
        if (supabaseProvider && "removePairing" in supabaseProvider) {
          await supabaseProvider.removePairing(peerKey);
        }
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
  // M3a.5 — Pairing flow handlers (8-digit code + ECDH)
  // ----------------------------------------------------------------------

  /**
   * Initiator: genera codice 8-cifre, lo pubblica su Supabase `pairings` table,
   * subscribe al canale Realtime `pairing-<code>` per ricevere la risposta
   * del responder.
   */
  const handleCreatePairing = useCallback(async () => {
    setState((s) => ({ ...s, pairingFlow: "creating", error: null, generatedCode: null }));
    try {
      // 1. Assicurati che Iroh sia avviato (peer_key necessaria per pubblicare).
      if (!state.peerKey) {
        await handleStartIroh();
        // handleStartIroh aggiorna state.peerKey via refresh(). Per ottenere
        // il nuovo valore senza race, chiamiamo getSyncIdentity().
        const id = await api.getSyncIdentity();
        if (!id) {
          throw new Error("Iroh non avviabile — impossibile creare pairing");
        }
        // Aggiorniamo state.localmente per il prossimo step.
        state.peerKey = id.peerKey;
        state.identity = id;
      }

      // 2. Chiama il comando Rust per generare il codice + salvarlo localmente.
      const pairingCode = await api.pairingCreate();

      // 3. Pubblica su Supabase `pairings` table (rendezvous point).
      const supabase = getSupabaseClient();
      const { error: insertErr } = await supabase
        .from("pairings")
        .insert({
          code: pairingCode.code,
          peer_key_initiator: state.peerKey,
        });
      if (insertErr) {
        throw new Error(`Supabase insert pairings fallito: ${insertErr.message}`);
      }

      // 4. Subscribe al canale Realtime `pairing-<code>` per ascoltare la
      //    risposta del responder (quando entra il codice e fa ECDH).
      const channelName = `pairing-${pairingCode.code}`;
      const channel = supabase.channel(channelName, {
        config: { broadcast: { self: false } },
      });
      channel.on("broadcast", { event: "response" }, (msg) => {
        const payload = msg.payload as { peerKeyResponder?: string };
        if (payload?.peerKeyResponder) {
          void handlePairingResponse(pairingCode.code, payload.peerKeyResponder);
        }
      });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const t = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("pairing channel subscribe timeout"));
          }
        }, 10000);
        channel.subscribe((status: string) => {
          if (settled) return;
          if (status === "SUBSCRIBED") {
            settled = true;
            clearTimeout(t);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            settled = true;
            clearTimeout(t);
            reject(new Error(`pairing channel ${status}`));
          }
        });
      });

      setState((s) => ({
        ...s,
        pairingFlow: "awaiting_response",
        generatedCode: pairingCode.code,
      }));
      console.info(`[SyncView] pairing creato: codice ${pairingCode.code} (scade tra 5 min)`);
    } catch (err) {
      setState((s) => ({
        ...s,
        pairingFlow: "error",
        error: `Creazione pairing fallita: ${err instanceof Error ? err.message : String(err)}`,
      }));
      setTimeout(() => setState((s) => ({ ...s, pairingFlow: "idle" })), 4000);
    }
  }, [state.peerKey, handleStartIroh]);

  /**
   * Initiator: quando il responder risponde via Realtime broadcast sul
   * canale `pairing-<code>`, completa il pairing.
   * 1. Chiama `api.pairingComplete(code, peer_key_responder)` — Rust deriva
   *    shared_secret via ECDH (mio SecretKey + loro PublicKey), salva pairing
   *    in sync_pairings, ritorna PairingResult.
   * 2. Aggiunge il pairing al SupabaseYjsProvider (subscribe al canale
   *    cifrato room_name).
   * 3. Connette Iroh al responder.
   * 4. Cleanup: DELETE da Supabase pairings WHERE code.
   */
  const handlePairingResponse = useCallback(
    async (code: string, peerKeyResponder: string) => {
      setState((s) => ({ ...s, pairingFlow: "completing", error: null }));
      try {
        // 1. Deriva shared_secret + room_name, salva pairing localmente.
        const result = await api.pairingComplete(code, peerKeyResponder);

        // 2. Aggiungi il pairing al SupabaseYjsProvider (subscribe al nuovo canale).
        const syncManager = getSyncManager();
        const supabaseProvider = syncManager.getProvider("supabase") as
          | SupabaseYjsProvider
          | undefined;
        if (supabaseProvider && "addPairing" in supabaseProvider) {
          // Costruisci l'oggetto Pairing atteso da addPairing.
          const pairing = {
            peerKeyOther: result.peerKeyOther,
            sharedSecret: Array.from(result.sharedSecret),
            roomName: result.roomName,
            displayName: null,
            pairedAt: new Date().toISOString(),
            lastSeen: null,
          };
          await supabaseProvider.addPairing(pairing);
        }

        // 3. Connetti Iroh al responder (per sync p2p diretto low-latency).
        await api.irohConnectByPeerKeyV2(peerKeyResponder);

        // 4. Cleanup Supabase pairings row.
        try {
          const supabase = getSupabaseClient();
          await supabase.from("pairings").delete().eq("code", code);
        } catch (err) {
          console.warn("[SyncView] cleanup Supabase pairings fallito (non blocking):", err);
        }

        setState((s) => ({
          ...s,
          pairingFlow: "idle",
          generatedCode: null,
        }));
        await refresh();
        console.info(`[SyncView] pairing completo con ${peerKeyResponder.slice(0, 16)}... (room=${result.roomName})`);
      } catch (err) {
        setState((s) => ({
          ...s,
          pairingFlow: "error",
          error: `Completamento pairing fallito: ${err instanceof Error ? err.message : String(err)}`,
        }));
        setTimeout(() => setState((s) => ({ ...s, pairingFlow: "idle" })), 4000);
      }
    },
    [refresh]
  );

  /**
   * Responder: entra il codice 8-cifre ricevuto dall'initiator.
   * 1. SELECT da Supabase pairings WHERE code = ? → ottiene peer_key_initiator.
   * 2. Chiama `api.pairingJoin(code, peer_key_initiator)` — Rust deriva
   *    shared_secret via ECDH, salva pairing localmente, ritorna PairingResult.
   * 3. Broadcast su Realtime `pairing-<code>`: { kind: 'response', peer_key_responder: my }.
   * 4. Aggiungi il pairing al SupabaseYjsProvider.
   * 5. Connetti Iroh all'initiator.
   */
  const handleJoinPairing = useCallback(async () => {
    const code = state.joinCodeInput.trim();
    if (!/^\d{8}$/.test(code)) {
      setState((s) => ({
        ...s,
        error: "Codice non valido: deve essere 8 cifre (es. 12345678).",
      }));
      return;
    }
    setState((s) => ({ ...s, pairingFlow: "joining", error: null }));
    try {
      // Assicurati Iroh avviato (peer_key necessaria).
      if (!state.peerKey) {
        await handleStartIroh();
        const id = await api.getSyncIdentity();
        if (!id) throw new Error("Iroh non avviabile");
        state.peerKey = id.peerKey;
        state.identity = id;
      }

      // 1. SELECT da Supabase pairings WHERE code.
      const supabase = getSupabaseClient();
      const { data, error: selErr } = await supabase
        .from("pairings")
        .select("peer_key_initiator")
        .eq("code", code)
        .maybeSingle();
      if (selErr) {
        throw new Error(`Supabase select pairings fallito: ${selErr.message}`);
      }
      if (!data?.peer_key_initiator) {
        throw new Error(
          "Codice non trovato su Supabase. Verifica che sia corretto e non scaduto (5 min)."
        );
      }
      const peerKeyInitiator = data.peer_key_initiator;

      // 2. Deriva shared_secret + room_name via ECDH, salva pairing localmente.
      const result = await api.pairingJoin(code, peerKeyInitiator);

      // 3. Broadcast su Realtime `pairing-<code>` per l'initiator.
      const channel = supabase.channel(`pairing-${code}`, {
        config: { broadcast: { self: false } },
      });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const t = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("pairing channel subscribe timeout"));
          }
        }, 10000);
        channel.subscribe((status: string) => {
          if (settled) return;
          if (status === "SUBSCRIBED") {
            settled = true;
            clearTimeout(t);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            settled = true;
            clearTimeout(t);
            reject(new Error(`pairing channel ${status}`));
          }
        });
      });
      try {
        channel.send({
          type: "broadcast",
          event: "response",
          payload: { peerKeyResponder: state.peerKey },
        });
      } catch (err) {
        console.warn("[SyncView] broadcast response fallito (non blocking):", err);
      }
      // Unsubscribe subito dopo il broadcast — il canale è monouso.
      setTimeout(() => supabase.removeChannel(channel), 1000);

      // 4. Aggiungi pairing al SupabaseYjsProvider.
      const syncManager = getSyncManager();
      const supabaseProvider = syncManager.getProvider("supabase") as
        | SupabaseYjsProvider
        | undefined;
      if (supabaseProvider && "addPairing" in supabaseProvider) {
        const pairing = {
          peerKeyOther: result.peerKeyOther,
          sharedSecret: Array.from(result.sharedSecret),
          roomName: result.roomName,
          displayName: null,
          pairedAt: new Date().toISOString(),
          lastSeen: null,
        };
        await supabaseProvider.addPairing(pairing);
      }

      // 5. Connetti Iroh all'initiator (per sync p2p diretto low-latency).
      await api.irohConnectByPeerKeyV2(peerKeyInitiator);

      setState((s) => ({
        ...s,
        pairingFlow: "idle",
        joinCodeInput: "",
      }));
      await refresh();
      console.info(`[SyncView] pairing join completo con ${peerKeyInitiator.slice(0, 16)}... (room=${result.roomName})`);
    } catch (err) {
      setState((s) => ({
        ...s,
        pairingFlow: "error",
        error: `Join pairing fallito: ${err instanceof Error ? err.message : String(err)}`,
      }));
      setTimeout(() => setState((s) => ({ ...s, pairingFlow: "idle" })), 5000);
    }
  }, [state.joinCodeInput, state.peerKey, handleStartIroh, refresh]);

  /** Cancella un codice pairing in corso (initiator side). */
  const handleCancelPairing = useCallback(
    async (code: string) => {
      try {
        await api.pairingCancel(code);
        const supabase = getSupabaseClient();
        await supabase.from("pairings").delete().eq("code", code);
        await refresh();
      } catch (err) {
        setState((s) => ({
          ...s,
          error: `Cancellazione pairing fallita: ${err instanceof Error ? err.message : String(err)}`,
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

      {/* --- M3a.5 — PAIRING (8-digit code + ECDH) --- */}
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
          Pairing (codice 8-cifre + ECDH)
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
            alignItems: "stretch",
          }}
        >
          {/* Initiator box — generate code */}
          <div
            style={{
              padding: "12px",
              background: "var(--paper-dim)",
              border: "1px solid rgba(43,27,18,0.2)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "12px",
                color: "var(--ink)",
                marginBottom: "8px",
              }}
            >
              Genera codice (tu sei l'initiator)
            </div>
            {state.generatedCode ? (
              <div
                style={{
                  fontFamily: "var(--font-mono, var(--font-body))",
                  fontSize: "52px",
                  fontWeight: "bold",
                  letterSpacing: "0.18em",
                  color: "var(--blue, #2C4A6B)",
                  padding: "20px 8px",
                  textAlign: "center",
                  background: "var(--paper)",
                  border: "3px dashed var(--blue, #2C4A6B)",
                  marginBottom: "12px",
                  lineHeight: 1.1,
                  wordBreak: "keep-all",
                }}
              >
                {state.generatedCode.split("").join(" ")}
              </div>
            ) : null}
            <button
              type="button"
              onClick={handleCreatePairing}
              disabled={
                state.pairingFlow === "creating" ||
                state.pairingFlow === "awaiting_response" ||
                state.pairingFlow === "completing" ||
                !!state.generatedCode  // M3a.5 — un solo codice alla volta
              }
              style={{
                width: "100%",
                fontFamily: "var(--font-display)",
                fontSize: "12px",
                padding: "8px",
                background: "var(--ink)",
                color: "var(--paper)",
                border: "none",
                cursor:
                  state.pairingFlow === "creating" ||
                  state.pairingFlow === "awaiting_response" ||
                  !!state.generatedCode
                    ? "not-allowed"
                    : "pointer",
                opacity: !!state.generatedCode ? 0.4 : 1,
              }}
            >
              {state.pairingFlow === "creating"
                ? "generazione…"
                : state.generatedCode
                ? "in attesa di risposta (annulla sotto per generare nuovo)"
                : "Genera codice di pairing"}
            </button>
            {state.generatedCode && state.pairingFlow === "awaiting_response" && (
              <div
                style={{
                  marginTop: "8px",
                  padding: "8px",
                  background: "rgba(184,134,11,0.08)",
                  border: "1px solid var(--amber, #B8860B)",
                  fontSize: "11px",
                  color: "var(--ink-soft)",
                  fontFamily: "var(--font-body)",
                  lineHeight: 1.5,
                }}
              >
                Codice valido per 5 minuti. Condividilo con il tuo amico
                (voce, SMS, di persona). Aspettando la sua risposta…
                <button
                  type="button"
                  onClick={() => {
                    const code = state.generatedCode;
                    if (code) void handleCancelPairing(code);
                    setState((s) => ({ ...s, generatedCode: null, pairingFlow: "idle" }));
                  }}
                  style={{
                    marginTop: "6px",
                    display: "block",
                    fontFamily: "var(--font-display)",
                    fontSize: "10px",
                    padding: "3px 8px",
                    background: "transparent",
                    color: "var(--red)",
                    border: "1px solid var(--red)",
                    cursor: "pointer",
                  }}
                >
                  annulla
                </button>
              </div>
            )}
          </div>

          {/* Responder box — enter code */}
          <div
            style={{
              padding: "12px",
              background: "var(--paper-dim)",
              border: "1px solid rgba(43,27,18,0.2)",
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "12px",
                color: "var(--ink)",
                marginBottom: "8px",
              }}
            >
              Inserisci codice ricevuto (tu sei il responder)
            </div>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{8}"
              maxLength={8}
              value={state.joinCodeInput}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "").slice(0, 8);
                setState((s) => ({ ...s, joinCodeInput: v, error: null }));
              }}
              placeholder="12345678"
              style={{
                width: "100%",
                fontFamily: "var(--font-mono, var(--font-body))",
                fontSize: "20px",
                fontWeight: "bold",
                letterSpacing: "0.15em",
                textAlign: "center",
                padding: "8px",
                background: "var(--paper)",
                border: "1px solid var(--ink-soft)",
                color: "var(--ink)",
                marginBottom: "8px",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              onClick={handleJoinPairing}
              disabled={
                state.joinCodeInput.length !== 8 ||
                state.pairingFlow === "joining" ||
                state.pairingFlow === "completing"
              }
              style={{
                width: "100%",
                fontFamily: "var(--font-display)",
                fontSize: "12px",
                padding: "8px",
                background: "var(--blue, #2C4A6B)",
                color: "var(--paper)",
                border: "none",
                cursor:
                  state.joinCodeInput.length !== 8 || state.pairingFlow === "joining"
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {state.pairingFlow === "joining" ? "pairing in corso…" : "Paira"}
            </button>
          </div>
        </div>

        {/* Pending pairings list (initiator side, codes in attesa) */}
        {state.pendingPairings.length > 0 && (
          <div
            style={{
              marginTop: "8px",
              padding: "8px 10px",
              background: "rgba(184,134,11,0.06)",
              border: "1px dashed var(--amber, #B8860B)",
              fontSize: "11px",
              color: "var(--ink-soft)",
              fontFamily: "var(--font-body)",
            }}
          >
            <strong>Codici pending ({state.pendingPairings.length}):</strong>{" "}
            {state.pendingPairings.map((p) => p.code).join(", ")}
            <button
              type="button"
              onClick={() => {
                state.pendingPairings.forEach((p) => void handleCancelPairing(p.code));
              }}
              style={{
                marginLeft: "8px",
                fontFamily: "var(--font-display)",
                fontSize: "10px",
                padding: "2px 6px",
                background: "transparent",
                color: "var(--red)",
                border: "1px solid var(--red)",
                cursor: "pointer",
              }}
            >
              cancella tutti
            </button>
          </div>
        )}
      </div>

      {/* --- M3a.4 — PAIRINGS salvati (canali cifrati) --- */}
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
          Pairings cifrati ({state.pairings.length})
        </div>
        {state.pairings.length === 0 ? (
          <div
            style={{
              padding: "12px",
              background: "var(--paper-dim)",
              border: "1px dashed var(--ink-soft)",
              fontSize: "12px",
              color: "var(--ink-soft)",
              fontFamily: "var(--font-body)",
              lineHeight: 1.5,
            }}
          >
            Nessun pairing ancora stabilito. Genera un codice e condividilo con
            il tuo amico per iniziare. Il sync Supabase sarà cifrato end-to-end
            con chiave ECDH derivata dal pairing.
          </div>
        ) : (
          <div
            style={{
              border: "1px solid rgba(43,27,18,0.2)",
              background: "var(--paper-dim)",
            }}
          >
            {state.pairings.map((pairing, idx) => {
              const isOnline = state.connectedPeers.includes(pairing.peerKeyOther);
              return (
                <div
                  key={pairing.peerKeyOther}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    padding: "10px 12px",
                    borderBottom:
                      idx < state.pairings.length - 1
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
                      {pairing.displayName || pairing.peerKeyOther.slice(0, 16) + "…"}
                    </strong>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, var(--font-body))",
                        fontSize: "10px",
                        color: "var(--ink-soft)",
                        wordBreak: "break-all",
                      }}
                    >
                      ({pairing.roomName})
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "11px",
                      color: "var(--ink-soft)",
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    <span>
                      stato:{" "}
                      {isOnline ? (
                        <>
                          <strong style={{ color: "var(--green)" }}>online</strong>
                          {" · sync cifrato AES-GCM + Iroh p2p"}
                        </>
                      ) : (
                        <>
                          <strong>offline</strong>
                          {" · modifiche bufferizzate su Supabase (cifrate)"}
                        </>
                      )}
                    </span>
                    <span>· paired: {pairing.pairedAt?.slice(0, 10)}</span>
                  </div>
                  <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const name = window.prompt(
                          `Display name per ${pairing.peerKeyOther.slice(0, 16)}…:`,
                          pairing.displayName ?? ""
                        );
                        if (name) {
                          try {
                            await api.setPairingDisplayName(pairing.peerKeyOther, name);
                            await refresh();
                          } catch (err) {
                            setState((s) => ({
                              ...s,
                              error: `Salvataggio nome fallito: ${err instanceof Error ? err.message : String(err)}`,
                            }));
                          }
                        }
                      }}
                      style={btnSecondaryStyle}
                    >
                      {pairing.displayName ? "rinomina" : "set nome"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemovePeer(pairing.peerKeyOther)}
                      style={{
                        ...btnSecondaryStyle,
                        color: "var(--red)",
                        borderColor: "var(--red)",
                      }}
                    >
                      rimuovi pairing
                    </button>
                  </div>
                </div>
              );
            })}
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
