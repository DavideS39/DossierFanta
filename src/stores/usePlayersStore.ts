/**
 * usePlayersStore — store Zustand per i giocatori (M3a.3 D5 — PB4-A fix).
 *
 * Flusso completo di una modifica locale:
 *   UI → api.updatePlayer → SQLite commit (updated_by='me')
 *      → updateYDocPlayer(player) → yPlayers.set(...) [transazione LOCALE Yjs]
 *      → Y.Doc emette 'update' event (origin=undefined)
 *      → provider Supabase + Iroh ricevono l'event, broadcast ai peer remoti
 *
 * Anti-loop nativo Yjs (PB4-A fix M3a.3):
 *   Il listener `yPlayers.observe((event, transaction) => ...)` in
 *   `yjsDocuments.ts::initYjsBridge` controlla `transaction.local`:
 *    - true  → update locale (skip save_player_from_sync, updated_by='me' PRESERVATO)
 *    - false → update remoto (procedi, save_player_from_sync, updated_by='sync-live')
 *
 * I vecchi bridge `bridgePlayerUpdate` / `bridgeScoutingNoteAppend` /
 * `bridgeAuctionDataUpdate` in `yjsDocuments.ts` sono RIMOSSI in M3a.3 D5.
 * Le sostituiscono `updateYDocPlayer` / `appendYDocScoutingNote` /
 * `updateYDocAuctionData` — firma identica, senza flag manuale
 * `isApplyingLocalBridge` (l'anti-loop è nativo Yjs via `transaction.local`).
 *
 * Vincolo HARD #13: SQLite rimane source of truth. Yjs è transport + merge.
 */

import { create } from "zustand";
import { api } from "@/api/tauri";
import type {
  CreatePlayerInput,
  ListFilters,
  Player,
  PosFanta,
  SaveScoutingNoteInput,
  UpdatePlayerInput,
} from "@/types/player";
import type {
  AuctionDataSyncInput,
  PlayerSyncInput,
  ScoutingNoteSyncInput,
} from "@/types/sync";
import {
  updateYDocAuctionData,
  updateYDocPlayer,
  appendYDocScoutingNote,
} from "@/lib/sync/yjsDocuments";
import { useDbStore } from "@/stores/useDbStore";

/** M3a.5 — ID del database ListoneSerieA. I player di questo DB NON
 * vengono sincronizzati su Supabase (il listone è auto-fetched da GitHub,
 * non ha bisogno di sync peer-to-peer). */
const LISTONE_DB_ID = "default-listone";

/** True se il db_id è quello del listone — skip del Yjs bridge (no Supabase sync). */
function isListoneDb(dbId: string | null | undefined): boolean {
  return dbId === LISTONE_DB_ID;
}

interface PlayersState {
  // Stato dati
  players: Player[];
  totalCount: number;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;

  // Filtri UI
  search: string;
  roleFilter: PosFanta | null; // null = tutti
  dbFilter: string | null; // null = active DB, "all" = tutti, "<uuid>" = specific DB (M2)
  includeArchive: boolean; // M2: toggle archivio in vista Rosa
  selectedId: string | null;

  // Azioni
  setSearch: (s: string) => void;
  setRoleFilter: (r: PosFanta | null) => void;
  setDbFilter: (d: string | null) => void;
  setIncludeArchive: (v: boolean) => void;
  setSelectedId: (id: string | null) => void;
  refresh: () => Promise<void>;
  createPlayer: (input: CreatePlayerInput) => Promise<Player>;
  updatePlayer: (input: UpdatePlayerInput) => Promise<Player>;
  deletePlayer: (id: string) => Promise<boolean>;
  saveScoutingNote: (input: SaveScoutingNoteInput) => Promise<boolean>;
  saveAuctionData: (
    playerId: string,
    titolarita: number | null,
    infortuni: string | null,
    fmilMax: number | null,
    quickNote: string | null,
  ) => Promise<boolean>;
}

/**
 * Helper M3a.1 (PB4) — converte un Player (ritornato dal backend) in
 * PlayerSyncInput per il bridge Yjs. I campi nullable vengono preservati.
 */
function playerToSyncInput(player: Player): PlayerSyncInput {
  return {
    id: player.id,
    dbId: player.db_id,
    name: player.name,
    team: player.team,
    posFanta: player.pos_fanta,
    posReal: player.pos_real,
    status: player.status,
    fascia: player.fascia,
    priority: player.priority,
    fmilSpesi: player.fmil_spesi,
    med: player.med,
    medv: player.medv,
    fvm: player.fvm,
    customData: null, // Player non ha custom_data nel tipo attuale (lo aggiorna solo il backend)
    syncNodeId: null,
  };
}

function buildFilters(
  search: string,
  role: PosFanta | null,
  dbFilter: string | null,
  includeArchive: boolean,
): ListFilters {
  const f: ListFilters = {};
  if (search.trim()) f.search = search.trim();
  if (role) f.pos_fanta = role;
  if (dbFilter) f.db_id = dbFilter; // "all" o un UUID
  if (includeArchive) f.include_archive = true;
  return f;
}

