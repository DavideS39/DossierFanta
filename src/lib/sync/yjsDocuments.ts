// src/lib/sync/yjsDocuments.ts — Yjs frontend bridge (M3a — B.2).
//
// Singleton Y.Doc condiviso tra tutte le finestre (main + OS native).
// Tiene 3 collection sincronizzate (players, scouting_notes, auction_data)
// + 1 collection per i cursori collaborativi (vedi yjsCursors.ts).
//
// Bridge Rust ↔ Yjs:
//  - Quando il frontend chiama un comando Tauri `save_player` /
//    `save_scouting_note` / `save_auction_data`, DOPO il commit SQLite
//    (eseguito da Rust), applica l'update locale al Y.Doc e lo broadcast
//    ai peer via `iroh_broadcast_update`.
//  - Quando un peer remoto invia un update, il task di background Rust
//    lo riceve via Iroh gossip e lo propaga al Y.Doc locale tramite
//    `yjs_apply_update`. Il listener `observe` del Y.Doc poi chiama
//    `save_*_from_sync` (comando Rust con updated_by='sync-live') per
//    persistere la modifica su SQLite locale, SENZA emit evento
//    `player-updated` (per evitare loop A→B→A).
//
// Vincolo HARD #13: Sync-live NON sostituisce SQLite come source of truth.
// SQLite rimane authoritativo, Yjs è transport + merge layer.

import * as Y from "yjs";
import { api } from "@/api/tauri";
import type {
  PlayerSyncInput,
  ScoutingNoteSyncInput,
  AuctionDataSyncInput,
} from "@/types/sync";

// ----------------------------------------------------------------------
// Singleton Y.Doc condiviso
// ----------------------------------------------------------------------

/** Singleton Y.Doc condiviso tra tutte le finestre dell'app. */
const ydoc = new Y.Doc();

/** Y.Map<player_id, Y.Map<field, value>> — stato CRDT dei players. */
export const yPlayers = ydoc.getMap<Y.Map<unknown>>("players");

/** Y.Array<Y.Map> — stato CRDT delle scouting notes (append-only ottimistico). */
export const yNotes = ydoc.getArray<Y.Map<unknown>>("scouting_notes");

/** Y.Map<player_id, Y.Map<field, value>> — stato CRDT di auction_data. */
export const yAuction = ydoc.getMap<Y.Map<unknown>>("auction_data");

/** Y.Map<user_id, LiveCursor> — stato CRDT dei cursori (vedi yjsCursors.ts). */
export const yCursors = ydoc.getMap<unknown>("cursors");

// ----------------------------------------------------------------------
// Bridge: update locale → Y.Doc → broadcast Iroh
// ----------------------------------------------------------------------

/**
 * Applica un update di un player al Y.Doc e lo broadcast ai peer.
 * Da chiamare DOPO che il comando `update_player` (o `create_player`)
 * ha committato su SQLite.
 */
