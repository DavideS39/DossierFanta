/**
 * AggiornamentiView — schermata M3 "Aggiornamenti listone" (Cap.7 design doc v2.5).
 *
 * Mostra lo stato dell'auto-fetch del listone Serie A:
 *   - Versione corrente applicata (tag + data, da cache/last_applied_tag.txt)
 *   - Versione disponibile (latest release dal repo dossier-fanta-data via
 *     GitHub API, https://api.github.com/repos/{owner}/dossier-fanta-data/releases/latest)
 *   - Stato: "aggiornato" / "aggiornamento disponibile" / "impossibile contattare il server"
 *   - Pulsante "Aggiorna ora": scarica players.json + anteprima diff via
 *     ImportPreview + "Applica"
 *   - Pulsante "Fallback: scarica da fantacalcio.it": triggera lo scraper
 *     Rust embedded (~10-15s)
 *   - Log degli ultimi 5 aggiornamenti (data, giocatori creati/archiviati/aggiornati/ripristinati)
 *
 * Tutto il flusso HTTP è in Rust (reqwest) — il frontend non fa fetch diretto
 * (vincolo hard M3 #8: niente fetch/axios in src/).
 */

import { useEffect, useState } from "react";
import { api } from "@/api/tauri";
import { ImportPreview } from "@/components/ImportPreview";
import type {
  AutoFetchStatus,
  ImportPreview as ImportPreviewType,
  ImportSummary,
  ListoneData,
  ListoneVersionInfo,
} from "@/types/player";

type ConnState = "checking" | "ok" | "unreachable";
type FetchMode = "idle" | "downloading" | "previewing" | "applying" | "applied" | "error";

interface Props {
  onClose: () => void;
  onApplied?: () => void;
}