export const usePlayersStore = create<PlayersState>((set, get) => ({
  players: [],
  totalCount: 0,
  loading: false,
  error: null,
  lastUpdated: null,

  search: "",
  roleFilter: null,
  dbFilter: null,
  includeArchive: false,
  selectedId: null,

  setSearch: (s) => {
    set({ search: s });
    void get().refresh();
  },

  setRoleFilter: (r) => {
    set({ roleFilter: r });
    void get().refresh();
  },

  setDbFilter: (d) => {
    set({ dbFilter: d });
    void get().refresh();
  },

  setIncludeArchive: (v) => {
    set({ includeArchive: v });
    void get().refresh();
  },

  setSelectedId: (id) => set({ selectedId: id }),

  refresh: async () => {
    const { search, roleFilter, dbFilter, includeArchive } = get();
    // M3a.5 — Multi-DB attivo: se più DB sono nel set activeDbIds,
    // usa db_id="all" per mostrare tutti i giocatori di tutti i DB attivi.
    // Se solo 1 DB attivo, usa quello specifico.
    const activeDbIds = useDbStore.getState().activeDbIds;
    const effectiveDbFilter =
      dbFilter ?? (activeDbIds.size > 1 ? "all" : null);
    const filters = buildFilters(search, roleFilter, effectiveDbFilter, includeArchive);
    set({ loading: true, error: null });
    try {
      const [players, count] = await Promise.all([
        api.listPlayers(filters),
        api.countPlayers(filters),
      ]);
      set({
        players,
        totalCount: count,
        loading: false,
        lastUpdated: new Date().toISOString(),
        error: null,
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  createPlayer: async (input) => {
    const player = await api.createPlayer(input);
    // M3a.5 — Skip Yjs bridge per il DB listone (non sincronizzare su Supabase).
    if (!isListoneDb(player.db_id)) {
      try {
        await updateYDocPlayer(playerToSyncInput(player));
      } catch (err) {
        console.warn("[sync] updateYDocPlayer (create) skip:", err);
      }
    }
    await get().refresh();
    return player;
  },

  updatePlayer: async (input) => {
    const player = await api.updatePlayer(input);
    // M3a.5 — Skip Yjs bridge per il DB listone (non sincronizzare su Supabase).
    if (!isListoneDb(player.db_id)) {
      try {
        await updateYDocPlayer(playerToSyncInput(player));
      } catch (err) {
        console.warn("[sync] updateYDocPlayer (update) skip:", err);
      }
    }
    await get().refresh();
    return player;
  },

  deletePlayer: async (id) => {
    const ok = await api.deletePlayer(id);
    if (get().selectedId === id) set({ selectedId: null });
    // M3a.1 — Non propaghiamo il delete via Yjs: il player viene rimosso
    // localmente ma non abbiamo un'operazione Yjs "delete player" (Yjs è
    // CRDT add-only per Y.Map; la cancellazione è locale esplicita con
    // doppio consenso — Vincolo HARD #1). I peer remoti continueranno a
    // vedere il player finché non lo cancelleranno a loro volta.
    await get().refresh();
    return ok;
  },

  saveScoutingNote: async (input) => {
    const ok = await api.saveScoutingNote(input);
    if (ok) {
      // M3a.1 (PB4) — Append sul Y.Array yNotes + broadcast.
      // Costruisce lo ScoutingNoteSyncInput dal payload salvato.
      const syncInput: ScoutingNoteSyncInput = {
        playerId: input.player_id,
        kind: input.kind,
        label: input.label ?? null,
        content: input.content ?? null,
        source: input.source ?? null,
        syncNodeId: null,
      };
      // M3a.5 — Skip Yjs bridge se il player appartiene al DB listone.
      const player = get().players.find((p) => p.id === input.player_id);
      if (!player || !isListoneDb(player.db_id)) {
        try {
          await appendYDocScoutingNote(syncInput);
        } catch (err) {
          console.warn("[sync] appendYDocScoutingNote skip:", err);
        }
      }
    }
    await get().refresh();
    return ok;
  },

  saveAuctionData: async (
    playerId,
    titolarita,
    infortuni,
    fmilMax,
    quickNote,
  ) => {
    const ok = await api.saveAuctionData(
      playerId,
      titolarita,
      infortuni,
      fmilMax,
      quickNote,
    );
    if (ok) {
      // M3a.1 (PB4) — Update della Y.Map yAuction per questo playerId.
      const syncInput: AuctionDataSyncInput = {
        playerId,
        titolarita: titolarita ?? null,
        infortuni: (infortuni as AuctionDataSyncInput["infortuni"]) ?? null,
        quickNote: quickNote ?? null,
        fmilMax: fmilMax ?? null,
        assignedTo: null, // saveAuctionData NON tocca assigned_to; lo fa assign_player
        fmilPaid: null,
        assignedAt: null,
        syncNodeId: null,
      };
      // M3a.5 — Skip Yjs bridge se il player appartiene al DB listone.
      const player = get().players.find((p) => p.id === playerId);
      if (!player || !isListoneDb(player.db_id)) {
        try {
          await updateYDocAuctionData(syncInput);
        } catch (err) {
          console.warn("[sync] updateYDocAuctionData skip:", err);
        }
      }
    }
    await get().refresh();
    return ok;
  },
}));