export async function bridgePlayerUpdate(player: PlayerSyncInput): Promise<void> {
  // M3a.2 (PB4-A fix) — Imposta il flag `isApplyingLocalBridge` PRIMA della
  // transazione Y.Doc. Senza questo, il listener `playersHandler` verrebbe
  // triggerato dalla transazione locale, chiamerebbe `api.savePlayerFromSync`
  // che fa UPDATE con `updated_by='sync-live'`, SOVRASCRIVENDO il `me` appena
  // scritto da `update_player`. Inoltre il trigger `trg_players_updated_at`
  // ricalcolerebbe `updated_at=now()`, invalidando il conflict resolution B.7.
  //
  // Perché usiamo `isApplyingLocalBridge` (NUOVO) e non `isApplyingRemoteUpdate`:
  //   - Il flag `isApplyingRemoteUpdate` viene impostato da `applyRemoteUpdate`
  //     (peer ricevente) e lì DEVE permettere al listener di procedere e
  //     chiamare `save_*_from_sync` (per persistere l'update remoto su SQLite
  //     del peer ricevente). Se usassimo lo stesso flag, il listener uscirebbe
  //     early-return anche sul path ricezione → SQLite del peer B mai aggiornato.
  //   - `isApplyingLocalBridge` è specifico del path LOCALE (utente edita →
  //     update_player committa con `me` → bridge applica Y.Doc) e dice al
  //     listener: "salta, la persistenza SQLite è già stata gestita da
  //     update_player con updated_by='me'".
  isApplyingLocalBridge = true;
  try {
    ydoc.transact(() => {
      // Get o crea la Y.Map interna per il player
      let yPlayer = yPlayers.get(player.id);
      if (!yPlayer) {
        yPlayer = new Y.Map();
        yPlayers.set(player.id, yPlayer);
      }
      // Applica tutti i campi del player (skip null/undefined → merge CRDT)
      const fields: Array<[string, unknown]> = [
        ["db_id", player.dbId],
        ["name", player.name],
        ["team", player.team],
        ["pos_fanta", player.posFanta],
        ["pos_real", player.posReal],
        ["status", player.status],
        ["fascia", player.fascia],
        ["priority", player.priority],
        ["fmil_spesi", player.fmilSpesi],
        ["med", player.med],
        ["medv", player.medv],
        ["fvm", player.fvm],
        ["custom_data", player.customData],
      ];
      for (const [k, v] of fields) {
        if (v !== undefined && v !== null) {
          yPlayer.set(k, v);
        }
      }
    });
  } finally {
    isApplyingLocalBridge = false;
  }

  // Broadcast l'update Yjs ai peer remoti
  await broadcastUpdate();
}

/**
 * Applica una nuova scouting note al Y.Doc (append) e lo broadcast.
 * Da chiamare DOPO che `save_scouting_note` ha committato su SQLite.
 */
export async function bridgeScoutingNoteAppend(
  note: ScoutingNoteSyncInput
): Promise<void> {
  // M3a.2 (PB4-A fix) — Anti-loop flag `isApplyingLocalBridge` attorno alla
  // transazione (vedi commento in bridgePlayerUpdate per i dettagli architetturali).
  // Impedisce al listener `notesHandler` di invocare `saveScoutingNoteFromSync`
  // per le modifiche locali dell'utente.
  isApplyingLocalBridge = true;
  try {
    ydoc.transact(() => {
      const yNote = new Y.Map();
      yNote.set("player_id", note.playerId);
      yNote.set("kind", note.kind);
      yNote.set("label", note.label);
      yNote.set("content", note.content);
      yNote.set("source", note.source);
      yNotes.push([yNote]);
    });
  } finally {
    isApplyingLocalBridge = false;
  }
  await broadcastUpdate();
}

/**
 * Applica un update di auction_data al Y.Doc e lo broadcast.
 * Da chiamare DOPO che `save_auction_data` ha committato su SQLite.
 */
export async function bridgeAuctionDataUpdate(
  auction: AuctionDataSyncInput
): Promise<void> {
  // M3a.2 (PB4-A fix) — Anti-loop flag `isApplyingLocalBridge` attorno alla
  // transazione (vedi commento in bridgePlayerUpdate per i dettagli architetturali).
  // Impedisce al listener `auctionHandler` di invocare `saveAuctionDataFromSync`
  // per le modifiche locali dell'utente.
  isApplyingLocalBridge = true;
  try {
    ydoc.transact(() => {
      let yAuc = yAuction.get(auction.playerId);
      if (!yAuc) {
        yAuc = new Y.Map();
        yAuction.set(auction.playerId, yAuc);
      }
      const fields: Array<[string, unknown]> = [
        ["titolarita", auction.titolarita],
        ["infortuni", auction.infortuni],
        ["quick_note", auction.quickNote],
        ["fmil_max", auction.fmilMax],
        ["assigned_to", auction.assignedTo],
        ["fmil_paid", auction.fmilPaid],
        ["assigned_at", auction.assignedAt],
      ];
      for (const [k, v] of fields) {
        if (v !== undefined && v !== null) {
          yAuc.set(k, v);
        }
      }
    });
  } finally {
    isApplyingLocalBridge = false;
  }
  await broadcastUpdate();
}

