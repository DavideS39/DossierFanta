import { useEffect, useState } from "react";
import type {
  CreatePlayerInput,
  Fascia,
  Player,
  PosFanta,
  UpdatePlayerInput,
} from "@/types/player";
import { FASCIA_VALUES, POS_FANTA_VALUES } from "@/types/player";

interface Props {
  /** Se passato, modalità edit (pre-popolato). Se null, modalità create. */
  player: Player | null;
  onClose: () => void;
  onSubmit: (input: CreatePlayerInput | UpdatePlayerInput) => Promise<void>;
}

interface FormState {
  name: string;
  team: string;
  pos_fanta: PosFanta | "";
  pos_real: string;
  fascia: Fascia | "";
  priority: number;
  fmil_spesi: string; // string per permettere empty
  med: string;
  medv: string;
  fvm: string;
}

const EMPTY: FormState = {
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
};

/**
 * Form di creazione/modifica giocatore (M2 — design taccuino).
 *
 * Campi gestiti (dal requisito M1/M2):
 *   name, team, pos_fanta (P/D/C/A), pos_real, fascia, priority (0-5),
 *   fmil_spesi (integer, f₥), med (real 0-10, M), medv (real 0-10, MV),
 *   fvm (integer, FVM)
 *
 * Validazione lato client (mirrors Rust validators):
 *   - name obbligatorio
 *   - med/medv 0-10
 *   - priority 0-5
 *   - pos_fanta/fascia enum
 *
 * M2 design:
 *   - Usa classi `.tacc-modal`, `.tacc-input`, `.tacc-btn`
 *   - Header nero + footer grigio dim (coerenza design system)
 *   - Etichette in Special Elite (font-display)
 */
export function PlayerForm({ player, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-popola in edit mode
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
      });
    } else {
      setForm(EMPTY);
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
      if (isNaN(v) || v < 0) e.fmil_spesi = "f₥ deve essere intero ≥ 0";
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
        const input: UpdatePlayerInput = {
          id: player.id,
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
        };
        await onSubmit(input);
      } else {
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

  return (
    <div className="tacc-modal-backdrop" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="tacc-modal w-full max-w-2xl max-h-[90vh] overflow-y-auto"
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

        <div className="p-5 space-y-4 tacc-bg">
          {/* Nome (required) */}
          <Field label="Nome *" error={errors.name} htmlFor="name">
            <input
              id="name"
              type="text"
              required
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              className={`tacc-input ${errors.name ? "tacc-input--error" : ""}`}
              placeholder="Es. Marcus Thuram"
              autoFocus
            />
          </Field>

          {/* Squadra + ruolo fantacalcio */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Squadra" htmlFor="team">
              <input
                id="team"
                type="text"
                value={form.team}
                onChange={(e) => update("team", e.target.value)}
                className="tacc-input"
                placeholder="Es. Inter"
                list="teams-list"
              />
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
            </Field>

            <Field label="Ruolo (fantacalcio)" htmlFor="pos_fanta" error={errors.pos_fanta}>
              <select
                id="pos_fanta"
                value={form.pos_fanta}
                onChange={(e) => update("pos_fanta", e.target.value as PosFanta | "")}
                className={`tacc-input ${errors.pos_fanta ? "tacc-input--error" : ""}`}
              >
                <option value="">—</option>
                {POS_FANTA_VALUES.map((p) => (
                  <option key={p} value={p}>
                    {p} — {labelForRole(p)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* pos_real + fascia */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ruolo reale" htmlFor="pos_real">
              <input
                id="pos_real"
                type="text"
                value={form.pos_real}
                onChange={(e) => update("pos_real", e.target.value)}
                className="tacc-input"
                placeholder="Es. Punta centrale / Ala destra"
              />
            </Field>

            <Field label="Fascia" htmlFor="fascia" error={errors.fascia}>
              <select
                id="fascia"
                value={form.fascia}
                onChange={(e) => update("fascia", e.target.value as Fascia | "")}
                className={`tacc-input ${errors.fascia ? "tacc-input--error" : ""}`}
              >
                <option value="">—</option>
                {FASCIA_VALUES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Priorità slider */}
          <Field label={`Priorità: ${form.priority} / 5 ${form.priority === 5 ? "(□ pinzatrice)" : ""}`} htmlFor="priority">
            <input
              id="priority"
              type="range"
              min={0}
              max={5}
              step={1}
              value={form.priority}
              onChange={(e) => update("priority", parseInt(e.target.value, 10))}
              className="w-full accent-red"
            />
          </Field>

          <hr className="border-ink/20" />

          {/* Valori disambiguati */}
          <div
            className="border border-ink/15 p-3 space-y-3"
            style={{ backgroundColor: "rgba(232, 222, 196, 0.5)" }}
          >
            <div className="text-[11px] uppercase tracking-wider text-ink-soft" style={{ fontFamily: "var(--font-display)" }}>
              Valori disambiguati v2.2
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="f₥ Fantamilioni spesi (integer)" htmlFor="fmil_spesi" error={errors.fmil_spesi}>
                <input
                  id="fmil_spesi"
                  type="number"
                  min={0}
                  step={1}
                  value={form.fmil_spesi}
                  onChange={(e) => update("fmil_spesi", e.target.value)}
                  className={`tacc-input ${errors.fmil_spesi ? "tacc-input--error" : ""}`}
                  placeholder="Es. 78"
                />
              </Field>

              <Field label="FVM FantaValoreMedio (integer)" htmlFor="fvm" error={errors.fvm}>
                <input
                  id="fvm"
                  type="number"
                  min={0}
                  step={1}
                  value={form.fvm}
                  onChange={(e) => update("fvm", e.target.value)}
                  className={`tacc-input ${errors.fvm ? "tacc-input--error" : ""}`}
                  placeholder="Es. 32"
                />
              </Field>

              <Field label="M Med (0-10, media pura)" htmlFor="med" error={errors.med}>
                <input
                  id="med"
                  type="number"
                  min={0}
                  max={10}
                  step={0.01}
                  value={form.med}
                  onChange={(e) => update("med", e.target.value)}
                  className={`tacc-input ${errors.med ? "tacc-input--error" : ""}`}
                  placeholder="Es. 6.05"
                />
              </Field>

              <Field label="MV MedV (0-10, FantaMedia)" htmlFor="medv" error={errors.medv}>
                <input
                  id="medv"
                  type="number"
                  min={0}
                  max={10}
                  step={0.01}
                  value={form.medv}
                  onChange={(e) => update("medv", e.target.value)}
                  className={`tacc-input ${errors.medv ? "tacc-input--error" : ""}`}
                  placeholder="Es. 6.85"
                />
              </Field>
            </div>
          </div>

          {submitError && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore:</strong> {submitError}
            </div>
          )}
        </div>

        <footer className="tacc-modal-footer sticky bottom-0">
          <button type="button" onClick={onClose} className="tacc-btn">
            Annulla
          </button>
          <button type="submit" disabled={submitting} className="tacc-btn tacc-btn--primary">
            {submitting ? "Salvataggio…" : player ? "Salva modifiche" : "Crea giocatore"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function labelForRole(r: PosFanta): string {
  return { P: "Portiere", D: "Difensore", C: "Centrocampista", A: "Attaccante" }[r];
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-xs uppercase tracking-wider text-ink-soft mb-1"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {label}
      </label>
      {children}
      {error && (
        <div className="mt-1 text-xs text-red" style={{ fontFamily: "var(--font-body)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
