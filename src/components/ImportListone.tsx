/**
 * ImportListone — schermata import listone Serie A (M2 + M2.1 B7).
 *
 * Flusso UX M2.1:
 * 1. L'utente carica un file JSON via HTML file input.
 * 2. Anteprima delle righe caricate (10 prime righe, formato JSON parsed).
 * 3. Click "Anteprima modifiche" → chiama api.previewImportListone(json)
 *    che ritorna ImportPreview con 4 liste (created/archived/updated/restored).
 * 4. Modale ImportPreview mostra il diff. Click "Applica" → chiama il vero
 *    api.importListone(json) che applica le modifiche. Click "Annulla" →
 *    nessuna modifica applicata.
 * 5. Mostra il summary post-import.
 *
 * Vincoli:
 * - L'import è manuale in M2.1 (file picker). L'auto-fetch via GitHub Actions
 *   è M3 e NON va implementato qui.
 * - Il JSON atteso è un array di oggetti {name, team?, pos_fanta?, fvm?}.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/api/tauri";
import type { ImportPreview, ImportSummary, ListoneEntry } from "@/types/player";
import { useDbStore } from "@/stores/useDbStore";
import { ImportPreview as ImportPreviewModal } from "./ImportPreview";

interface Props {
  onClose: () => void;
  /** Callback opzionale dopo import riuscito (per refresh viste). */
  onImported?: () => void;
}

