// src/lib/sync/yjsDocuments.ts — Yjs frontend bridge (M3a.3 — B.2 + Deliverable 5).
//
// Singleton Y.Doc condiviso tra tutte le finestre (main + OS native).
// Tiene 4 collection sincronizzate:
//  - players       (Y.Map<player_id, Y.Map<field, value>>)
//  - scouting_notes (Y.Array<Y.Map>)
//  - auction_data   (Y.Map<player_id, Y.Map<field, value>>)
//  - cursors        (Y.Map<user_id, LiveCursor> — vedi yjsCursors.ts)
//
// M3a.3 (Deliverable 5 — PB4-A risolto architetturalmente):
//  - I bridge manuali (`bridgePlayerUpdate`, `bridgeScoutingNoteAppend`,
//    `bridgeAuctionDataUpdate`, `broadcastUpdate`) sono RIMOSSI.
//  - I flag manuali `isApplyingLocalBridge` e `isApplyingRemoteUpdate` sono
//    RIMOSSI. L'anti-loop è gestito dal parametro `origin` di Yjs, nativo
//    della libreria:
//
//      Path LOCALE (utente edita):
//        usePlayersStore.updatePlayer → SQLite commit (updated_by='me')
//          → updateYDocPlayer(player) → yPlayers.set(...) SENZA origin
//          → Y.Doc emette 'update' con origin=undefined
//          → SupabaseYjsProvider / IrohYjsProvider: broadcast (origin !== this)
//          → listener yPlayers.observe: transaction.local === true → SKIP
//            (non persistere su SQLite, lo ha già fatto update_player con
//            updated_by='me')
//
//      Path REMOTO (peer riceve update via gossip o Supabase Realtime):
//        listener sync-update-received → Y.applyUpdate(ydoc, bytes, this)
//          → Y.Doc emette 'update' con origin=this (il provider stesso)
//          → provider: origin === this → SKIP broadcast (anti-loop nativo)
//          → listener yPlayers.observe: transaction.local === false → PROCEED
//            → save_player_from_sync (updated_by='sync-live')
//
//  - `transaction.local` è true per modifiche locali (transact senza remote
//    origin), false per modifiche remote (applicate via Y.applyUpdate con
//    origin esterno). Questo è l'anti-loop nativo di Yjs — molto più robusto
//    del flag manuale.
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
// M3a.3 (Deliverable 5) — API di bridge SEMPLIFICATE
//
// I vecchi `bridgePlayerUpdate` / `bridgeScoutingNoteAppend` /
// `bridgeAuctionDataUpdate` facevano il broadcast manuale + gestione flag.
// Ora non servono più: il SyncManager + i provider registrano
// `ydoc.on('update')` che fa il broadcast nativo. Queste funzioni fanno
// SOLO l'apply locale al Y.Doc (la persistenza SQLite è già fatta da
// `update_player` con updated_by='me' prima della chiamata).
//
// I listener `yPlayers.observe` usano `transaction.local` per distinguere
// edit locali (skip) da edit remoti (persisti con 'sync-live').
// ----------------------------------------------------------------------

/**
 * Applica un update di un player al Y.Doc locale.
 *
 * Da chiamare DOPO che il comando `update_player` (o `create_player`) ha
 * committato su SQLite con `updated_by='me'`. La trasmissione ai peer remoti
 * è gestita dal SyncManager + provider (SupabaseYjsProvider + IrohYjsProvider)
 * che ascoltano `ydoc.on('update')` e lo broadcastano.
 *
 * M3a.3 (Deliverable 5) — Rimosso il flag `isApplyingLocalBridge`: il
 * listener `yPlayers.observe` usa `transaction.local` (Yjs nativo) per
// distinguere edit locali (skip persistenza) da edit remoti (persisti).
 */
