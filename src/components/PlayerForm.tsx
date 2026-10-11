/**
 * PlayerForm — Scheda giocatore completa (v2.3.3, Cap.9 redesign).
 *
 * Layout secondo Cap.9 del design doc:
 *
 * ┌─ HEADER: nome + stelle priorità + tooltip ? ──────────────┐
 * │ Sub: squadra · ruolo reale · età                            │
 * │ Stats: FVM · MV · M · f₥ spesi (STORICO, non budget asta)   │
 * ├─ DUE PANNELLI FIANCO A FIANCO ──────────────────────────────┤
 * │  ┌── ASTA ───────────┐  ┌── SCOUTING ──────────┐           │
 * │  │ titolarità [1-10]  │  │ [DATI] | [LINK]       │           │
 * │  │ infortuni [select] │  │ DATI: tabella label/  │           │
 * │  │ budget max [f₥]    │  │  content/source       │           │
 * │  │ nota rapida [text] │  │ LINK: elenco URL      │           │
 * │  │ ─assegnazione:     │  │                       │           │
 * │  │  assigned_to        │  │                       │           │
 * │  │  f₥ paid           │  │                       │           │
 * │  └────────────────────┘  └───────────────────────┘           │
 * ├─ NOTE SCOUTING box (lista note esistenti + add form) ───────┤
 * ├─ FOOTER: [✓ SCOUTATO] ⇄  ✎ ✕ ⧉                                │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Disambiguazione f₥ (IMPORTANTE, richiesta dall'utente):
 *  - fmil_spesi (top stats row): storico, f₥ spesi nell'ultima asta
 *    realmente conclusa per il giocatore. Editabile nel form base.
 *  - fmil_max (pannello ASTA): BUDGET che SON DISPOSTO a spendere
 *    all'asta corrente. Diverso concetto da fmil_spesi (che è storico).
 *  - fmil_paid (pannello ASTA, se assegnato): prezzo effettivo di
 *    assegnazione. Solo se il giocatore è stato assegnato (assigned_to != null).
 *
 * Modalità:
 *  - embedded=true: per Window WM in-app o finestra OS nativa (no backdrop)
 *  - embedded=false: modale a tutto schermo per "Nuovo giocatore" (M2 base)
 *
 * Comandi Rust usati:
 *  - api.getPlayer(id) per fetch singolo
 *  - api.getAuctionData(id) + api.saveAuctionData(...) per auction_data
 *  - api.listScoutingNotes(id) + api.saveScoutingNote(...) per note
 *  - api.assignPlayer(id, team, paid) per assegnazione
 *  - api.updatePlayer(input) per i campi base di players
 */

import { useEffect, useState } from "react";
import type {
  AuctionData,
  CreatePlayerInput,
  Fascia,
  Player,
  PosFanta,
  ScoutingNote,
  ScoutingNoteKind,
  Status,
  UpdatePlayerInput,
} from "@/types/player";
import { FASCIA_VALUES, POS_FANTA_VALUES, STATUS_VALUES } from "@/types/player";
import { api } from "@/api/tauri";
import { GlossaryTooltip } from "./GlossaryTooltip";
import { Stamp } from "./Stamp";
import { fmtFmil } from "@/lib/format";

interface Props {
  /** Se passato, modalità edit (pre-popolato). Se null, modalità create. */
  player: Player | null;
  onClose: () => void;
  onSubmit: (input: CreatePlayerInput | UpdatePlayerInput) => Promise<void>;
  /**
   * M2.1 B5 — Se true, omette il backdrop modale a tutto schermo e renderizza
   * come contenuto embedded che riempie il parent (usato dentro Window WM e
   * finestra OS nativa).
   */
  embedded?: boolean;
}

interface FormState {
  name: string;
  team: string;
  pos_fanta: PosFanta | "";
  pos_real: string;
  fascia: Fascia | "";
  priority: number;
  fmil_spesi: string;   // STORICO: f₥ spesi nell'ultima asta conclusa
  med: string;
  medv: string;
  fvm: string;
  status: Status;
}