export function ImportListone({ onClose, onImported }: Props) {
  const [rawJson, setRawJson] = useState<string>("");
  const [entries, setEntries] = useState<ListoneEntry[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeDb = useDbStore((s) => s.getActiveDatabase?.());

  useEffect(() => {
    if (!rawJson) {
      setEntries([]);
      setParseError(null);
      return;
    }
    try {
      const parsed = JSON.parse(rawJson);
      if (!Array.isArray(parsed)) {
        throw new Error("Il JSON deve essere un array");
      }
      const validated: ListoneEntry[] = parsed.map((p: unknown, i: number) => {
        if (typeof p !== "object" || p === null) {
          throw new Error(`riga ${i + 1}: non è un oggetto`);
        }
        const obj = p as Record<string, unknown>;
        if (typeof obj.name !== "string" || !obj.name.trim()) {
          throw new Error(`riga ${i + 1}: name mancante o non stringa`);
        }
        return {
          name: obj.name,
          team: typeof obj.team === "string" ? obj.team : null,
          pos_fanta: typeof obj.pos_fanta === "string" ? (obj.pos_fanta as ListoneEntry["pos_fanta"]) : null,
          fvm: typeof obj.fvm === "number" ? obj.fvm : null,
        };
      });
      setEntries(validated);
      setParseError(null);
    } catch (e) {
      setEntries([]);
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }, [rawJson]);

  const handleFile = (file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRawJson(typeof reader.result === "string" ? reader.result : "");
      setSummary(null);
      setImportError(null);
      setPreview(null);
      setPreviewError(null);
    };
    reader.onerror = () => setParseError("Errore lettura file");
    reader.readAsText(file);
  };

  // FIX A5 (B7): anteprima modifiche prima di applicare
  const handlePreview = async () => {
    if (!rawJson) return;
    setApplying(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const p = await api.previewImportListone(rawJson);
      setPreview(p);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const handleApplyFromPreview = async () => {
    if (!rawJson) return;
    setApplying(true);
    setImportError(null);
    setSummary(null);
    try {
      const s = await api.importListone(rawJson);
      setSummary(s);
      setPreview(null);
      onImported?.();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const handleLoadSample = () => {
    const sample: ListoneEntry[] = [
      { name: "Marcus Thuram", team: "Inter", pos_fanta: "A", fvm: 32 },
      { name: "Lautaro Martinez", team: "Inter", pos_fanta: "A", fvm: 38 },
      { name: "Khvicha Kvaratskhelia", team: "Napoli", pos_fanta: "A", fvm: 35 },
      { name: "Sandro Tonali", team: "Newcastle", pos_fanta: "C", fvm: 28 },
    ];
    setRawJson(JSON.stringify(sample, null, 2));
    setSummary(null);
    setImportError(null);
    setPreview(null);
    setPreviewError(null);
  };

  return (
    <div className="tacc-modal-backdrop" onClick={onClose}>
      <div
        className="tacc-modal tacc-modal--v23"
        style={{ maxWidth: "48rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="imp-listone-title"
      >
        <header className="tacc-modal-header">
          <h2 id="imp-listone-title" className="text-lg font-bold">
            » Import listone Serie A
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
          <p className="text-sm text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
            Carica un file JSON con il listone Serie A. Dopo aver caricato il file,
            clicca <strong>Anteprima modifiche</strong> per vedere cosa succederebbe
            (creati / aggiornati / archiviati / ripristinati) prima di applicare.
            Solo dopo conferma verrà effettuato l'import reale sul DB attivo
            {activeDb && <strong> «{activeDb.name}»</strong>}.
          </p>

          {/* File picker + sample + preview button */}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="tacc-btn"
            >
              » Carica file JSON
            </button>
            <button
              type="button"
              onClick={handleLoadSample}
              className="tacc-btn"
              title="Carica un listone di esempio per test"
            >
              ⚑ Carica esempio
            </button>
            {rawJson && (
              <span className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                {entries.length} righe caricate
              </span>
            )}
          </div>

          {/* Parse error */}
          {parseError && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>JSON non valido:</strong> {parseError}
            </div>
          )}

          {/* Anteprima entries caricate (formato listone, non diff) */}
          {entries.length > 0 && !preview && !summary && (
            <div className="border border-ink/30 bg-paper">
              <div
                className="grid grid-cols-12 gap-2 px-3 py-2 bg-ink/10 text-[11px] uppercase tracking-wider text-ink-soft"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <div className="col-span-4">Nome</div>
                <div className="col-span-4">Squadra</div>
                <div className="col-span-2">Ruolo</div>
                <div className="col-span-2 text-right">FVM</div>
              </div>
              {entries.slice(0, 10).map((e, i) => (
                <div
                  key={i}
                  className="grid grid-cols-12 gap-2 px-3 py-1.5 border-t border-ink/10 text-xs"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  <div className="col-span-4 truncate text-ink">{e.name}</div>
                  <div className="col-span-4 truncate text-ink-soft">{e.team ?? "—"}</div>
                  <div className="col-span-2 text-ink-soft">{e.pos_fanta ?? "—"}</div>
                  <div className="col-span-2 text-right text-ink">{e.fvm ?? "—"}</div>
                </div>
              ))}
              {entries.length > 10 && (
                <div className="px-3 py-2 text-center text-xs text-ink-soft border-t border-ink/10" style={{ fontFamily: "var(--font-body)" }}>
                  … e altre {entries.length - 10} righe
                </div>
              )}
            </div>
          )}

          {/* Preview error */}
          {previewError && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore anteprima:</strong> {previewError}
            </div>
          )}

          {/* Import error */}
          {importError && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore import:</strong> {importError}
            </div>
          )}

          {/* Summary post-import */}
          {summary && (
            <div className="border-2 border-green bg-green/10 p-3 space-y-2">
              <div className="text-sm font-bold text-green" style={{ fontFamily: "var(--font-display)" }}>
                ✓ Import completato
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs" style={{ fontFamily: "var(--font-body)" }}>
                <SummaryRow label="Totali nel listone" value={summary.total_listone} />
                <SummaryRow label="Creati (da_fare)" value={summary.created} />
                <SummaryRow label="Aggiornati (FVM)" value={summary.updated} />
                <SummaryRow label="Archiviati" value={summary.archived} />
                <SummaryRow label="Ripristinati" value={summary.restored} />
                <SummaryRow label="Errori" value={summary.errors} />
              </div>
              {summary.error_messages.length > 0 && (
                <details className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                  <summary className="cursor-pointer">Dettagli errori ({summary.error_messages.length})</summary>
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {summary.error_messages.slice(0, 20).map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onClose} className="tacc-btn">
            {summary ? "Chiudi" : "Annulla"}
          </button>
          {/* FIX A5 (B7): "Anteprima modifiche" richiama preview_import_listone.
              Disabilitato se ci sono parse error o se è già stato applicato. */}
          {!summary && (
            <button
              type="button"
              onClick={handlePreview}
              disabled={!rawJson || applying || !!parseError}
              className="tacc-btn"
              title="Mostra cosa verrebbe creato/aggiornato/archiviato/ripristinato"
            >
              {applying && !preview ? "Calcolo…" : "? Anteprima modifiche"}
            </button>
          )}
        </footer>
      </div>

      {/* Modale di anteprima diff (rendered over the parent modal) */}
      {preview && (
        <ImportPreviewModal
          preview={preview}
          onApply={handleApplyFromPreview}
          onCancel={() => setPreview(null)}
          applying={applying}
        />
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="uppercase tracking-wider text-ink-soft">{label}:</span>
      <span className="font-bold text-ink">{value}</span>
    </div>
  );
}
