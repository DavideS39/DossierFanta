/**
 * mock.ts — backend in-memory per l'ANTEPRIMA WEB (v2.3.2).
 *
 * Attivo SOLO fuori da Tauri (browser): `npm run dev` → l'app si usa con
 * dati dimostrativi senza binario desktop. Dentro il binario Tauri il gate
 * in `tauri.ts` usa esclusivamente i comandi Rust: zero rischio production.
 *
 * Implementa la stessa superficie di `api` (tauri.ts) con un DB finto:
 * 2 DB logici (mio.db personale attivo + marco.db condiviso), ~24 giocatori
 * con stati/fasce/priorità realistici, 1 archiviato, CRUD + status toggle +
 * auto-toggle nota scouting (Cap.8). Le finestre OS native NON esistono in
 * browser: openPlayerWindow lancia (RosaView mostra un toast prima).
 */

import type {
  ArchivedPlayer,
  AuctionData,
  AutoFetchStatus,
  CreatePlayerInput,
  DatabaseMeta,
  DbInfo,
  ImportPreview,
  ImportSummary,
  ListFilters,
  ListoneData,
  ListoneVersionInfo,
  Player,
  SaveScoutingNoteInput,
  ScoutingNote,
  Status,
  UpdatePlayerInput,
} from "@/types/player";
// M3a.3 — Tipi sync_* mirror Rust (per gli stub mock dei comandi M3a.3)
import type {
  SyncIdentity,
  TrustedPeer,
  SyncUpdateReceivedEvent,
  Pairing,
  PairingCode,
  PairingResult,
  PairingPending,
} from "@/types/sync";

const delay = (ms = 70) => new Promise((r) => setTimeout(r, ms));

let seq = 100;
const nid = () => `mock-${(seq++).toString(16).padStart(4, "0")}`;

// M2.1.1 — Map in-memory per auction_data + scouting_notes (mock browser)
const auctionDataMock = new Map<string, AuctionData>();
const scoutingNotesMock = new Map<string, ScoutingNote[]>();
let noteIdSeq = 1;

const DB_MIO: DatabaseMeta = {
  id: "db-mio",
  name: "mio.db",
  type: "personal",
  owner: "tu",
  created_at: "2026-08-30 10:00:00",
  last_sync: null,
  schema_ver: 2,
};
const DB_MARCO: DatabaseMeta = {
  id: "db-marco",
  name: "marco.db",
  type: "shared",
  owner: "marco",
  created_at: "2026-09-02 18:20:00",
  last_sync: "2026-10-09 21:14:00",
  schema_ver: 2,
};

let databases: DatabaseMeta[] = [DB_MIO, DB_MARCO];
let activeDbId = DB_MIO.id;

function P(p: Partial<Player> & Pick<Player, "name">): Player {
  return {
    id: nid(),
    db_id: DB_MIO.id,
    team: null,
    pos_fanta: null,
    pos_real: null,
    status: "totali",
    fascia: null,
    priority: 0,
    fmil_spesi: null,
    med: null,
    medv: null,
    fvm: null,
    updated_at: "2026-10-08 19:42:11",
    updated_by: "tu",
    ...p,
  };
}