// ----------------------------------------------------------------------
// Bridge: update remoto → Y.Doc → persistenza SQLite (via save_*_from_sync)
// ----------------------------------------------------------------------

/**
 * M3a.2 (PB4-A fix) — Flag impostato a `true` durante una transazione Y.Doc
 * causata da un bridge LOCALE (`bridgePlayerUpdate`, `bridgeScoutingNoteAppend`,
 * `bridgeAuctionDataUpdate`). Quando true, i listener `*Handler` escono subito
 * (early-return) senza chiamare `save_*_from_sync` — questo preserva il marker
 * `updated_by='me'` scritto da `update_player` e NON invalida il conflict
 * resolution B.7 (perché il trigger `trg_players_updated_at` non viene
 * ri-fireato da un UPDATE con `updated_by='sync-live'`).
 *
 * Impostato e ripristinato dentro le 3 funzioni bridge con pattern try/finally.
 */
let isApplyingLocalBridge = false;

/**
 * Flag anti-loop (re-entry guard) usato nei listener `*Handler`. Impostato a
 * `true` all'inizio del blocco `try` del listener e ripristinato nel `finally`.
 * In pratica `save_*_from_sync` è un comando Rust (Tauri IPC) che fa un UPDATE
 * SQL — non modifica il Y.Doc, quindi il re-entry è solo difensivo.
 *
 * M3a.2 (PB4-B fix) — `applyRemoteUpdate` imposta questo flag durante
 * `Y.applyUpdate(ydoc, update)`. Il listener NON deve uscire early-return quando
 * questo flag è true (altrimenti il peer ricevente non persisterebbe l'update
 * remoto su SQLite). Per questo motivo il listener usa `isApplyingLocalBridge`
 * per l'early-return, NON `isApplyingRemoteUpdate`.
 */
let isApplyingRemoteUpdate = false;

/**
 * Inizializza i listener Yjs per persistere gli update remoti su SQLite.
 * Da chiamare UNA volta sola al boot dell'app (App.tsx).
 */