export function updateYDocPlayer(player: PlayerSyncInput): void {
  ydoc.transact(() => {
    let yPlayer = yPlayers.get(player.id);
    if (!yPlayer) {
      yPlayer = new Y.Map();
      yPlayers.set(player.id, yPlayer);
    }
    // Applica tutti i campi del player (skip null/undefined → merge CRDT).
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
  // Non broadcast manuale qui — i provider ascoltano ydoc.on('update').
}

/**
 * Applica una nuova scouting note al Y.Doc (append-only).
 *
 * Da chiamare DOPO che `save_scouting_note` ha committato su SQLite.
 */
export function appendYDocScoutingNote(note: ScoutingNoteSyncInput): void {
  ydoc.transact(() => {
    const yNote = new Y.Map();
    yNote.set("player_id", note.playerId);
    yNote.set("kind", note.kind);
    yNote.set("label", note.label);
    yNote.set("content", note.content);
    yNote.set("source", note.source);
    yNotes.push([yNote]);
  });
}

/**
 * Applica un update di auction_data al Y.Doc.
 *
 * Da chiamare DOPO che `save_auction_data` ha committato su SQLite.
 */
export function updateYDocAuctionData(auction: AuctionDataSyncInput): void {
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
}

// ----------------------------------------------------------------------
// Listener Yjs → SQLite (per edit REMOTI)
// ----------------------------------------------------------------------

/**
 * Inizializza i listener Yjs per persistere gli update remoti su SQLite.
 *
 * Da chiamare UNA volta sola al boot dell'app (App.tsx). I listener usano
 * `transaction.local` per distinguere:
 *   - transaction.local === true → edit LOCALE (utente ha editato, persistenza
 *     già fatta da `update_player` con updated_by='me') → SKIP.
 *   - transaction.local === false → edit REMOTO (applicato via Y.applyUpdate
 *     con origin esterno dal provider ricevente) → PERSISTI con
 *     `save_*_from_sync` (updated_by='sync-live').
 *
 * Anti-loop A→B→A:
 *   1. Peer A edita → update_player commit (me) → updateYDocPlayer → Y.Doc 'update'.
 *   2. Provider A broadcast (Supabase + Iroh).
 *   3. Peer B riceve via sync-update-received → Y.applyUpdate(ydoc, bytes, this).
 *      - Origin = this → provider B NON re-broadcast (anti-loop nativo Yjs).
 *      - transaction.local === false → listener B PERSISTE via save_*_from_sync.
 *   4. save_*_from_sync NON triggera updateYDocPlayer (è un UPDATE SQL diretto,
 *      non un bridge Yjs). Quindi B NON ritrasmette ad A. ✓
 *
 * Cleanup: ritorna una funzione da chiamare su unmount (es. app shutdown).
 */
export function initYjsBridge(): () => void {
  // Listener yPlayers.observe → persisti edit remoti (skip locali).
  const playersHandler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    // M3a.3 (Deliverable 5) — Usa `transaction.local` nativo Yjs.
    // - true = edit locale (Y.Doc.transact senza origin esterno)
    // - false = edit remoto (Y.applyUpdate con origin = provider)
    if (event.transaction.local) return; // skip edit locali

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
  };
  yPlayers.observe(playersHandler);

  // Listener yNotes.observe → append di scouting note (solo remote).
  const notesHandler = (event: Y.YArrayEvent<Y.Map<unknown>>) => {
    if (event.transaction.local) return; // skip edit locali
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
  };
  yNotes.observe(notesHandler);

  // Listener yAuction.observe → update di auction_data (solo remote).
  const auctionHandler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    if (event.transaction.local) return; // skip edit locali
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
  };
  yAuction.observe(auctionHandler);

  // Cleanup function — chiamare su app unmount.
  return () => {
    yPlayers.unobserve(playersHandler);
    yNotes.unobserve(notesHandler);
    yAuction.unobserve(auctionHandler);
  };
}

// ----------------------------------------------------------------------
// Helper: sync iniziale (legacy — tenuto per compat con SyncView vecchio)
// ----------------------------------------------------------------------

/**
 * Esegue il sync iniziale con un peer appena connesso: invia l'intero state
 * Y.Doc locale come update binario via Iroh gossip. Usato dal
 * `IrohYjsProvider` quando riceve `sync-peer-connected`.
 *
 * Per DB con 500 giocatori, ~2-5 secondi (yrs encode_state_v1 è ottimizzato).
 *
 * NOTA: in futuro si può fare uno state vector + diff bidirezionale
 * (`yjs_get_diff` lato Rust) per ridurre bandwidth, ma per M3a.3 l'invio
 * completo è OK (è il primo sync, dopo di che si viaggia su diff incrementali).
 */
export async function initialSync(): Promise<void> {
  try {
    const localState = Y.encodeStateAsUpdate(ydoc);
    await api.irohBroadcastUpdate(new Uint8Array(localState));
  } catch (err) {
    console.warn("[yjsBridge] initialSync fallito:", err);
  }
}

/**
 * Applica un update Yjs ricevuto da un provider (Supabase o Iroh) al Y.Doc locale.
 *
 * M3a.3 (Deliverable 5) — Origin = `this` (il provider stesso) → anti-loop:
 * il listener `ydoc.on('update')` del provider NON re-invia (perché origin === this).
 *
 * Questa funzione è chiamata dal listener `sync-update-received` (registrato
 * dal IrohYjsProvider e dal SupabaseYjsProvider). Non c'è bisogno di un
 * flag manuale `isApplyingRemoteUpdate`: l'origin check è nativo Yjs.
 *
 * @param origin Oggetto usato come `origin` in Y.applyUpdate. Di default
 * usa l'istanza del provider chiamante. Per retrocompatibilità con chiamate
 * esterne che non hanno un provider reference, si può passare `null` (in
 * quel caso l'update è trattato come "locale" da Yjs → il listener NON
 * persiste su SQLite, e i provider NON re-broadcast).
 */
export function applyRemoteUpdate(update: Uint8Array, origin: unknown): void {
  Y.applyUpdate(ydoc, update, origin);
}

export { ydoc };