let players: Player[] = [
  P({ name: "Lautaro Martinez", team: "Inter", pos_fanta: "A", pos_real: "A", status: "scoutato", fascia: "Top", priority: 5, fmil_spesi: 78, med: 6.92, medv: 7.41, fvm: 38 }),
  P({ name: "Marcus Thuram", team: "Inter", pos_fanta: "A", pos_real: "A", status: "scoutato", fascia: "Top", priority: 4, fmil_spesi: 52, med: 6.81, medv: 7.22, fvm: 34 }),
  P({ name: "Nicolò Barella", team: "Inter", pos_fanta: "C", pos_real: "C", status: "scoutato", fascia: "Top", priority: 4, fmil_spesi: 48, med: 6.58, medv: 6.94, fvm: 30 }),
  P({ name: "Alessandro Bastoni", team: "Inter", pos_fanta: "D", pos_real: "D", status: "scoutato", fascia: "Semitop", priority: 4, fmil_spesi: 45, med: 6.47, medv: 6.83, fvm: 26 }),
  P({ name: "Yann Sommer", team: "Inter", pos_fanta: "P", pos_real: "P", status: "scoutato", fascia: "Medio", priority: 2, fmil_spesi: 12, med: 6.31, medv: 6.52, fvm: 8 }),
  P({ name: "Dušan Vlahović", team: "Juventus", pos_fanta: "A", pos_real: "A", status: "da_fare", fascia: "Semitop", priority: 4, fvm: 28 }),
  P({ name: "Rafael Leão", team: "Milan", pos_fanta: "A", pos_real: "A", status: "scoutato", fascia: "Top", priority: 5, fmil_spesi: 65, med: 6.66, medv: 7.08, fvm: 36 }),
  P({ name: "Mike Maignan", team: "Milan", pos_fanta: "P", pos_real: "P", status: "scoutato", fascia: "Semitop", priority: 3, fmil_spesi: 30, med: 6.42, medv: 6.61, fvm: 14 }),
  P({ name: "Theo Hernández", team: "Milan", pos_fanta: "D", pos_real: "D", status: "scoutato", fascia: "Top", priority: 4, fmil_spesi: 55, med: 6.49, medv: 6.9, fvm: 27 }),
  P({ name: "Christian Pulisic", team: "Milan", pos_fanta: "C", pos_real: "A", status: "scoutato", fascia: "Semitop", priority: 3, fmil_spesi: 38, med: 6.44, medv: 6.85, fvm: 22 }),
  P({ name: "Khvicha Kvaratskhelia", team: "Napoli", pos_fanta: "A", pos_real: "A", status: "scoutato", fascia: "Top", priority: 5, fmil_spesi: 60, med: 6.78, medv: 7.3, fvm: 35 }),
  P({ name: "Victor Osimhen", team: "Napoli", pos_fanta: "A", pos_real: "A", status: "da_fare", fascia: "Top", priority: 4, fvm: 40 }),
  P({ name: "Stanislav Lobotka", team: "Napoli", pos_fanta: "C", pos_real: "C", status: "scoutato", fascia: "Medio", priority: 2, fmil_spesi: 25, med: 6.52, medv: 6.71, fvm: 18 }),
  P({ name: "Paulo Dybala", team: "Roma", pos_fanta: "A", pos_real: "A", status: "da_fare", fascia: "Semitop", priority: 4, fvm: 26 }),
  P({ name: "Lorenzo Pellegrini", team: "Roma", pos_fanta: "C", pos_real: "C", status: "da_fare", fascia: "Medio", priority: 2, fvm: 16 }),
  P({ name: "Ademola Lookman", team: "Atalanta", pos_fanta: "A", pos_real: "A", status: "scoutato", fascia: "Semitop", priority: 4, fmil_spesi: 42, med: 6.63, medv: 7.05, fvm: 25 }),
  P({ name: "Teun Koopmeiners", team: "Atalanta", pos_fanta: "C", pos_real: "C", status: "scoutato", fascia: "Semitop", priority: 3, fmil_spesi: 35, med: 6.41, medv: 6.79, fvm: 20 }),
  P({ name: "Riccardo Calafiori", team: "Bologna", pos_fanta: "D", pos_real: "D", status: "scoutato", fascia: "Scommessa", priority: 3, fmil_spesi: 18, med: 6.28, medv: 6.6, fvm: 12 }),
  P({ name: "Joshua Zirkzee", team: "Bologna", pos_fanta: "A", pos_real: "A", status: "da_fare", fascia: "Scommessa", priority: 3, fvm: 15 }),
  P({ name: "Andrea Cambiaso", team: "Juventus", pos_fanta: "D", pos_real: "D", status: "scoutato", fascia: "Medio", priority: 3, fmil_spesi: 20, med: 6.33, medv: 6.64, fvm: 14 }),
  P({ name: "Mattia Perin", team: "Juventus", pos_fanta: "P", pos_real: "P", status: "totali", fascia: "Regolarista", priority: 1, med: 6.05, medv: 6.2, fvm: 6 }),
  P({ name: "Sandro Tonali", team: "Milan", pos_fanta: "C", pos_real: "C", status: "scoutato", fascia: "Semitop", priority: 3, fmil_spesi: 30, med: 6.3, medv: 6.62, fvm: 19, db_id: DB_MARCO.id }),
  P({ name: "Gianluca Scamacca", team: "Atalanta", pos_fanta: "A", pos_real: "A", status: "da_fare", fascia: "Semitop", priority: 4, fvm: 21, db_id: DB_MARCO.id }),
  P({ name: "Mattia Zaccagni", team: "Lazio", pos_fanta: "C", pos_real: "A", status: "da_fare", fascia: "Medio", priority: 2, fvm: 17, db_id: DB_MARCO.id }),
];