const EMPTY_FORM: FormState = {
  name: "",
  team: "",
  pos_fanta: "",
  pos_real: "",
  fascia: "",
  priority: 0,
  fmil_spesi: "",
  med: "",
  medv: "",
  fvm: "",
  status: "totali",
};

export function PlayerForm({ player, onClose, onSubmit, embedded = false }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // M2.1.1 — Dati asta e note scouting (fetchati quando player è passato)
  const [auctionData, setAuctionData] = useState<AuctionData | null>(null);
  const [scoutingNotes, setScoutingNotes] = useState<ScoutingNote[]>([]);
  const [auctionLoading, setAuctionLoading] = useState(false);
  const [auctionError, setAuctionError] = useState<string | null>(null);

  // Form asta (campi editabili)
  const [astaForm, setAstaForm] = useState<{
    titolarita: string;
    infortuni: string;
    fmil_max: string;
    quick_note: string;
  }>({ titolarita: "", infortuni: "nessuno", fmil_max: "", quick_note: "" });

  // Form assegnazione (per giocatore NON ancora assegnato)
  const [assignForm, setAssignForm] = useState<{ assigned_to: string; fmil_paid: string }>({
    assigned_to: "",
    fmil_paid: "",
  });

  // Mini-form per nuova nota scouting
  const [newNote, setNewNote] = useState<{
    kind: ScoutingNoteKind;
    label: string;
    content: string;
    source: string;
  }>({ kind: "note", label: "", content: "", source: "manual" });

  // Tab attiva nel pannello SCOUTING
  const [scoutingTab, setScoutingTab] = useState<"data" | "link">("data");

  // Pre-popola in edit mode + fetch auction_data + scouting_notes
  useEffect(() => {
    if (player) {
      setForm({
        name: player.name,
        team: player.team ?? "",
        pos_fanta: player.pos_fanta ?? "",
        pos_real: player.pos_real ?? "",
        fascia: player.fascia ?? "",
        priority: player.priority,
        fmil_spesi: player.fmil_spesi?.toString() ?? "",
        med: player.med !== null ? player.med.toString() : "",
        medv: player.medv !== null ? player.medv.toString() : "",
        fvm: player.fvm?.toString() ?? "",
        status: player.status,
      });

      // Fetch auction_data + scouting_notes
      setAuctionLoading(true);
      setAuctionError(null);
      Promise.all([
        api.getAuctionData(player.id).catch((e) => {
          setAuctionError(e instanceof Error ? e.message : String(e));
          return null;
        }),
        api.listScoutingNotes(player.id).catch((e) => {
          setAuctionError(e instanceof Error ? e.message : String(e));
          return [];
        }),
      ]).then(([ad, notes]) => {
        setAuctionData(ad);
        setScoutingNotes(notes);
        setAstaForm({
          titolarita: ad?.titolarita?.toString() ?? "",
          infortuni: ad?.infortuni ?? "nessuno",
          fmil_max: ad?.fmil_max?.toString() ?? "",
          quick_note: ad?.quick_note ?? "",
        });
        setAssignForm({
          assigned_to: ad?.assigned_to ?? "",
          fmil_paid: ad?.fmil_paid?.toString() ?? "",
        });
        setAuctionLoading(false);
      });
    } else {
      setForm(EMPTY_FORM);
      setAuctionData(null);
      setScoutingNotes([]);
    }
  }, [player]);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k as string]) {
      setErrors((e) => {
        const n = { ...e };
        delete n[k as string];
        return n;
      });
    }
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Nome è obbligatorio";
    if (form.med) {
      const v = parseFloat(form.med);
      if (isNaN(v) || v < 0 || v > 10) e.med = "Med (M) deve essere 0-10";
    }
    if (form.medv) {
      const v = parseFloat(form.medv);
      if (isNaN(v) || v < 0 || v > 10) e.medv = "MedV (MV) deve essere 0-10";
    }
    if (form.fmil_spesi) {
      const v = parseInt(form.fmil_spesi, 10);
      if (isNaN(v) || v < 0) e.fmil_spesi = "f₥ spesi (storico) deve essere intero ≥ 0";
    }
    if (form.fvm) {
      const v = parseInt(form.fvm, 10);
      if (isNaN(v) || v < 0) e.fvm = "FVM deve essere intero ≥ 0";
    }
    if (form.priority < 0 || form.priority > 5) e.priority = "Priorità 0-5";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const toNum = (s: string) => (s.trim() === "" ? null : Number(s));
      const toInt = (s: string) => (s.trim() === "" ? null : parseInt(s, 10));

      if (player) {
        // Edit: aggiorna anche fmil_spesi (storico) e gli altri campi base
        const input: UpdatePlayerInput = {
          id: player.id,
          name: form.name.trim(),
          team: form.team.trim() || null,
          pos_fanta: (form.pos_fanta || null) as PosFanta | null,
          pos_real: form.pos_real.trim() || null,
          fascia: (form.fascia || null) as Fascia | null,
          priority: form.priority,
          fmil_spesi: toInt(form.fmil_spesi),   // STORICO
          med: toNum(form.med),
          medv: toNum(form.medv),
          fvm: toInt(form.fvm),
        };
        await onSubmit(input);

        // Salva anche i dati asta (se modificati)
        const tit = astaForm.titolarita.trim() ? parseInt(astaForm.titolarita, 10) : null;
        const inf = astaForm.infortuni || null;
        const fmax = astaForm.fmil_max.trim() ? parseInt(astaForm.fmil_max, 10) : null;
        const qn = astaForm.quick_note.trim() || null;
        await api.saveAuctionData(player.id, tit, inf, fmax, qn);

        // Se assignForm è compilato e diverso da auctionData.assigned_to, assegna
        if (assignForm.assigned_to.trim() && assignForm.fmil_paid.trim()) {
          const paid = parseInt(assignForm.fmil_paid, 10);
          if (!isNaN(paid) && paid >= 0) {
            await api.assignPlayer(player.id, assignForm.assigned_to.trim(), paid);
          }
        }
      } else {
        // Create
        const input: CreatePlayerInput = {
          name: form.name.trim(),
          team: form.team.trim() || null,
          pos_fanta: (form.pos_fanta || null) as PosFanta | null,
          pos_real: form.pos_real.trim() || null,
          fascia: (form.fascia || null) as Fascia | null,
          priority: form.priority,
          fmil_spesi: toInt(form.fmil_spesi),
          med: toNum(form.med),
          medv: toNum(form.medv),
          fvm: toInt(form.fvm),
          status: form.status,
        };
        await onSubmit(input);
      }
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Salva nota scouting (auto-toggle: se status='da_fare' e nota non vuota → scoutato)
  const handleAddNote = async () => {
    if (!player) return;
    if (!newNote.content.trim()) return;
    try {
      await api.saveScoutingNote({
        player_id: player.id,
        kind: newNote.kind,
        label: newNote.label.trim() || null,
        content: newNote.content.trim() || null,
        source: newNote.source.trim() || null,
      });
      // Refresh note
      const notes = await api.listScoutingNotes(player.id);
      setScoutingNotes(notes);
      // Reset mini-form
      setNewNote({ kind: "note", label: "", content: "", source: "manual" });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  };

  // Contenuto condiviso tra modalità embedded e modale
  const formContent = (
    <>
      {/* ============ HEADER: nome + stelle + stats ============ */}
      <div
        className="wf-form-head"
        style={{
          padding: "0.85rem 1rem",
          borderBottom: "2px dashed rgba(43,27,18,0.20)",
          backgroundColor: "rgba(43,27,18,0.04)",
        }}
      >
        {/* Riga 1: nome + stelle priorità */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
          <input
            id="name"
            type="text"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            className={`tacc-input ${errors.name ? "tacc-input--error" : ""}`}
            style={{ fontFamily: "var(--font-display)", fontSize: "1.1rem", fontWeight: "bold" }}
            placeholder="Es. Marcus Thuram"
            autoFocus={!player}
          />
          <GlossaryTooltip term="priorita">
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.8rem",
                color: "var(--amber)",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
              title={`Priorità ${form.priority}/5`}
            >
              <span aria-hidden>
                {"★".repeat(form.priority)}
                <span style={{ color: "rgba(43,27,18,0.18)" }}>
                  {"★".repeat(5 - form.priority)}
                </span>
              </span>
            </div>
          </GlossaryTooltip>
        </div>

        {/* Riga 2: squadra · ruolo reale · pos_fanta + fascia + status */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 1fr 1fr",
            gap: "0.4rem",
            marginBottom: "0.4rem",
          }}
        >
          <input
            type="text"
            value={form.team}
            onChange={(e) => update("team", e.target.value)}
            className="tacc-input"
            placeholder="Squadra"
            list="teams-list"
            style={{ fontSize: "0.8rem" }}
          />
          <select
            value={form.pos_fanta}
            onChange={(e) => update("pos_fanta", e.target.value as PosFanta | "")}
            className={`tacc-input ${errors.pos_fanta ? "tacc-input--error" : ""}`}
            style={{ fontSize: "0.8rem" }}
          >
            <option value="">P/D/C/A</option>
            {POS_FANTA_VALUES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select
            value={form.fascia}
            onChange={(e) => update("fascia", e.target.value as Fascia | "")}
            className="tacc-input"
            style={{ fontSize: "0.8rem" }}
          >
            <option value="">Fascia</option>
            {FASCIA_VALUES.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <select
            value={form.status}
            onChange={(e) => update("status", e.target.value as Status)}
            className="tacc-input"
            style={{ fontSize: "0.8rem" }}
            disabled={!player}
            title={player ? "Status scouting" : "Settato dopo creazione"}
          >
            {STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <input
          type="text"
          value={form.pos_real}
          onChange={(e) => update("pos_real", e.target.value)}
          className="tacc-input"
          placeholder="Ruolo reale (es. Punta centrale / Ala destra)"
          style={{ fontSize: "0.75rem", marginBottom: "0.4rem" }}
        />

        {/* Riga 3: priorità slider + stats compatte */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", alignItems: "center" }}>
          <label style={{ fontSize: "0.7rem", color: "var(--ink-soft)" }}>
            Priorità: <strong>{form.priority}/5</strong>
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={form.priority}
              onChange={(e) => update("priority", parseInt(e.target.value, 10))}
              style={{ width: "100%" }}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "0.3rem" }}>
            <StatField label="f₥ spesi" value={form.fmil_spesi} onChange={(v) => update("fmil_spesi", v)} error={errors.fmil_spesi} placeholder="78" kind="integer" title="STORICO: f₥ spesi nell'ultima asta realmente conclusa" tooltipTerm="fmil" />
            <StatField label="FVM" value={form.fvm} onChange={(v) => update("fvm", v)} error={errors.fvm} placeholder="32" kind="integer" tooltipTerm="fvm" />
            <StatField label="M" value={form.med} onChange={(v) => update("med", v)} error={errors.med} placeholder="6.05" kind="decimal" tooltipTerm="med" />
            <StatField label="MV" value={form.medv} onChange={(v) => update("medv", v)} error={errors.medv} placeholder="6.85" kind="decimal" tooltipTerm="medv" />
          </div>
        </div>

        <datalist id="teams-list">
          <option value="Inter" />
          <option value="Milan" />
          <option value="Juventus" />
          <option value="Roma" />
          <option value="Napoli" />
          <option value="Atalanta" />
          <option value="Lazio" />
          <option value="Fiorentina" />
          <option value="Bologna" />
        </datalist>
      </div>

      {/* ============ DUE PANNELLI FIANCO A FIANCO: ASTA | SCOUTING ============ */}
      {player && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "0.6rem",
            padding: "0.85rem 1rem",
            backgroundColor: "rgba(43,27,18,0.02)",
          }}
        >
          {/* ----- PANNELLO ASTA ----- */}
          <div
            className="wf-panel"
            style={{
              border: "1px solid rgba(43,27,18,0.25)",
              backgroundColor: "var(--paper)",
            }}
          >
            <div
              className="wf-panel-head"
              style={{
                backgroundColor: "var(--ink)",
                color: "var(--paper)",
                padding: "0.35rem 0.6rem",
                fontFamily: "var(--font-display)",
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>» ASTA</span>
              {auctionData?.assigned_to && (
                <span
                  style={{
                    fontSize: "0.6rem",
                    color: "var(--amber)",
                    textTransform: "uppercase",
                  }}
                  title={`Assegnato a ${auctionData.assigned_to} per f₥ ${auctionData.fmil_paid} il ${auctionData.assigned_at ?? "?"}`}
                >
                  ✓ ASSEGNATO
                </span>
              )}
            </div>
            <div style={{ padding: "0.6rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {auctionLoading ? (
                <div style={{ fontSize: "0.75rem", color: "var(--ink-soft)" }}>caricamento dati asta…</div>
              ) : auctionError ? (
                <div style={{ fontSize: "0.75rem", color: "var(--red)" }}>errore: {auctionError}</div>
              ) : (
                <>
                  {/* titolarità + infortuni fianco a fianco */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      <GlossaryTooltip term="titolarita">
                        <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontFamily: "var(--font-display)" }}>
                          titolarità [1-10]
                        </span>
                      </GlossaryTooltip>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={astaForm.titolarita}
                        onChange={(e) => setAstaForm((f) => ({ ...f, titolarita: e.target.value }))}
                        className="tacc-input"
                        style={{ fontSize: "0.85rem" }}
                        placeholder="9"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      <GlossaryTooltip term="infortuni">
                        <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontFamily: "var(--font-display)" }}>
                          infortuni
                        </span>
                      </GlossaryTooltip>
                      <select
                        value={astaForm.infortuni}
                        onChange={(e) => setAstaForm((f) => ({ ...f, infortuni: e.target.value }))}
                        className="tacc-input"
                        style={{ fontSize: "0.85rem" }}
                      >
                        <option value="nessuno">nessuno</option>
                        <option value="lieve">lieve</option>
                        <option value="grave">grave</option>
                      </select>
                    </label>
                  </div>

                  {/* budget max f₥ (NUOVO: quello che SON DISPOSTO a spendere, diverso da fmil_spesi storico) */}
                  <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                    <GlossaryTooltip term="fmil">
                      <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--red)", fontFamily: "var(--font-display)" }}>
                        budget max f₥ (sono disposto a spendere)
                      </span>
                    </GlossaryTooltip>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={astaForm.fmil_max}
                      onChange={(e) => setAstaForm((f) => ({ ...f, fmil_max: e.target.value }))}
                      className="tacc-input"
                      style={{ fontSize: "0.95rem", fontWeight: "bold", color: "var(--red)" }}
                      placeholder="80"
                    />
                    <span style={{ fontSize: "0.6rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
                      ↳ diverso da "f₥ spesi" (storico in alto, opzionale)
                    </span>
                  </label>

                  {/* nota rapida */}
                  <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                    <span style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--ink-soft)", fontFamily: "var(--font-display)" }}>
                      nota rapida (asta live)
                    </span>
                    <textarea
                      value={astaForm.quick_note}
                      onChange={(e) => setAstaForm((f) => ({ ...f, quick_note: e.target.value }))}
                      className="tacc-input"
                      style={{ fontSize: "0.8rem", minHeight: "3rem", resize: "vertical" }}
                      placeholder="es. rigorista, brace di Thuram,stop rosa a 60 f₥"
                    />
                  </label>

                  {/* Assegnazione (se già assegnato, mostra; altrimenti mini-form per assegnare) */}
                  {auctionData?.assigned_to ? (
                    <div
                      style={{
                        marginTop: "0.3rem",
                        padding: "0.4rem 0.6rem",
                        backgroundColor: "rgba(74, 103, 65, 0.10)",
                        borderLeft: "3px solid var(--green)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div style={{ fontFamily: "var(--font-display)", color: "var(--green)", marginBottom: "0.2rem" }}>
                        ✓ ASSEGNATO
                      </div>
                      <div style={{ color: "var(--ink)" }}>
                        Team: <strong>{auctionData.assigned_to}</strong>
                      </div>
                      <div style={{ color: "var(--ink)" }}>
                        Pagato: <strong>{fmtFmil(auctionData.fmil_paid)}</strong>
                      </div>
                      {auctionData.assigned_at && (
                        <div style={{ fontSize: "0.65rem", color: "var(--ink-soft)" }}>
                          il {auctionData.assigned_at}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      style={{
                        marginTop: "0.3rem",
                        padding: "0.4rem 0.6rem",
                        backgroundColor: "rgba(184, 134, 11, 0.08)",
                        borderLeft: "3px solid var(--amber)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div style={{ fontFamily: "var(--font-display)", color: "var(--amber)", marginBottom: "0.3rem", fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        ↳ assegnazione (compila per registrare)
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.3rem" }}>
                        <input
                          type="text"
                          value={assignForm.assigned_to}
                          onChange={(e) => setAssignForm((f) => ({ ...f, assigned_to: e.target.value }))}
                          className="tacc-input"
                          style={{ fontSize: "0.75rem" }}
                          placeholder="Team lega (es. Inter FC)"
                        />
                        <input
                          type="number"
                          min={0}
                          value={assignForm.fmil_paid}
                          onChange={(e) => setAssignForm((f) => ({ ...f, fmil_paid: e.target.value }))}
                          className="tacc-input"
                          style={{ fontSize: "0.75rem" }}
                          placeholder="f₥ 78"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ----- PANNELLO SCOUTING ----- */}
          <div
            className="wf-panel"
            style={{
              border: "1px solid rgba(43,27,18,0.25)",
              backgroundColor: "var(--paper)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              className="wf-panel-head"
              style={{
                backgroundColor: "var(--ink)",
                color: "var(--paper)",
                padding: "0.35rem 0.6rem",
                fontFamily: "var(--font-display)",
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                display: "flex",
                gap: "0.4rem",
              }}
            >
              <button
                type="button"
                onClick={() => setScoutingTab("data")}
                style={{
                  background: scoutingTab === "data" ? "var(--paper)" : "transparent",
                  color: scoutingTab === "data" ? "var(--ink)" : "var(--paper)",
                  border: "none",
                  padding: "0.15rem 0.5rem",
                  fontFamily: "var(--font-display)",
                  fontSize: "0.65rem",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                DATI
              </button>
              <button
                type="button"
                onClick={() => setScoutingTab("link")}
                style={{
                  background: scoutingTab === "link" ? "var(--paper)" : "transparent",
                  color: scoutingTab === "link" ? "var(--ink)" : "var(--paper)",
                  border: "none",
                  padding: "0.15rem 0.5rem",
                  fontFamily: "var(--font-display)",
                  fontSize: "0.65rem",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                LINK
              </button>
            </div>
            <div style={{ padding: "0.6rem", flex: 1, overflowY: "auto", maxHeight: "280px" }}>
              {/* Lista note per tab attivo */}
              {scoutingNotes.filter((n) => n.kind === scoutingTab).length === 0 ? (
                <div style={{ fontSize: "0.7rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
                  nessun {scoutingTab === "data" ? "dato" : "link"} scouting per questo giocatore
                </div>
              ) : (
                scoutingNotes
                  .filter((n) => n.kind === scoutingTab)
                  .map((n) => (
                    <div
                      key={n.id}
                      style={{
                        padding: "0.3rem 0.4rem",
                        marginBottom: "0.3rem",
                        backgroundColor: "rgba(43,27,18,0.04)",
                        borderLeft: "2px solid var(--ink-soft)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.3rem" }}>
                        <span style={{ fontFamily: "var(--font-display)", fontWeight: "bold", color: "var(--ink)", fontSize: "0.7rem" }}>
                          {n.label ?? "—"}
                        </span>
                        {n.source && (
                          <span style={{ fontSize: "0.6rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
                            [{n.source}]
                          </span>
                        )}
                      </div>
                      <div className="wf-note-content" style={{ color: "var(--ink)", marginTop: "0.2rem" }}>
                        {n.content ?? "—"}
                      </div>
                    </div>
                  ))
              )}
            </div>
            {/* Mini-form aggiunta nota per tab attivo */}
            <div
              style={{
                borderTop: "1px dashed rgba(43,27,18,0.20)",
                padding: "0.5rem 0.6rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem",
                backgroundColor: "rgba(43,27,18,0.02)",
              }}
            >
              <div style={{ display: "flex", gap: "0.3rem" }}>
                <input
                  type="text"
                  value={newNote.label}
                  onChange={(e) => setNewNote((n) => ({ ...n, label: e.target.value }))}
                  className="tacc-input"
                  style={{ fontSize: "0.7rem", flex: 1 }}
                  placeholder={scoutingTab === "data" ? "label (es. xG 25/26)" : "label (es. SofaScore)"}
                />
                <input
                  type="text"
                  value={newNote.source}
                  onChange={(e) => setNewNote((n) => ({ ...n, source: e.target.value }))}
                  className="tacc-input"
                  style={{ fontSize: "0.7rem", width: "80px" }}
                  placeholder="fonte"
                />
              </div>
              <input
                type="text"
                value={newNote.content}
                onChange={(e) => setNewNote((n) => ({ ...n, content: e.target.value, kind: scoutingTab }))}
                className="tacc-input"
                style={{ fontSize: "0.75rem" }}
                placeholder={scoutingTab === "data" ? "valore (es. 18.4)" : "URL (es. https://sofascore.com)"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAddNote();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void handleAddNote()}
                disabled={!newNote.content.trim()}
                className="tacc-btn tacc-btn--primary"
                style={{ fontSize: "0.65rem", padding: "0.25rem 0.5rem" }}
                title="Aggiungi nota scouting. Auto-toggle: se status='da_fare' e content non vuoto → SCOUTATO"
              >
                + aggiungi {scoutingTab === "data" ? "dato" : "link"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ NOTE SCOUTING box (tutte le note, non solo DATI/LINK) ============ */}
      {player && scoutingNotes.some((n) => n.kind === "note") && (
        <div
          style={{
            margin: "0 1rem 0.6rem",
            padding: "0.5rem 0.7rem",
            backgroundColor: "rgba(184, 134, 11, 0.06)",
            borderLeft: "3px solid var(--amber)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "0.65rem",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--amber)",
              marginBottom: "0.35rem",
            }}
          >
            » NOTE SCOUTING (testo libero)
          </div>
          {scoutingNotes
            .filter((n) => n.kind === "note")
            .map((n) => (
              <div
                key={n.id}
                style={{
                  fontSize: "0.8rem",
                  color: "var(--ink)",
                  fontStyle: "italic",
                  marginBottom: "0.25rem",
                  fontFamily: "var(--font-handnote, var(--font-body))",
                }}
              >
                "{n.content}"
                {n.source && (
                  <span style={{ fontSize: "0.6rem", color: "var(--ink-soft)", fontStyle: "normal" }}>
                    {" "}— {n.source}
                  </span>
                )}
              </div>
            ))}
          <div style={{ fontSize: "0.6rem", color: "var(--ink-soft)", marginTop: "0.3rem", fontStyle: "italic" }}>
            ↳ auto-toggle: aggiungi una nota → status passa a SCOUTATO automaticamente
          </div>
        </div>
      )}

      {/* ============ ERRORI ============ */}
      {submitError && (
        <div
          className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm"
          style={{ fontFamily: "var(--font-body)", margin: "0 1rem 0.5rem" }}
        >
          <strong>Errore:</strong> {submitError}
        </div>
      )}

      {/* ============ FOOTER ============ */}
      <div
        style={{
          backgroundColor: "var(--paper-dim)",
          borderTop: "2px solid rgba(43, 27, 18, 0.3)",
          padding: "0.6rem 1rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          {player && (
            <>
              <Stamp variant={player.status === "scoutato" ? "scoutato" : player.status === "da_fare" ? "da-fare" : "custom"} color="var(--ink-soft)">
                {player.status === "scoutato" ? "Scoutato" : player.status === "da_fare" ? "Da fare" : "Totale"}
              </Stamp>
              <span style={{ fontSize: "0.6rem", color: "var(--ink-soft)" }}>
                ⇄ click sul timbro nella card per cambiare
              </span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button type="button" onClick={onClose} className="tacc-btn">
            Annulla
          </button>
          <button type="submit" disabled={submitting} className="tacc-btn tacc-btn--primary">
            {submitting ? "Salvataggio…" : player ? "Salva modifiche" : "Crea giocatore"}
          </button>
        </div>
      </div>
    </>
  );

  // ===== Render finale: embedded (no backdrop) vs modale (backdrop) =====
  if (embedded) {
    return (
      <form
        onSubmit={handleSubmit}
        className="h-full flex flex-col tacc-bg"
        aria-modal="true"
        role="dialog"
      >
        <header
          className="tacc-modal-header"
          style={{ padding: "0.45rem 0.85rem", fontSize: "0.85rem" }}
        >
          <h2 className="text-sm font-bold">
            {player ? `» ${player.name}` : "» Nuovo giocatore"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-paper/70 hover:text-paper text-lg leading-none"
            aria-label="Chiudi"
            title="Chiudi finestra"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">{formContent}</div>
      </form>
    );
  }

  // Modalità modale a tutto schermo (pulsante "Nuovo giocatore")
  return (
    <div className="tacc-modal-backdrop" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="tacc-modal w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        aria-modal="true"
        role="dialog"
      >
        <header className="tacc-modal-header sticky top-0 z-10">
          <h2 className="text-lg font-bold">
            {player ? `» Modifica: ${player.name}` : "» Nuovo giocatore"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-paper/70 hover:text-paper text-xl leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </header>
        {formContent}
      </form>
    </div>
  );
}

// ----------------------------------------------------------------------
// StatField — mini-input compatto per stats (f₥ spesi / FVM / M / MV)
// ----------------------------------------------------------------------
function StatField({
  label,
  value,
  onChange,
  error,
  placeholder,
  kind,
  title,
  tooltipTerm,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  kind: "integer" | "decimal";
  title?: string;
  tooltipTerm?: "fmil" | "med" | "medv" | "fvm" | "fascia" | "priorita";
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }} title={title}>
      <GlossaryTooltip term={tooltipTerm ?? "fmil"}>
        <span
          style={{
            fontSize: "0.55rem",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            color: "var(--ink-soft)",
            fontFamily: "var(--font-display)",
          }}
        >
          {label}
        </span>
      </GlossaryTooltip>
      <input
        type="number"
        min={0}
        step={kind === "integer" ? 1 : 0.01}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`tacc-input ${error ? "tacc-input--error" : ""}`}
        style={{ fontSize: "0.85rem", padding: "0.25rem 0.4rem" }}
        placeholder={placeholder}
      />
      {error && (
        <span style={{ fontSize: "0.55rem", color: "var(--red)" }}>{error}</span>
      )}
    </label>
  );
}