export function initYjsBridge(): () => void {
  // Listener yPlayers.observe → quando un peer remoto modifica un player
  // (via applyRemoteUpdate), persisti su SQLite locale via save_player_from_sync
  // (updated_by='sync-live'). Quando invece l'utente locale edita (via
  // bridgePlayerUpdate), il listener esce early-return (isApplyingLocalBridge=true).
  const playersHandler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    // M3a.2 (PB4-A fix) — Skip per edit locali (preserva updated_by='me').
    if (isApplyingLocalBridge) return;
    // Re-entry guard difensivo (save_*_from_sync non modifica Y.Doc, ma in caso
    // di future regressionioni, previene loop infinito).
    if (isApplyingRemoteUpdate) return;
    isApplyingRemoteUpdate = true;
    try {
      for (const key of event.keysChanged) {
        const yPlayer = yPlayers.get(key);
        if (!yPlayer) continue;
        const input: PlayerSyncInput = {
          id: key,
          dbId: String(yPlayer.get("db_id") ?? ""),
          name: String(yPlayer.get("name") ?? ""),
          team: (yPlayer.get("team") as string | undefined) ?? null,
          posFanta: (yPlayer.get("pos_fanta") as string | undefined) ?? null,
          posReal: (yPlayer.get("pos_real") as string | undefined) ?? null,
          status: (yPlayer.get("status") as string | undefined) ?? null,
          fascia: (yPlayer.get("fascia") as string | undefined) ?? null,
          priority: (yPlayer.get("priority") as number | undefined) ?? null,
          fmilSpesi: (yPlayer.get("fmil_spesi") as number | undefined) ?? null,
          med: (yPlayer.get("med") as number | undefined) ?? null,
          medv: (yPlayer.get("medv") as number | undefined) ?? null,
          fvm: (yPlayer.get("fvm") as number | undefined) ?? null,
          customData: (yPlayer.get("custom_data") as string | undefined) ?? null,
          syncNodeId: null,
        };
        api.savePlayerFromSync(input).catch((err) => {
          console.error("[yjsBridge] savePlayerFromSync fallito:", err);
        });
      }
    } finally {
      isApplyingRemoteUpdate = false;
    }
  };
  yPlayers.observe(playersHandler);

  // Listener yNotes.observe → append di scouting note
  const notesHandler = (event: Y.YArrayEvent<Y.Map<unknown>>) => {
    // M3a.2 (PB4-A fix) — Skip per edit locali (preserva updated_by='me').
    if (isApplyingLocalBridge) return;
    if (isApplyingRemoteUpdate) return;
    isApplyingRemoteUpdate = true;
    try {
      for (const block of event.changes.delta) {
        if (block.insert && Array.isArray(block.insert)) {
          for (const yNote of block.insert) {
            if (yNote instanceof Y.Map) {
              const input: ScoutingNoteSyncInput = {
                playerId: String(yNote.get("player_id") ?? ""),
                kind: String(yNote.get("kind") ?? "note") as
                  | "data"
                  | "link"
                  | "note",
                label: (yNote.get("label") as string | undefined) ?? null,
                content: (yNote.get("content") as string | undefined) ?? null,
                source: (yNote.get("source") as string | undefined) ?? null,
                syncNodeId: null,
              };
              api.saveScoutingNoteFromSync(input).catch((err) => {
                console.error("[yjsBridge] saveScoutingNoteFromSync fallito:", err);
              });
            }
          }
        }
      }
    } finally {
      isApplyingRemoteUpdate = false;
    }
  };
  yNotes.observe(notesHandler);

  // Listener yAuction.observe → update di auction_data
  const auctionHandler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    // M3a.2 (PB4-A fix) — Skip per edit locali (preserva updated_by='me').
    if (isApplyingLocalBridge) return;
    if (isApplyingRemoteUpdate) return;
    isApplyingRemoteUpdate = true;
    try {
      for (const key of event.keysChanged) {
        const yAuc = yAuction.get(key);
        if (!yAuc) continue;
        const input: AuctionDataSyncInput = {
          playerId: key,
          titolarita: (yAuc.get("titolarita") as number | undefined) ?? null,
          infortuni: (yAuc.get("infortuni") as
            | "nessuno"
            | "lieve"
            | "grave"
            | undefined) ?? null,
          quickNote: (yAuc.get("quick_note") as string | undefined) ?? null,
          fmilMax: (yAuc.get("fmil_max") as number | undefined) ?? null,
          assignedTo: (yAuc.get("assigned_to") as string | undefined) ?? null,
          fmilPaid: (yAuc.get("fmil_paid") as number | undefined) ?? null,
          assignedAt: (yAuc.get("assigned_at") as string | undefined) ?? null,
          syncNodeId: null,
        };
        api.saveAuctionDataFromSync(input).catch((err) => {
          console.error("[yjsBridge] saveAuctionDataFromSync fallito:", err);
        });
      }
    } finally {
      isApplyingRemoteUpdate = false;
    }
  };
  yAuction.observe(auctionHandler);

  // Ritorna cleanup function
  return () => {
    yPlayers.unobserve(playersHandler);
    yNotes.unobserve(notesHandler);
    yAuction.unobserve(auctionHandler);
  };
}

// ----------------------------------------------------------------------
// Helper: broadcast Y.Doc update a peer remoti via Iroh
// ----------------------------------------------------------------------

