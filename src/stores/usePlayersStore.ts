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
  // M4 (v2.6)
  Status,
  SortBy,
  SortDir,
  Tag,
  Filter,
  TagLabelCount,
} from "@/types/player";
import type {
  AuctionDataSyncInput,
  PlayerSyncInput,
  ScoutingNoteSyncInput,
  // M4 (v2.6) — tag sync input
  TagSyncInput,
} from "@/types/sync";
import {
  updateYDocAuctionData,
  updateYDocPlayer,
  appendYDocScoutingNote,
  // M4 (v2.6) — tag bridge Yjs
  updateYDocTag,
  removeYDocTag,
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

  // M4 (v2.6) — filtri + sorting + tag
  statusFilter: Status | null; // null = tutti (Totali/Scoutato/Da fare)
  activeTagFilters: string[]; // lista di label di tag selezionate (AND logico)
  sortBy: SortBy | null; // null = default (priority DESC, name ASC)
  sortDir: SortDir | null; // null = default per il campo (vedi Rust build_sort_clause)

  // M4 — Dati tag (per rendering sulle card)
  /** Mappa player_id → tag del player. Caricata da listTags() al boot. */
  tagsByPlayer: Record<string, Tag[]>;
  /** Tutte le label con conteggio (per filter bar). Caricato da listAllTagLabels. */
  tagLabels: TagLabelCount[];
  /** Filtri salvati con nome. Caricati da listFilters. */
  savedFilters: Filter[];

  // Azioni base (M1/M2/M3a)
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

  // M4 — Azioni filtri + sorting + tag
  setStatusFilter: (s: Status | null) => void;
  toggleTagFilter: (label: string) => void;
  setSort: (by: SortBy | null, dir: SortDir | null) => void;
  resetFilters: () => void;

  loadAllTags: () => Promise<void>;
  loadTagsForPlayer: (playerId: string) => Promise<void>;
  loadTagsForPlayers: (playerIds: string[]) => Promise<void>;
  createTag: (playerId: string, label: string) => Promise<Tag>;
  deleteTag: (id: string, playerId: string) => Promise<boolean>;
  refreshTagLabels: () => Promise<void>;

  loadSavedFilters: () => Promise<void>;
  saveCurrentFilters: (name: string) => Promise<Filter>;
  applySavedFilter: (id: string) => Promise<void>;
  deleteSavedFilter: (id: string) => Promise<boolean>;
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
  status: Status | null,
  activeTags: string[],
  sortBy: SortBy | null,
  sortDir: SortDir | null,
): ListFilters {
  const f: ListFilters = {};
  if (search.trim()) f.search = search.trim();
  if (role) f.pos_fanta = role;
  if (dbFilter) f.db_id = dbFilter; // "all" o un UUID
  if (includeArchive) f.include_archive = true;
  // M4 — status filter + tag filter + sort
  if (status) f.status = status;
  if (activeTags.length > 0) f.tags = activeTags;
  if (sortBy) f.sort_by = sortBy;
  if (sortDir) f.sort_dir = sortDir;
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

  // M4 (v2.6) — filtri + sorting + tag state
  statusFilter: null,
  activeTagFilters: [],
  sortBy: null,
  sortDir: null,
  tagsByPlayer: {},
  tagLabels: [],
  savedFilters: [],

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

  // M4 — filtri + sorting
  setStatusFilter: (s) => {
    set({ statusFilter: s });
    void get().refresh();
  },

  toggleTagFilter: (label) => {
    const cur = get().activeTagFilters;
    const next = cur.includes(label)
      ? cur.filter((t) => t !== label)
      : [...cur, label];
    set({ activeTagFilters: next });
    void get().refresh();
  },

  setSort: (by, dir) => {
    set({ sortBy: by, sortDir: dir });
    void get().refresh();
  },

  resetFilters: () => {
    set({
      search: "",
      roleFilter: null,
      statusFilter: null,
      activeTagFilters: [],
      sortBy: null,
      sortDir: null,
      // NON resettiamo dbFilter né includeArchive: sono impostazioni
      // di vista (quale DB guardare), non filtri effimeri.
    });
    void get().refresh();
  },

  refresh: async () => {
    const { search, roleFilter, dbFilter, includeArchive, statusFilter, activeTagFilters, sortBy, sortDir } = get();
    // M3a.5 — Multi-DB attivo: se più DB sono nel set activeDbIds,
    // usa db_id="all" per mostrare tutti i giocatori di tutti i DB attivi.
    // Se solo 1 DB attivo, usa quello specifico.
    const activeDbIds = useDbStore.getState().activeDbIds;
    const effectiveDbFilter =
      dbFilter ?? (activeDbIds.size > 1 ? "all" : null);
    const filters = buildFilters(
      search,
      roleFilter,
      effectiveDbFilter,
      includeArchive,
      statusFilter,
      activeTagFilters,
      sortBy,
      sortDir,
    );
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
      // M4 — Background-load dei tag dei player visibili (per il rendering
      // delle TagStamp sulle card). Non blocca il render: i tag arrivano
      // appena pronti.
      void get().loadTagsForPlayers(players.map((p) => p.id));
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
    // M4 — Pulisci i tag del player dallo state locale (il DB fa cascade).
    const tagsByPlayer = { ...get().tagsByPlayer };
    delete tagsByPlayer[id];
    set({ tagsByPlayer });
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

  // ----------------------------------------------------------------------
  // M4 — Tag actions
  // ----------------------------------------------------------------------

  loadAllTags: async () => {
    try {
      const allTags = await api.listTags(null);
      // Ricostruisce tagsByPlayer da allTags.
      const map: Record<string, Tag[]> = {};
      for (const t of allTags) {
        if (!map[t.player_id]) map[t.player_id] = [];
        map[t.player_id].push(t);
      }
      set({ tagsByPlayer: map });
    } catch (e) {
      console.warn("[M4] loadAllTags failed:", e);
    }
  },

  loadTagsForPlayer: async (playerId) => {
    try {
      const tags = await api.listTags(playerId);
      set((s) => ({
        tagsByPlayer: { ...s.tagsByPlayer, [playerId]: tags },
      }));
    } catch (e) {
      console.warn(`[M4] loadTagsForPlayer(${playerId}) failed:`, e);
    }
  },

  loadTagsForPlayers: async (playerIds) => {
    if (playerIds.length === 0) return;
    // Batch load: fetch all tags, then filter per player. Più efficiente di
    // N round-trip quando la lista player è lunga.
    try {
      const allTags = await api.listTags(null);
      const map: Record<string, Tag[]> = {};
      for (const t of allTags) {
        if (!map[t.player_id]) map[t.player_id] = [];
        map[t.player_id].push(t);
      }
      // Merge con tag già caricati di player NON nella lista corrente
      // (es. player aperti in finestre WM).
      set((s) => {
        const merged = { ...s.tagsByPlayer };
        // Per i player nella lista, sovrascrivi con i dati freschi.
        for (const pid of playerIds) {
          merged[pid] = map[pid] ?? [];
        }
        return { tagsByPlayer: merged };
      });
    } catch (e) {
      console.warn("[M4] loadTagsForPlayers failed:", e);
    }
  },

  createTag: async (playerId, label) => {
    const tag = await api.createTag(playerId, label);
    // Aggiorna state locale
    set((s) => ({
      tagsByPlayer: {
        ...s.tagsByPlayer,
        [playerId]: [...(s.tagsByPlayer[playerId] ?? []), tag],
      },
    }));
    // Refresh tag labels (la label nuova potrebbe essere inedita → +1 count).
    void get().refreshTagLabels();
    // M4 — Yjs bridge: propaga il tag ai peer remoti. Skip su DB listone.
    const player = get().players.find((p) => p.id === playerId);
    if (!player || !isListoneDb(player.db_id)) {
      try {
        const syncInput: TagSyncInput = {
          id: tag.id,
          playerId,
          label: tag.label,
          color: tag.color,
          syncNodeId: null,
        };
        updateYDocTag(syncInput);
      } catch (err) {
        console.warn("[sync] updateYDocTag (create) skip:", err);
      }
    }
    return tag;
  },

  deleteTag: async (id, playerId) => {
    const ok = await api.deleteTag(id);
    if (ok) {
      // Rimuovi dallo state locale
      set((s) => ({
        tagsByPlayer: {
          ...s.tagsByPlayer,
          [playerId]: (s.tagsByPlayer[playerId] ?? []).filter((t) => t.id !== id),
        },
      }));
      void get().refreshTagLabels();
      // M4 — Yjs bridge: propaga la delete ai peer remoti.
      const player = get().players.find((p) => p.id === playerId);
      if (!player || !isListoneDb(player.db_id)) {
        try {
          removeYDocTag(id);
        } catch (err) {
          console.warn("[sync] removeYDocTag skip:", err);
        }
      }
    }
    return ok;
  },

  refreshTagLabels: async () => {
    try {
      const labels = await api.listAllTagLabels();
      set({ tagLabels: labels });
    } catch (e) {
      console.warn("[M4] refreshTagLabels failed:", e);
    }
  },

  // ----------------------------------------------------------------------
  // M4 — Saved filters actions
  // ----------------------------------------------------------------------

  loadSavedFilters: async () => {
    try {
      const filters = await api.listFilters();
      set({ savedFilters: filters });
    } catch (e) {
      console.warn("[M4] loadSavedFilters failed:", e);
    }
  },

  saveCurrentFilters: async (name) => {
    const { search, roleFilter, statusFilter, activeTagFilters, sortBy, sortDir } = get();
    const criteria: Record<string, unknown> = {};
    if (search.trim()) criteria.search = search.trim();
    if (roleFilter) criteria.role = roleFilter;
    if (statusFilter) criteria.status = statusFilter;
    if (activeTagFilters.length > 0) criteria.tags = activeTagFilters;
    if (sortBy) criteria.sort_by = sortBy;
    if (sortDir) criteria.sort_dir = sortDir;
    const filter = await api.saveFilter(name, JSON.stringify(criteria));
    await get().loadSavedFilters();
    return filter;
  },

  applySavedFilter: async (id) => {
    try {
      const ids = await api.applyFilter(id);
      // Per semplicità NON passiamo i player_id al backend per fare il
      // filtering; invece deserializziamo criteria_json e applichiamo i
      // filtri allo store. Questo mantiene il path di filtering unificato
      // (Rust list_players con sort_by/sort_dir/tags).
      const filter = get().savedFilters.find((f) => f.id === id);
      if (!filter) return;
      const criteria = JSON.parse(filter.criteria_json) as Record<string, unknown>;
      get().resetFilters();
      if (typeof criteria.search === "string") get().setSearch(criteria.search);
      if (typeof criteria.role === "string") {
        get().setRoleFilter(criteria.role as PosFanta);
      }
      if (typeof criteria.status === "string") {
        get().setStatusFilter(criteria.status as Status);
      }
      if (typeof criteria.sort_by === "string") {
        get().setSort(
          criteria.sort_by as SortBy,
          (typeof criteria.sort_dir === "string" ? criteria.sort_dir : "desc") as SortDir,
        );
      }
      if (Array.isArray(criteria.tags)) {
        for (const t of criteria.tags) {
          if (typeof t === "string") get().toggleTagFilter(t);
        }
      }
      // ids è ritornato per uso futuro (es. spotlight sui player_id).
      void ids;
    } catch (e) {
      console.error("[M4] applySavedFilter failed:", e);
      throw e;
    }
  },

  deleteSavedFilter: async (id) => {
    const ok = await api.deleteFilter(id);
    if (ok) {
      await get().loadSavedFilters();
    }
    return ok;
  },
}));
