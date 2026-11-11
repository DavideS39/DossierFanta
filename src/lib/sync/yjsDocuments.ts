// src/lib/sync/yjsDocuments.ts — Yjs frontend bridge (M3a.3 — B.2 + Deliverable 5).
//
// Singleton Y.Doc condiviso tra tutte le finestre (main + OS native).
// Tiene 5 collection sincronizzate:
//  - players       (Y.Map<player_id, Y.Map<field, value>>)
//  - scouting_notes (Y.Array<Y.Map>)
//  - auction_data   (Y.Map<player_id, Y.Map<field, value>>)
//  - tags           (Y.Map<tag_id, Y.Map<field, value>>) — M4 (v2.6)
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
// M4 (v2.6) — Aggiunta della collection `tags` con lo stesso pattern:
//   Path LOCALE: usePlayersStore.createTag → create_tag commit (created_by='me')
//     → updateYDocTag(tag) → yTags.set(tag.id, ...) SENZA origin
//     → Y.Doc 'update' → provider broadcast
//     → listener yTags.observe: transaction.local === true → SKIP
//
//   Path REMOTO: peer riceve update via sync-update-received
//     → Y.applyUpdate(ydoc, bytes, this)
//     → listener yTags.observe: transaction.local === false → PROCEED
//       → save_tag_from_sync (created_by='sync-live')
//
//   Delete: usePlayersStore.deleteTag → delete_tag SQLite
//     → removeYDocTag(id) → yTags.delete(id) SENZA origin → broadcast
//     → listener remoto: yTags.observe → key removed → save_tag_from_sync? NO,
//       la delete è locale esplicita (Vincolo HARD #1): il peer ricevente
//       DEVE fare delete_tag a sua volta esplicitamente. Non propaghiamo
//       la delete via Yjs (come per i player): il tag resta sul peer
//       remoto finché non lo cancella a sua volta.
//       In futuro si può aggiungere un campo `deleted: true` nel Y.Map del
//       tag per tombstone-based sync, ma per M4 la delete è locale.
//
// Vincolo HARD #13: Sync-live NON sostituisce SQLite come source of truth.
// SQLite rimane authoritativo, Yjs è transport + merge layer.

import * as Y from "yjs";
import { api } from "@/api/tauri";
import type {
  PlayerSyncInput,
  ScoutingNoteSyncInput,
  AuctionDataSyncInput,
  // M4 (v2.6) — tag sync input
  TagSyncInput,
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

/** Y.Map<tag_id, Y.Map<field, value>> — stato CRDT dei tag (M4 v2.6). */
export const yTags = ydoc.getMap<Y.Map<unknown>>("tags");

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
// M4 (v2.6) — Tag bridge functions
// ----------------------------------------------------------------------

/**
 * Applica un update di un tag al Y.Doc locale.
 *
 * Da chiamare DOPO che `create_tag` ha committato su SQLite con
 * `created_by='me'`. La trasmissione ai peer remoti è gestita dal
 * SyncManager + provider (Supabase + Iroh) che ascoltano `ydoc.on('update')`.
 *
 * Anti-loop: il listener `yTags.observe` userà `transaction.local` per
 * distinguere edit locali (skip persistenza) da edit remoti (persisti con
 * `save_tag_from_sync`).
 */
export function updateYDocTag(tag: TagSyncInput): void {
  ydoc.transact(() => {
    let yTag = yTags.get(tag.id);
    if (!yTag) {
      yTag = new Y.Map();
      yTags.set(tag.id, yTag);
    }
    const fields: Array<[string, unknown]> = [
      ["player_id", tag.playerId],
      ["label", tag.label],
      ["color", tag.color],
      ["sync_node_id", tag.syncNodeId],
    ];
    for (const [k, v] of fields) {
      if (v !== undefined && v !== null) {
        yTag.set(k, v);
      }
    }
  });
  // Non broadcast manuale qui — i provider ascoltano ydoc.on('update').
}

/**
 * Rimuove un tag dal Y.Doc locale (delete locale esplicita).
 *
 * Da chiamare DOPO che `delete_tag` ha committato su SQLite.
 *
 * NOTA: la delete NON è un'operazione CRDT natively per Y.Map (Yjs è
 * add-only converge-friendly ma la delete è "last-writer" semantics).
 * Per M4 la delete del tag è considerata locale esplicita (come per i
 * player, Vincolo HARD #1): il peer remoto DEVE fare delete_tag a sua
 * volta. In futuro si può aggiungere un campo `deleted: true` per
 * tombstone-based sync.
 */
export function removeYDocTag(tagId: string): void {
  ydoc.transact(() => {
    yTags.delete(tagId);
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

  // M4 (v2.6) — Listener yTags.observe → persisti tag remoti (skip locali).
  // Anti-loop identico a yPlayers/yAuction: transaction.local === true → skip
  // (la persistenza è già fatta da create_tag con created_by='me').
  // transaction.local === false → save_tag_from_sync (created_by='sync-live').
  const tagsHandler = (event: Y.YMapEvent<Y.Map<unknown>>) => {
    if (event.transaction.local) return; // skip edit locali
    for (const [key, change] of event.keys.entries()) {
      // change.action: 'add' | 'update' | 'delete'
      // Per 'delete': NON persistiamo (la delete è locale esplicita, Vincolo
      // HARD #1: il peer remoto DEVE fare delete_tag a sua volta).
      if (change.action === "delete") continue;
      const yTag = yTags.get(key);
      if (!yTag) continue;
      const input: TagSyncInput = {
        id: key,
        playerId: String(yTag.get("player_id") ?? ""),
        label: String(yTag.get("label") ?? ""),
        color: (yTag.get("color") as string | undefined) ?? null,
        syncNodeId: (yTag.get("sync_node_id") as string | undefined) ?? null,
      };
      if (!input.label) {
        console.warn("[yjsBridge] save_tag_from_sync skip: label vuoto per tag", key);
        continue;
      }
      api.saveTagFromSync(input).catch((err) => {
        console.error("[yjsBridge] saveTagFromSync fallito:", err);
      });
    }
  };
  yTags.observe(tagsHandler);

  // Cleanup function — chiamare su app unmount.
  return () => {
    yPlayers.unobserve(playersHandler);
    yNotes.unobserve(notesHandler);
    yAuction.unobserve(auctionHandler);
    yTags.unobserve(tagsHandler);
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