/**
 * Estrae l'update Yjs corrente (delta dallo stato al momento della chiamata)
 * e lo broadcast via Iroh gossip protocol. Se 0 peer connessi, è no-op.
 */
async function broadcastUpdate(): Promise<void> {
  try {
    const update = Y.encodeStateAsUpdate(ydoc);
    await api.irohBroadcastUpdate(new Uint8Array(update));
  } catch (err) {
    console.debug("[yjsBridge] broadcastUpdate skip (Iroh non avviato?):", err);
  }
}

/**
 * Applica un update Yjs ricevuto da Iroh (path frontend) al Y.Doc locale.
 *
 * M3a.2 (PB4-B fix) — Questa funzione è ora il punto di ingresso PRODUCTION
 * per gli update ricevuti via gossip (Iroh) o via WebSocket (LAN-only).
 * Il listener registrato in `SyncView.tsx` ascolta l'evento Tauri
 * `sync-update-received` emesso dal subscribe loop di `iroh_start_node`
 * (sync.rs) o da `handle_peer` (sync_lan.rs) e chiama questa funzione.
 *
 * Flusso:
 *  1. Peer A edita un player → `update_player` SQLite commit (updated_by='me')
 *     → `bridgePlayerUpdate` applica al Y.Doc di A + broadcast Iroh.
 *  2. Peer B riceve i bytes via gossip/QUIC → subscribe loop Rust chiama
 *     `yjs_apply_update` (applica al Doc yrs Rust) + emette `sync-update-received`
 *     con i bytes nel payload.
 *  3. Il listener frontend di B su `sync-update-received` chiama
 *     `applyRemoteUpdate(bytes)` → `Y.applyUpdate(ydoc, bytes)` → applica al
 *     Y.Doc di B → triggera `playersHandler` (listener `yPlayers.observe`).
 *  4. `playersHandler` vede `isApplyingLocalBridge=false` (NON siamo in un
 *     bridge locale di B, ma in un apply remoto) → procede → chiama
 *     `api.savePlayerFromSync(input)` → SQLite di B aggiornato con
 *     `updated_by='sync-live'`. ✓ peer B vede la modifica.
 *
 * Anti-loop A→B→A: il listener di B, persistendo con `save_player_from_sync`,
 * NON chiama `bridgePlayerUpdate` (il comando Tauri `save_player_from_sync`
 * è un UPDATE SQL diretto, NON ritorna via `bridgePlayerUpdate`). Quindi B
 * non ritrasmette l'update ad A. (A aveva già l'update — CRDT idempotente.)
 *
 * Il flag `isApplyingRemoteUpdate` è impostato durante `Y.applyUpdate` per
 * coerenza con il pattern re-entry guard dei listener. Il listener NON usa
 * questo flag per l'early-return (usa `isApplyingLocalBridge`) — quindi il
 * listener procede correttamente per gli update remoti.
 */
export function applyRemoteUpdate(update: Uint8Array): void {
  isApplyingRemoteUpdate = true;
  try {
    Y.applyUpdate(ydoc, update);
  } finally {
    isApplyingRemoteUpdate = false;
  }
}

/**
 * Esegue il sync iniziale con un peer appena connesso:
 *  1. Chiama yjs_get_state_vector() lato Rust (state vector del peer remoto)
 *  2. Calcola il diff tra il nostro stato e il suo state vector
 *  3. Invia il diff al peer via iroh_broadcast_update
 *
 * Per DB con 500 giocatori, ~2-5 secondi (yrs encode_diff_v1 è ottimizzato).
 */
export async function initialSync(): Promise<void> {
  try {
    const localSv = Y.encodeStateVector(ydoc);
    await api.irohBroadcastUpdate(new Uint8Array(localSv));
  } catch (err) {
    console.warn("[yjsBridge] initialSync fallito:", err);
  }
}

export { ydoc };