export function AggiornamentiView({ onClose, onApplied }: Props) {
  const [status, setStatus] = useState<AutoFetchStatus | null>(null);
  const [latest, setLatest] = useState<ListoneVersionInfo | null>(null);
  const [connState, setConnState] = useState<ConnState>("checking");
  const [mode, setMode] = useState<FetchMode>("idle");
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<ListoneData | null>(null);
  const [preview, setPreview] = useState<ImportPreviewType | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [progressLabel, setProgressLabel] = useState<string>("");

  // Carica stato cache + check latest release
  useEffect(() => {
    void refreshStatus();
    void checkLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshStatus() {
    try {
      const s = await api.getAutofetchStatus();
      setStatus(s);
    } catch (e) {
      console.warn("getAutofetchStatus failed:", e);
    }
  }

  async function checkLatest() {
    setConnState("checking");
    setError(null);
    try {
      const v = await api.checkLatestListoneVersion();
      setLatest(v);
      setConnState("ok");
    } catch (e) {
      console.warn("checkLatestListoneVersion failed:", e);
      setConnState("unreachable");
    }
  }

  // True se il tag in cache corrisponde all'ultimo release disponibile
  const isUpToDate =
    status && latest && status.last_applied_tag === latest.tag;

  async function handleAggiornaOra() {
    if (!latest) return;
    setMode("downloading");
    setProgressLabel("Scarico players.json…");
    setError(null);
    try {
      const data = await api.downloadListone(latest.asset_url, latest.tag);
      setDownloaded(data);
      setProgressLabel("Calcolo diff…");
      // Anteprima via previewImportListone: serializza le entries come JSON
      const json = JSON.stringify(data.entries);
      const p = await api.previewImportListone(json);
      setPreview(p);
      setMode("previewing");
    } catch (e) {
      console.error("download/preview failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      setMode("error");
    }
  }

  async function handleApplicaDiff() {
    if (!downloaded) return;
    setMode("applying");
    setError(null);
    try {
      const s = await api.applyAutoFetch(downloaded);
      setSummary(s);
      setMode("applied");
      await refreshStatus();
      onApplied?.();
    } catch (e) {
      console.error("applyAutoFetch failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      setMode("error");
    }
  }

  async function handleFallback() {
    setMode("downloading");
    setProgressLabel("Scraper inline: scarico fantacalcio.it… (~10-15s)");
    setError(null);
    try {
      const data = await api.scrapeListoneInline();
      setDownloaded(data);
      setProgressLabel("Calcolo diff…");
      const json = JSON.stringify(data.entries);
      const p = await api.previewImportListone(json);
      setPreview(p);
      setMode("previewing");
    } catch (e) {
      console.error("scrapeListoneInline failed:", e);
      setError(e instanceof Error ? e.message : String(e));
      setMode("error");
    }
  }

  function handleReset() {
    setMode("idle");
    setDownloaded(null);
    setPreview(null);
    setSummary(null);
    setError(null);
    setProgressLabel("");
  }

  // ------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------

  const statusBadge = (() => {
    if (connState === "checking") {
      return (
        <span className="df-chip" style={{ color: "var(--ink-soft)" }}>
          … verifica server
        </span>
      );
    }
    if (connState === "unreachable") {
      return (
        <span className="df-chip" style={{ color: "var(--red)" }}>
          impossibile contattare il server
        </span>
      );
    }
    if (isUpToDate) {
      return (
        <span className="df-chip" style={{ color: "var(--green)" }}>
          aggiornato
        </span>
      );
    }
    return (
      <span className="df-chip" style={{ color: "var(--amber)" }}>
        aggiornamento disponibile
      </span>
    );
  })();

  return (
    <div className="tacc-modal-backdrop" style={{ zIndex: 60 }} onClick={onClose}>
      <div
        className="tacc-modal tacc-modal--v23"
        style={{ maxWidth: "52rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="aggiornamenti-title"
      >
        <header className="tacc-modal-header">
          <h2 id="aggiornamenti-title" className="text-lg font-bold">
            » Aggiornamenti listone · auto-fetch
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
          {/* === Stato corrente vs disponibile === */}
          <div className="grid grid-cols-2 gap-3">
            <div className="border-2 border-ink/30 bg-paper p-3">
              <div
                className="text-[10px] uppercase tracking-wider text-ink-soft mb-1"
                style={{ fontFamily: "var(--font-display)" }}
              >
                Versione corrente (applicata)
              </div>
              {status && status.last_applied_tag ? (
                <>
                  <div
                    className="text-base font-bold"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {status.last_applied_tag}
                  </div>
                  <div
                    className="text-xs text-ink-soft mt-1"
                    style={{ fontFamily: "var(--font-body)" }}
                  >
                    cache: {status.cache_path}
                  </div>
                </>
              ) : (
                <div
                  className="text-base text-ink-soft"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  mai applicato
                </div>
              )}
            </div>

            <div className="border-2 border-ink/30 bg-paper p-3">
              <div
                className="text-[10px] uppercase tracking-wider text-ink-soft mb-1 flex justify-between items-center"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <span>Versione disponibile (GitHub)</span>
                {statusBadge}
              </div>
              {connState === "ok" && latest ? (
                <>
                  <div
                    className="text-base font-bold"
                    style={{ fontFamily: "var(--font-display)" }}
                  >
                    {latest.tag}
                  </div>
                  <div
                    className="text-xs text-ink-soft mt-1"
                    style={{ fontFamily: "var(--font-body)" }}
                  >
                    pubblicata: {latest.published_at}
                    <br />
                    asset: {(latest.asset_size_bytes / 1024).toFixed(0)} KB
                  </div>
                </>
              ) : connState === "checking" ? (
                <div
                  className="text-base text-ink-soft"
                  style={{ fontFamily: "var(--font-body)" }}
                >
                  …verifica in corso
                </div>
              ) : (
                <div
                  className="text-base"
                  style={{ fontFamily: "var(--font-body)", color: "var(--red)" }}
                >
                  GitHub irraggiungibile.
                  <br />
                  <span className="text-xs text-ink-soft">
                    Possibile causa: assenza rete o rate limit (60 req/h).
                    <br />
                    Usa il fallback inline qui sotto.
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* === Azioni === */}
          <div className="border-2 border-ink/30 bg-paper p-3 space-y-2">
            <div
              className="text-[10px] uppercase tracking-wider text-ink-soft mb-1"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Azioni
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleAggiornaOra}
                disabled={!latest || mode === "downloading" || mode === "applying"}
                className="tacc-btn tacc-btn--primary"
              >
                » Aggiorna ora
              </button>
              <button
                type="button"
                onClick={handleFallback}
                disabled={mode === "downloading" || mode === "applying"}
                className="tacc-btn"
                title="Fallback: scarica direttamente da fantacalcio.it se GitHub è irraggiungibile (~10-15s)"
              >
                ⚑ Fallback: scarica da fantacalcio.it
              </button>
              <button
                type="button"
                onClick={() => void checkLatest()}
                disabled={connState === "checking"}
                className="tacc-btn"
                title="Ricontrolla la versione disponibile"
              >
                ↻ Ricontrolla
              </button>
            </div>

            {mode === "downloading" && (
              <div
                className="text-xs mt-2"
                style={{ fontFamily: "var(--font-body)", color: "var(--ink-soft)" }}
              >
                <span
                  className="inline-block w-3 h-3 border-2 border-ink/30 border-t-ink rounded-full animate-spin mr-2 align-middle"
                  style={{ borderTopColor: "var(--ink)" }}
                />
                {progressLabel}
              </div>
            )}

            {error && (
              <div
                className="text-xs mt-2 p-2 border"
                style={{
                  fontFamily: "var(--font-body)",
                  color: "var(--red)",
                  borderColor: "var(--red)",
                  backgroundColor: "rgba(180, 50, 50, 0.05)",
                }}
              >
                <strong>Errore:</strong> {error}
              </div>
            )}

            {summary && mode === "applied" && (
              <div
                className="text-xs mt-2 p-2 border"
                style={{
                  fontFamily: "var(--font-body)",
                  color: "var(--green)",
                  borderColor: "var(--green)",
                  backgroundColor: "rgba(60, 130, 60, 0.05)",
                }}
              >
                <strong>Aggiornamento applicato:</strong> +{summary.created} creati,{" "}
                −{summary.archived} archiviati, ~{summary.updated} aggiornati,{" "}
                {summary.restored} ripristinati (su {summary.total_listone} totali).
              </div>
            )}
          </div>

          {/* === Log ultimi 5 aggiornamenti === */}
          <div className="border-2 border-ink/30 bg-paper p-3">
            <div
              className="text-[10px] uppercase tracking-wider text-ink-soft mb-2"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Log ultimi 5 aggiornamenti
            </div>
            {status && status.update_log.length > 0 ? (
              <div className="space-y-1">
                {status.update_log.map((e, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-5 gap-2 text-xs"
                    style={{
                      fontFamily: "var(--font-body)",
                      padding: "0.25rem 0",
                      borderTop: i === 0 ? "none" : "1px solid rgba(43,27,18,0.06)",
                    }}
                  >
                    <div style={{ color: "var(--ink-soft)" }}>
                      {new Date(e.applied_at).toLocaleString()}
                    </div>
                    <div
                      style={{
                        color: e.source === "fallback" ? "var(--amber)" : "var(--blue)",
                      }}
                      title={e.tag}
                    >
                      {e.source === "fallback" ? "fallback" : "github"} · {e.tag.slice(0, 30)}
                    </div>
                    <div style={{ color: "var(--green)" }}>+{e.created} creati</div>
                    <div style={{ color: "var(--red)" }}>−{e.archived} archiv.</div>
                    <div style={{ color: "var(--blue)" }}>~{e.updated} agg.</div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="text-xs text-ink-soft"
                style={{ fontFamily: "var(--font-body)" }}
              >
                » Nessun aggiornamento applicato finora. Clicca "Aggiorna ora"
                per scaricare l'ultima versione disponibile dal repo
                dossier-fanta-data.
              </div>
            )}
          </div>

          {/* === Note informative === */}
          <div
            className="text-xs text-ink-soft p-3 border border-ink/15"
            style={{ fontFamily: "var(--font-body)", backgroundColor: "rgba(43,27,18,0.02)" }}
          >
            <strong>Come funziona:</strong> ogni notte alle 03:00 CET il workflow
            GitHub Actions del repo{" "}
            <code>dossier-fanta-data</code> scarica fantacalcio.it, parsa l'HTML,
            valida 400-800 giocatori + 20 squadre, e pubblica <code>players.json</code>{" "}
            come release. All'avvio l'app interpella{" "}
            <code>api.github.com/.../releases/latest</code>, confronta il tag con
            <code> cache/last_applied_tag.txt</code> e mostra questo toast. Click →
            anteprima diff → applica. L'archiviazione è irreversibile senza restore
            esplicito dalla vista Archivio.
          </div>
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onClose} className="tacc-btn">
            Chiudi
          </button>
          {(mode === "applied" || mode === "error") && (
            <button
              type="button"
              onClick={handleReset}
              className="tacc-btn tacc-btn--primary"
            >
              » Reset
            </button>
          )}
        </footer>
      </div>

      {/* === Anteprima diff (riusa ImportPreview M2.1) === */}
      {preview && (
        <ImportPreview
          preview={preview}
          applying={mode === "applying"}
          onApply={handleApplicaDiff}
          onCancel={() => {
            setPreview(null);
            setDownloaded(null);
            setMode("idle");
          }}
        />
      )}
    </div>
  );
}
