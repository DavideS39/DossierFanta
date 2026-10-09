/**
 * ImportPreview — modale di anteprima diff import listone (M2.1, FIX A5/B7).
 *
 * Mostra 4 liste (created/archived/updated/restored) con nomi e dettagli
 * prima di applicare l'import. Solo dopo conferma ("Applica") il frontend
 * chiama il vero `api.importListone(json)`.
 *
 * Props:
 *  - `preview`: ImportPreview ritornato da api.previewImportListone
 *  - `onApply`: callback quando l'utente conferma
 *  - `onCancel`: callback quando l'utente annulla
 *  - `applying`: stato busy del parent
 */

import type { ImportPreview } from "@/types/player";

interface Props {
  preview: ImportPreview;
  onApply: () => void;
  onCancel: () => void;
  applying: boolean;
}

export function ImportPreview({ preview, onApply, onCancel, applying }: Props) {
  const totalOps =
    preview.created.length +
    preview.archived.length +
    preview.updated.length +
    preview.restored.length;

  return (
    <div className="tacc-modal-backdrop" style={{ zIndex: 55 }} onClick={onCancel}>
      <div
        className="tacc-modal tacc-modal--v23"
        style={{ maxWidth: "56rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="imp-preview-title"
      >
        <header className="tacc-modal-header">
          <h2 id="imp-preview-title" className="text-lg font-bold">
            » Anteprima import — {preview.total_listone} righe, {totalOps} operazioni
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-paper/70 hover:text-paper text-xl leading-none"
            aria-label="Chiudi"
          >
            ×
          </button>
        </header>

        <div className="p-5 space-y-4 tacc-bg">
          <p className="text-sm text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
            Anteprima delle modifiche che verranno applicate al DB
            <strong> «{preview.active_db_name}»</strong>. Conferma per procedere,
            annulla per non applicare nulla.
          </p>

          {/* Summary box */}
          <div
            className="border-2 border-ink/40 bg-paper p-3 grid grid-cols-4 gap-2 text-center"
            style={{ fontFamily: "var(--font-display)" }}
          >
            <div>
              <div className="text-2xl text-green">{preview.created.length}</div>
              <div className="text-[10px] uppercase tracking-wider text-ink-soft">Creati</div>
            </div>
            <div>
              <div className="text-2xl text-blue">{preview.updated.length}</div>
              <div className="text-[10px] uppercase tracking-wider text-ink-soft">Aggiornati</div>
            </div>
            <div>
              <div className="text-2xl text-red">{preview.archived.length}</div>
              <div className="text-[10px] uppercase tracking-wider text-ink-soft">Archiviati</div>
            </div>
            <div>
              <div className="text-2xl text-amber">{preview.restored.length}</div>
              <div className="text-[10px] uppercase tracking-wider text-ink-soft">Ripristinati</div>
            </div>
          </div>

          {/* Created list */}
          {preview.created.length > 0 && (
            <PreviewList
              title="Creati (nuovi in rosa come 'da_fare')"
              variant="green"
              headers={["Nome", "Squadra", "Ruolo", "FVM"]}
              rows={preview.created.map((c) => [
                c.name,
                c.team ?? "—",
                c.pos_fanta ?? "—",
                c.fvm !== null ? String(c.fvm) : "—",
              ])}
            />
          )}

          {/* Updated list (con diff) */}
          {preview.updated.length > 0 && (
            <PreviewList
              title="Aggiornati (FVM modificato)"
              variant="blue"
              headers={["Nome", "Campo", "Vecchio", "Nuovo"]}
              rows={preview.updated.map((u) => [
                u.name,
                u.field_changed,
                String(u.old),
                String(u.new),
              ])}
            />
          )}

          {/* Restored list */}
          {preview.restored.length > 0 && (
            <PreviewList
              title="Ripristinati (tornano dall'archivio)"
              variant="amber"
              headers={["Nome", "Squadra"]}
              rows={preview.restored.map((r) => [r.name, r.team ?? "—"])}
            />
          )}

          {/* Archived list */}
          {preview.archived.length > 0 && (
            <PreviewList
              title="Archiviati (non più nel listone → players_archive con snapshot arricchito)"
              variant="red"
              headers={["Nome", "Squadra", "Motivo"]}
              rows={preview.archived.map((a) => [a.name, a.team ?? "—", a.reason])}
            />
          )}

          {totalOps === 0 && (
            <div
              className="text-center py-8 text-ink-soft"
              style={{ fontFamily: "var(--font-body)", fontSize: "13px" }}
            >
              » Nessuna modifica da applicare. Il listone è già allineato con il DB.
            </div>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onCancel} disabled={applying} className="tacc-btn">
            Annulla
          </button>
          <button
            type="button"
            onClick={onApply}
            disabled={applying || totalOps === 0}
            className="tacc-btn tacc-btn--primary"
          >
            {applying ? "Applicazione…" : `» Applica ${totalOps} modifiche`}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PreviewList({
  title,
  variant,
  headers,
  rows,
}: {
  title: string;
  variant: "green" | "blue" | "red" | "amber";
  headers: string[];
  rows: string[][];
}) {
  const color = {
    green: "var(--green)",
    blue: "var(--blue)",
    red: "var(--red)",
    amber: "var(--amber)",
  }[variant];

  return (
    <div className="border border-ink/30 bg-paper">
      <div
        style={{
          backgroundColor: "rgba(43, 27, 18, 0.06)",
          padding: "0.4rem 0.75rem",
          fontFamily: "var(--font-display)",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color,
          borderBottom: "1px solid rgba(43, 27, 18, 0.15)",
        }}
      >
        {title} ({rows.length})
      </div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
          gap: "0.5rem",
          padding: "0.3rem 0.75rem",
          fontFamily: "var(--font-display)",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-soft)",
          borderBottom: "1px solid rgba(43, 27, 18, 0.1)",
        }}
      >
        {headers.map((h, i) => (
          <div
            key={i}
            style={{ textAlign: i === headers.length - 1 ? "right" : "left" }}
          >
            {h}
          </div>
        ))}
      </div>
      <div style={{ maxHeight: "180px", overflowY: "auto" }}>
        {rows.slice(0, 50).map((row, i) => (
          <div
            key={i}
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${headers.length}, 1fr)`,
              gap: "0.5rem",
              padding: "0.25rem 0.75rem",
              fontFamily: "var(--font-body)",
              fontSize: "11px",
              color: "var(--ink)",
              borderTop: i === 0 ? "none" : "1px solid rgba(43, 27, 18, 0.06)",
            }}
          >
            {row.map((cell, j) => (
              <div
                key={j}
                style={{
                  textAlign: j === headers.length - 1 ? "right" : "left",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {cell}
              </div>
            ))}
          </div>
        ))}
        {rows.length > 50 && (
          <div
            style={{
              padding: "0.35rem 0.75rem",
              fontFamily: "var(--font-body)",
              fontSize: "10px",
              color: "var(--ink-soft)",
              textAlign: "center",
              borderTop: "1px solid rgba(43, 27, 18, 0.06)",
            }}
          >
            … e altre {rows.length - 50} righe
          </div>
        )}
      </div>
    </div>
  );
}