let archived: ArchivedPlayer[] = [
  {
    id: nid(),
    db_id: DB_MIO.id,
    name: "Leonardo Pavoletti",
    team: "Cagliari",
    pos_fanta: "A",
    pos_real: "A",
    archived_at: "2026-09-20 03:00:00",
    archived_reason: "non_in_listone",
    last_known_data: { fascia: "Scommessa", priority: 1, med: 6.1, medv: 6.4, fvm: 4 },
  },
];

function applyFilters(list: Player[], f?: ListFilters | null): Player[] {
  if (!f) return list;
  let out = list;
  const dbId = f.db_id ?? activeDbId;
  out = dbId === "all" ? out : out.filter((p) => p.db_id === dbId);
  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.team ?? "").toLowerCase().includes(q),
    );
  }
  if (f.pos_fanta) out = out.filter((p) => p.pos_fanta === f.pos_fanta);
  if (f.status) out = out.filter((p) => p.status === f.status);
  if (f.fascia) out = out.filter((p) => p.fascia === f.fascia);
  return out;
}

export const mockApi = {
  isMock: true as const,

  async initDb() {
    await delay(120);
    return "/mock/mio.db";
  },

  async getDbInfo(): Promise<DbInfo> {
    await delay();
    const active = databases.find((d) => d.id === activeDbId)!;
    return {
      db_path: `/mock/${active.name}`,
      schema_version: 2,
      players_count: players.filter((p) => p.db_id === activeDbId).length,
      archived_count: archived.length,
      default_db_id: DB_MIO.id,
      default_db_name: DB_MIO.name,
      databases_count: databases.length,
      active_db_id: active.id,
      active_db_name: active.name,
    };
  },

  async listDatabases() {
    await delay();
    return [...databases];
  },

  async createDatabase(name: string, type: "personal" | "shared" | "listone" = "personal") {
    await delay();
    const meta: DatabaseMeta = {
      id: nid(),
      name,
      type,
      owner: "tu",
      created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      last_sync: null,
      schema_ver: 2,
    };
    databases = [...databases, meta];
    return meta;
  },

  async deleteDatabase(id: string) {
    await delay();
    if (id === DB_MIO.id) throw new Error("Il DB personale di default non è eliminabile");
    databases = databases.filter((d) => d.id !== id);
    players = players.filter((p) => p.db_id !== id);
    if (activeDbId === id) activeDbId = DB_MIO.id;
    return true;
  },

  async setActiveDatabase(id: string) {
    await delay();
    const meta = databases.find((d) => d.id === id);
    if (!meta) throw new Error(`DB ${id} non trovato`);
    activeDbId = id;
    return meta;
  },

  async getActiveDatabase() {
    await delay();
    return databases.find((d) => d.id === activeDbId)!;
  },

  async listPlayers(filters?: ListFilters | null) {
    await delay();
    return applyFilters(players, filters ?? null).map((p) => ({ ...p }));
  },

  async countPlayers(filters?: ListFilters | null) {
    await delay();
    return applyFilters(players, filters ?? null).length;
  },

  async createPlayer(input: CreatePlayerInput) {
    await delay();
    const p = P({
      name: input.name,
      db_id: input.db_id ?? activeDbId,
      team: input.team,
      pos_fanta: input.pos_fanta,
      pos_real: input.pos_real,
      status: input.status ?? "da_fare",
      fascia: input.fascia,
      priority: input.priority ?? 0,
      fmil_spesi: input.fmil_spesi,
      med: input.med,
      medv: input.medv,
      fvm: input.fvm,
    });
    players = [p, ...players];
    return { ...p };
  },

  async updatePlayer(input: UpdatePlayerInput) {
    await delay();
    const i = players.findIndex((p) => p.id === input.id);
    if (i < 0) throw new Error("Giocatore non trovato");
    const upd: Player = {
      ...players[i],
      name: input.name,
      team: input.team,
      pos_fanta: input.pos_fanta,
      pos_real: input.pos_real,
      fascia: input.fascia,
      priority: input.priority,
      fmil_spesi: input.fmil_spesi,
      med: input.med,
      medv: input.medv,
      fvm: input.fvm,
      updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
    players = players.map((p, j) => (j === i ? upd : p));
    return { ...upd };
  },

  async deletePlayer(id: string) {
    await delay();
    players = players.filter((p) => p.id !== id);
    return true;
  },

  async archivePlayer(id: string, reason = "manuale") {
    await delay();
    const p = players.find((x) => x.id === id);
    if (!p) return false;
    players = players.filter((x) => x.id !== id);
    archived = [
      {
        id: p.id,
        db_id: p.db_id,
        name: p.name,
        team: p.team,
        pos_fanta: p.pos_fanta,
        pos_real: p.pos_real,
        archived_at: new Date().toISOString().replace("T", " ").slice(0, 19),
        archived_reason: reason,
        last_known_data: p,
      },
      ...archived,
    ];
    return true;
  },

  async listArchive(search?: string | null, limit?: number | null) {
    await delay();
    let out = archived;
    if (search) out = out.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
    if (limit) out = out.slice(0, limit);
    return out as unknown[];
  },

  async listArchivedPlayers(search?: string | null, role?: string | null) {
    await delay();
    let out = archived;
    if (search) out = out.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
    if (role) out = out.filter((a) => a.pos_fanta === role);
    return out.map((a) => ({ ...a }));
  },

  async restoreArchivedPlayer(playerId: string) {
    await delay();
    const a = archived.find((x) => x.id === playerId);
    if (!a) return false;
    archived = archived.filter((x) => x.id !== playerId);
    const last = (a.last_known_data ?? {}) as Partial<Player>;
    players = [
      {
        id: a.id,
        db_id: a.db_id,
        name: a.name,
        team: a.team,
        pos_fanta: a.pos_fanta,
        pos_real: a.pos_real,
        status: "totali",
        fascia: last.fascia ?? null,
        priority: last.priority ?? 0,
        fmil_spesi: last.fmil_spesi ?? null,
        med: last.med ?? null,
        medv: last.medv ?? null,
        fvm: last.fvm ?? null,
        updated_at: a.archived_at,
        updated_by: null,
      },
      ...players,
    ];
    return true;
  },

  async importListone(playersJson: string): Promise<ImportSummary> {
    await delay(200);
    const entries = JSON.parse(playersJson) as { name: string; team?: string; fvm?: number }[];
    let created = 0;
    for (const e of entries) {
      if (!players.some((p) => p.name.toLowerCase() === e.name.toLowerCase())) {
        players = [P({ name: e.name, team: e.team ?? null, fvm: e.fvm ?? null, status: "da_fare" }), ...players];
        created++;
      }
    }
    return {
      created,
      updated: 0,
      archived: 0,
      restored: 0,
      errors: 0,
      total_listone: entries.length,
      active_db_id: activeDbId,
      active_db_name: databases.find((d) => d.id === activeDbId)!.name,
      error_messages: [],
    };
  },

  async previewImportListone(playersJson: string): Promise<ImportPreview> {
    await delay(150);
    const entries = JSON.parse(playersJson) as { name: string; team?: string; fvm?: number }[];
    const created = entries
      .filter((e) => !players.some((p) => p.name.toLowerCase() === e.name.toLowerCase()))
      .map((e) => ({ name: e.name, team: e.team ?? null, pos_fanta: null, fvm: e.fvm ?? null }));
    return {
      created,
      archived: [],
      updated: [],
      restored: [],
      total_listone: entries.length,
      active_db_id: activeDbId,
      active_db_name: databases.find((d) => d.id === activeDbId)!.name,
    };
  },

  async setPlayerStatus(playerId: string, newStatus: Status) {
    await delay();
    const i = players.findIndex((p) => p.id === playerId);
    if (i < 0) throw new Error("Giocatore non trovato");
    players = players.map((p, j) => (j === i ? { ...p, status: newStatus } : p));
    return { ...players[i] };
  },

  async saveScoutingNote(input: SaveScoutingNoteInput) {
    await delay();
    // Crea la nota e aggiungi alla Map
    const note: ScoutingNote = {
      id: noteIdSeq++,
      player_id: input.player_id,
      kind: input.kind,
      label: input.label ?? null,
      content: input.content ?? null,
      source: input.source ?? null,
      created_at: new Date().toISOString().replace("T", " ").substring(0, 19),
    };
    const list = scoutingNotesMock.get(input.player_id) ?? [];
    scoutingNotesMock.set(input.player_id, [...list, note]);

    // auto-toggle Cap.8: nota non vuota su "da fare" → "scoutato"
    const content = (input.content ?? "").trim();
    if (content && (input.kind === "note" || input.kind === "data")) {
      players = players.map((p) =>
        p.id === input.player_id && p.status === "da_fare" ? { ...p, status: "scoutato" } : p,
      );
    }
    return true;
  },

  async getPlayer(playerId: string) {
    await delay();
    const p = players.find((x) => x.id === playerId);
    if (!p) throw new Error("Giocatore non trovato");
    return { ...p };
  },

  // ===== M2.1.1 — Cap.9: auction_data + scouting_notes (mock in-memory) =====

  async getAuctionData(playerId: string) {
    await delay();
    return auctionDataMock.get(playerId) ?? null;
  },

  async saveAuctionData(
    playerId: string,
    titolarita: number | null,
    infortuni: string | null,
    fmilMax: number | null,
    quickNote: string | null,
  ) {
    await delay();
    const existing = auctionDataMock.get(playerId) ?? {
      player_id: playerId,
      titolarita: null,
      infortuni: null,
      quick_note: null,
      fmil_max: null,
      assigned_to: null,
      fmil_paid: null,
      assigned_at: null,
    };
    const updated = {
      ...existing,
      titolarita: titolarita ?? existing.titolarita,
      infortuni: infortuni ?? existing.infortuni,
      fmil_max: fmilMax ?? existing.fmil_max,
      quick_note: quickNote ?? existing.quick_note,
    };
    auctionDataMock.set(playerId, updated);
    return true;
  },

  async listScoutingNotes(playerId: string) {
    await delay();
    return scoutingNotesMock.get(playerId) ?? [];
  },

  async assignPlayer(playerId: string, assignedTo: string, fmilPaid: number) {
    await delay();
    const existing = auctionDataMock.get(playerId) ?? {
      player_id: playerId,
      titolarita: null,
      infortuni: null,
      quick_note: null,
      fmil_max: null,
      assigned_to: null,
      fmil_paid: null,
      assigned_at: null,
    };
    auctionDataMock.set(playerId, {
      ...existing,
      assigned_to: assignedTo,
      fmil_paid: fmilPaid,
      assigned_at: new Date().toISOString().replace("T", " ").substring(0, 19),
    });
    return true;
  },

  // Finestre OS native: solo Tauri. In browser RosaView mostra un toast
  // prima di chiamare questo metodo (gate isDesktop).
  async openPlayerWindow(_playerId: string): Promise<boolean> {
    throw new Error("Finestre OS native non disponibili in anteprima web");
  },

  async closePlayerWindow(_playerId: string): Promise<boolean> {
    return false;
  },

  async listOsPlayerWindows(): Promise<string[]> {
    return [];
  },

  // M2.2 — FIX A2 (F12): in anteprima web il backend mock NON emette
  // eventi Tauri (non c'è un backend vero). Ritorniamo una UnlistenFn
  // vuota per rispettare il tipo. Il callback non viene mai chiamato.
  async onPlayerUpdated(_callback: (id: string) => void): Promise<() => void> {
    return () => {
      /* no-op in mock mode */
    };
  },

  // ===== M3 — Auto-fetch listone (mock in-memory per anteprima web) =====
  // Simula le 5 funzioni M3 con dati demo. Niente rete vera in browser:
  // gli sviluppatori possono provare la UI Aggiornamenti senza build Tauri.

  async checkLatestListoneVersion(): Promise<ListoneVersionInfo> {
    await delay(200);
    const today = new Date().toISOString().slice(0, 10);
    return {
      tag: `data-${today}-mocked1234`,
      name: `Listone Serie A ${today} (mock)`,
      published_at: `${today}T01:00:00Z`,
      asset_url: "https://mock.dossierfanta.invalid/releases/latest/players.json",
      asset_size_bytes: 524288,
      has_players_json: true,
    };
  },

  async downloadListone(_assetUrl: string, tag: string): Promise<ListoneData> {
    await delay(400);
    // Genera 500 giocatori mock da 20 squadre per popolare la UI Aggiornamenti
    const teams = [
      "Inter", "Juventus", "Milan", "Napoli", "Roma", "Atalanta", "Bologna",
      "Lazio", "Fiorentina", "Torino", "Monza", "Udinese", "Genoa", "Sassuolo",
      "Verona", "Cagliari", "Lecce", "Empoli", "Frosinone", "Hellas Verona",
    ];
    const firstNames = [
      "Marco", "Lorenzo", "Federico", "Alessandro", "Davide", "Giovanni",
      "Mattia", "Andrea", "Nicolo", "Riccardo", "Tommaso", "Luca", "Edoardo",
      "Francesco", "Antonio", "Stefano", "Simone", "Paolo", "Domenico", "Pietro",
    ];
    const lastNames = [
      "Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo",
      "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca",
      "Costa", "Mancini", "Rizzo", "Lombardi", "Moretti", "Barbieri",
    ];
    const roles = ["P", "D", "C", "A"] as const;
    const entries = Array.from({ length: 25 }, (_, i) => {
      const team = teams[i % teams.length];
      const firstName = firstNames[i % firstNames.length];
      const lastName = lastNames[(i * 3) % lastNames.length];
      const r = roles[i % roles.length];
      return {
        name: `${firstName} ${lastName}`,
        team,
        pos_fanta: r,
        fvm: 8 + ((i * 7) % 35),
      };
    });
    return {
      tag,
      version: new Date().toISOString().slice(0, 10),
      scraped_at: new Date().toISOString(),
      entries,
      from_fallback: false,
    };
  },

  async applyAutoFetch(listoneData: ListoneData): Promise<ImportSummary> {
    await delay(300);
    // Mock:Conta entries che matchano giocatori esistenti nel mock DB
    let created = 0;
    let updated = 0;
    for (const e of listoneData.entries) {
      const existing = players.some((p) => p.name.toLowerCase() === e.name.toLowerCase());
      if (existing) updated++;
      else created++;
    }
    return {
      created,
      updated,
      archived: 0,
      restored: 0,
      errors: 0,
      total_listone: listoneData.entries.length,
      active_db_id: activeDbId,
      active_db_name: databases.find((d) => d.id === activeDbId)!.name,
      error_messages: [],
    };
  },

  async scrapeListoneInline(): Promise<ListoneData> {
    await delay(1500); // simula i 10-15s dello scraper inline
    const today = new Date().toISOString().slice(0, 10);
    // Genera 5 giocatori mock per smoke test (il fallback non dovrebbe mai
    // essere usato in mock mode perché GitHub è sempre "raggiungibile")
    return {
      tag: `fallback-${today}`,
      version: today,
      scraped_at: new Date().toISOString(),
      entries: [
        { name: "Test Fallback 1", team: "Inter", pos_fanta: "A", fvm: 25 },
        { name: "Test Fallback 2", team: "Juventus", pos_fanta: "C", fvm: 18 },
        { name: "Test Fallback 3", team: "Milan", pos_fanta: "D", fvm: 14 },
      ],
      from_fallback: true,
    };
  },

  async getAutofetchStatus(): Promise<AutoFetchStatus> {
    await delay(50);
    return {
      last_applied_tag: "",
      cache_path: "/mock/cache/listone.json",
      update_log: [],
    };
  },

  // M3a.5 — Archiviazione asterisk (stub mock)
  async archiveAsteriskPlayers(): Promise<number> {
    await delay(50);
    return 0;
  },

  // ===== M3a — Stub mock per i comandi sync live (anteprima web dev-only) =====
  // M3a.1 (verifica TS) — Aggiunti stub per tutti i comandi M3a (yjs_*, iroh_*,
  // save_*_from_sync) + M3a.1 (lan_*) così tsc --noEmit è pulito anche in
  // anteprima web. In produzione Tauri usa tauriApi che ha i comandi reali.

  // B.3 — yrs core
  async yjsApplyUpdate(_updateBytes: Uint8Array): Promise<boolean> {
    return true;
  },
  async yjsGetStateVector(): Promise<Uint8Array> {
    return new Uint8Array(0);
  },
  async yjsGetDiff(_stateVector: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(0);
  },

  // B.4 — Iroh p2p transport
  async irohStartNode(): Promise<string> {
    return "mock-peer-key-1234567890abcdef";
  },
  async irohGetPeerKey(): Promise<string> {
    return "mock-peer-key-1234567890abcdef";
  },
  async irohConnectByPeerKey(_peerKey: string): Promise<boolean> {
    return true;
  },
  async irohBroadcastUpdate(_updateBytes: Uint8Array): Promise<void> {
    // no-op in mock
  },
  async irohSubscribeUpdates(): Promise<void> {
    // no-op in mock — subscribe loop non avviato in anteprima web
  },
  async irohGetConnectedPeers(): Promise<string[]> {
    return [];
  },
  async irohDisconnectPeer(_peerKey: string): Promise<void> {
    // no-op
  },

  // M3a.3 — Peer key persistente + trusted peers (stub mock)
  async irohStopNode(): Promise<void> {
    // no-op
  },
  async irohConnectByPeerKeyV2(_peerKey: string): Promise<boolean> {
    return true;
  },
  async getSyncIdentity(): Promise<SyncIdentity | null> {
    return null; // anteprima web — nessuna identità persistita
  },
  async setSyncDisplayName(_name: string): Promise<void> {
    // no-op
  },
  async listTrustedPeers(): Promise<TrustedPeer[]> {
    return [];
  },
  async removeTrustedPeer(_peerKey: string): Promise<void> {
    // no-op
  },

  // M3a.3 — Listener eventi Tauri (stub mock, mai attivi in anteprima)
  async onSyncUpdateReceived(
    _cb: (event: SyncUpdateReceivedEvent) => void
  ): Promise<() => void> {
    return () => {
      // no-op unlisten
    };
  },
  async onSyncPeerConnected(
    _cb: (event: { peerKey: string }) => void
  ): Promise<() => void> {
    return () => {
      // no-op
    };
  },
  async onSyncPeerDisconnected(
    _cb: (event: { peerKey: string }) => void
  ): Promise<() => void> {
    return () => {
      // no-op
    };
  },

  // M3a.4 + M3a.5 — Pairing cifrato (stub mock, anteprima web non paira davvero)
  async deriveSharedSecret(_theirPeerKey: string): Promise<Uint8Array> {
    return new Uint8Array(32); // 32 byte di zeri come mock shared_secret
  },
  async encryptUpdate(update: Uint8Array, _sharedSecret: Uint8Array): Promise<Uint8Array> {
    return update; // pass-through (no encryption in mock)
  },
  async decryptUpdate(ciphertext: Uint8Array, _sharedSecret: Uint8Array): Promise<Uint8Array> {
    return ciphertext; // pass-through
  },
  async listPairings(): Promise<Pairing[]> {
    return [];
  },
  async savePairing(): Promise<void> {
    // no-op
  },
  async deletePairing(): Promise<void> {
    // no-op
  },
  async pairingCreate(): Promise<PairingCode> {
    return {
      code: "12345678",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      revokedCodes: [],
    };
  },
  async pairingJoin(_code: string, _peerKeyInitiator: string): Promise<PairingResult> {
    return {
      peerKeyOther: "mock-peer-key-1234567890abcdef",
      roomName: "df-sync-mock",
      sharedSecret: new Array(32).fill(0),
    };
  },
  async pairingComplete(_code: string, _peerKeyResponder: string): Promise<PairingResult> {
    return {
      peerKeyOther: "mock-peer-key-1234567890abcdef",
      roomName: "df-sync-mock",
      sharedSecret: new Array(32).fill(0),
    };
  },
  async pairingCancel(): Promise<void> {
    // no-op
  },
  async listPendingPairings(): Promise<PairingPending[]> {
    return [];
  },
  async cleanupExpiredPendingPairings(): Promise<number> {
    return 0;
  },
  async cleanupAllPendingPairings(): Promise<number> {
    return 0;
  },
  async touchPairingLastSeen(): Promise<void> {
    // no-op
  },
  async setPairingDisplayName(): Promise<void> {
    // no-op
  },

  // B.8 — save_*_from_sync (con marker updated_by='sync-live')
  async savePlayerFromSync(_input: unknown): Promise<void> {
    // no-op in mock — anteprima web non replica sync
  },
  async saveScoutingNoteFromSync(_input: unknown): Promise<number> {
    return 0;
  },
  async saveAuctionDataFromSync(_input: unknown): Promise<void> {
    // no-op
  },

  // M3a B.9 — Fallback WebSocket LAN-only (stub, mai attivo in anteprima)
  async lanStartServer(_addr: string): Promise<string> {
    return "127.0.0.1:0";
  },
  async lanConnect(_addr: string): Promise<boolean> {
    return false;
  },
  async lanBroadcastUpdate(_updateBytes: Uint8Array): Promise<void> {
    // no-op
  },
  async lanGetConnectedPeers(): Promise<string[]> {
    return [];
  },
  async lanDisconnectPeer(_peerKey: string): Promise<void> {
    // no-op
  },
  async lanDiscoverPeers(_timeoutMs?: number): Promise<string[]> {
    return [];
  },
};

export type MockApi = typeof mockApi;
