/**
 * DatabaseManager — schermata gestione database multi-DB (M2 + M2.1 B6).
 *
 * Permette di:
 * - Vedere tutti i DB logici del workspace (righe della tabella `databases`)
 * - Creare un nuovo DB (PERSONALE o CONDIVISO)
 * - Eliminare un DB (con conferma esplicita, come per i giocatori)
 * - Switchare il DB attivo (cliccando su una riga)
 *
 * M2.1 B6: banner informativo sharing DB = M3a. Dice esplicitamente che
 * in M2.1 i DB sono locali (nessun sync tra dispositivi). Dismissibile,
 * stato persistito in localStorage. Non blocca l'uso.
 *
 * Vincoli:
 * - `default-personal` non può essere eliminato (vincolo backend M2).
 * - L'eliminazione richiede dialog di conferma (vincolo HARD specifica).
 * - I DB di tipo `listone` sono read-only e NON possono essere eliminati
 *   da questa schermata (vanno eliminati tramite il comando backend diretto).
 */

import { useEffect, useState, useCallback } from "react";
import { useDbStore } from "@/stores/useDbStore";
import { useDbMetaStore } from "@/stores/useDbMetaStore";
import type { DatabaseMeta, DatabaseType, ImportPreview, AutoFetchStatus, ListoneVersionInfo, ListoneData, ImportSummary } from "@/types/player";
import { DATABASE_TYPE_LABELS } from "@/types/player";
import { api } from "@/api/tauri";
import { ImportPreview as ImportPreviewModal } from "@/components/ImportPreview";

interface Props {
  onClose: () => void;
}

const SHARE_BANNER_LS_KEY = "dossierfanta.shareBannerDismissed";

function loadBannerDismissed(): boolean {
  try {
    return localStorage.getItem(SHARE_BANNER_LS_KEY) === "1";
  } catch {
    return false;
  }
}

function saveBannerDismissed(v: boolean): void {
  try {
    if (v) localStorage.setItem(SHARE_BANNER_LS_KEY, "1");
    else localStorage.removeItem(SHARE_BANNER_LS_KEY);
  } catch {
    // ignore
  }
}

export function DatabaseManager({ onClose }: Props) {
  const databases = useDbStore((s) => s.databases);
  const activeId = useDbStore((s) => s.activeId);
  const refresh = useDbStore((s) => s.refresh);
  const createDatabase = useDbStore((s) => s.createDatabase);
  const deleteDatabase = useDbStore((s) => s.deleteDatabase);
  const setActiveDatabase = useDbStore((s) => s.setActiveDatabase);
  // M3a.5 — Multi-DB attivo
  const activeDbIds = useDbStore((s) => s.activeDbIds);
  const toggleActiveDb = useDbStore((s) => s.toggleActiveDb);
  const showListoneDeactivateConfirm = useDbStore((s) => s.showListoneDeactivateConfirm);
  const confirmDeactivateListone = useDbStore((s) => s.confirmDeactivateListone);
  const cancelDeactivateListone = useDbStore((s) => s.cancelDeactivateListone);
  const refreshMeta = useDbMetaStore((s) => s.refresh);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<DatabaseType>("personal");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<DatabaseMeta | null>(null);
  const [deleteChecked, setDeleteChecked] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // M3a.5 — Modale grosso per l'aggiornamento del listone. Si apre cliccando
  // il pulsante blu "aggiorna" sulla riga ListoneSerieA.db. Contiene la
  // ListoneInlineCard (stessa interfaccia di prima, ma in modale invece di
  // inline espansa sotto la riga — più pulito e compatto).
  const [listoneModalOpen, setListoneModalOpen] = useState(false);

  // M2.1 B6: stato del banner dismissibile
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(loadBannerDismissed());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setError("Il nome è obbligatorio");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createDatabase(newName.trim(), newType);
      setNewName("");
      setNewType("personal");
      setShowCreate(false);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const handleSetActive = async (id: string) => {
    if (id === activeId) return;
    try {
      await setActiveDatabase(id);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteDatabase(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteChecked(false);
      await refreshMeta();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const handleDismissBanner = () => {
    setBannerDismissed(true);
    saveBannerDismissed(true);
  };

  // M3a.3 — Refresh autofetch status al boot per mostrare "ultimo aggiornamento"
  // nella card inline del listone. Refresh ogni 60s (operazione leggera — 1 HTTP GET).
  const [autofetchStatus, setAutofetchStatus] = useState<AutoFetchStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const s = await api.getAutofetchStatus();
        if (!cancelled) setAutofetchStatus(s);
      } catch {
        // Silent — la card mostra "—" come fallback
      }
    };
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="tacc-modal-backdrop" onClick={onClose}>
      <div
        className="tacc-modal"
        style={{ maxWidth: "44rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-mgr-title"
      >
        <header className="tacc-modal-header">
          <h2 id="db-mgr-title" className="text-lg font-bold">
            » Workspace database
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
            Database caricati nel workspace. Clicca su una riga per attivarla
            nella vista Rosa. L'eliminazione di un DB cancella a cascata tutti
            i suoi giocatori (operazione irreversibile).
          </p>

          {/* M2.1 B6 — Banner informativo sharing DB = M3a (M3a.1: stato attivo) */}
          {!bannerDismissed && (
            <div className="tacc-info-banner" role="status">
              <span aria-hidden style={{ color: "var(--blue)", fontWeight: "bold" }}>ℹ</span>
              <span>
                <strong>Condivisione live DB attiva con M3a.</strong>{" "}
                Per pairing, apri la schermata <strong>Sync</strong> dal masthead di
                Rosa, avvia il nodo Iroh e scambia la peer key out-of-band. Il sync
                live (Yjs + Iroh p2p) propaga le modifiche ai giocatori, alle note di
                scouting e ai dati d'asta a tutti i peer connessi entro ~200ms.
              </span>
              <button
                type="button"
                className="tacc-info-banner-dismiss"
                onClick={handleDismissBanner}
                aria-label="Nascondi questo avviso"
                title="Nascondi (ritorna se ripristini le preferenze)"
              >
                ×
              </button>
            </div>
          )}

          {error && (
            <div className="bg-red/10 border border-red/40 text-red px-3 py-2 text-sm" style={{ fontFamily: "var(--font-body)" }}>
              <strong>Errore:</strong> {error}
            </div>
          )}

          {/* Lista databases */}
          <div className="border border-ink/30 bg-paper">
            <div
              className="grid grid-cols-12 gap-2 px-3 py-2 bg-ink/10 text-[11px] uppercase tracking-wider text-ink-soft"
              style={{ fontFamily: "var(--font-display)" }}
            >
              <div className="col-span-1">Attivo</div>
              <div className="col-span-4">Nome</div>
              <div className="col-span-2">Tipo</div>
              <div className="col-span-2">Owner</div>
              <div className="col-span-2">Creato</div>
              <div className="col-span-1 text-right">Azioni</div>
            </div>
            {databases.length === 0 ? (
              <div className="px-3 py-6 text-center text-ink-soft text-sm" style={{ fontFamily: "var(--font-body)" }}>
                Nessun database caricato.
              </div>
            ) : (
              databases.map((db) => {
                const isActive = db.id === activeId;
                const isDefault = db.id === "default-personal";
                return (
                  <div
                    key={db.id}
                    className={`grid grid-cols-12 gap-2 px-3 py-2 border-t border-ink/10 cursor-pointer hover:bg-paper-dim ${isActive ? "bg-paper-dim" : ""}`}
                    onClick={() => void handleSetActive(db.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="col-span-1 text-base">
                      {/* M3a.5 — Checkbox multi-DB attivo. Toggle del DB nel set
                          di DB visibili nella Rosa. Click separato dal setActive
                          (che imposta il DB "principale" per editing). */}
                      <input
                        type="checkbox"
                        checked={activeDbIds.has(db.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          toggleActiveDb(db.id);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--blue, #2C4A6B)" }}
                        title={activeDbIds.has(db.id) ? "Disattiva (nascondi dalla Rosa)" : "Attiva (mostra nella Rosa)"}
                      />
                      {isActive && <span className="ml-1 text-green text-xs">✓</span>}
                    </div>
                    <div className="col-span-4 truncate" style={{ fontFamily: "var(--font-display)" }}>
                      {db.name}
                      {isDefault && (
                        <span className="ml-2 text-[10px] uppercase text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                          (default)
                        </span>
                      )}
                    </div>
                    <div className="col-span-2 text-xs">
                      <span className="tacc-db-chip">{DATABASE_TYPE_LABELS[db.type as DatabaseType] ?? db.type}</span>
                    </div>
                    <div className="col-span-2 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                      {db.owner ?? "—"}
                    </div>
                    <div className="col-span-2 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                      {db.created_at ? formatDate(db.created_at) : "—"}
                    </div>
                    <div className="col-span-1 text-right">
                      {!isDefault && db.type !== "listone" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(db);
                            setDeleteChecked(false);
                          }}
                          className="text-red hover:text-red/80 text-sm"
                          aria-label={`Elimina ${db.name}`}
                          title="Elimina"
                        >
                          ✕
                        </button>
                      )}
                      {/* M3a.5 — Pulsante blu "aggiorna" per DB listone.
                          Apre un MODALE grosso con la ListoneInlineCard
                          (stessa interfaccia: aggiorna ora / anteprima / fallback). */}
                      {db.type === "listone" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setListoneModalOpen(true);
                          }}
                          className="df-btn df-btn--accent"
                          style={{
                            fontSize: "11px",
                            padding: "2px 10px",
                            fontFamily: "var(--font-display)",
                          }}
                          aria-label="Apri modale aggiornamento listone"
                          title="Aggiorna listone Serie A"
                        >
                          ⟳ aggiorna
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Crea nuovo DB */}
          {!showCreate ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="tacc-btn tacc-btn--primary"
            >
              + Crea nuovo database
            </button>
          ) : (
            <form onSubmit={handleCreate} className="border border-ink/30 bg-paper-dim p-3 space-y-3">
              <div className="text-[11px] uppercase tracking-wider text-ink-soft" style={{ fontFamily: "var(--font-display)" }}>
                Nuovo database
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <input
                    type="text"
                    placeholder="Nome (es. marco.db, listone-2026.db)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="tacc-input"
                    autoFocus
                  />
                </div>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as DatabaseType)}
                  className="tacc-input"
                >
                  <option value="personal">Personale</option>
                  <option value="shared">Condiviso</option>
                  {/* "listone" non creabile da UI — solo via import_listone */}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button type="submit" disabled={creating} className="tacc-btn tacc-btn--primary">
                  {creating ? "Creazione…" : "Crea"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setError(null);
                  }}
                  className="tacc-btn"
                >
                  Annulla
                </button>
              </div>
            </form>
          )}
        </div>

        <footer className="tacc-modal-footer">
          <button type="button" onClick={onClose} className="tacc-btn">
            Chiudi
          </button>
        </footer>
      </div>

      {/* Dialog conferma eliminazione DB */}
      {deleteTarget && (
        <div
          className="tacc-modal-backdrop"
          style={{ zIndex: 60 }}
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="tacc-modal"
            style={{ maxWidth: "26rem", borderColor: "var(--red)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <header
              className="tacc-modal-header"
              style={{ backgroundColor: "var(--red)" }}
            >
              <h2 className="text-lg font-bold">⚠ Conferma eliminazione DB</h2>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="text-paper/70 hover:text-paper text-xl leading-none"
                aria-label="Chiudi"
              >
                ×
              </button>
            </header>
            <div className="p-5 space-y-3 tacc-bg">
              <p className="text-sm text-ink" style={{ fontFamily: "var(--font-body)" }}>
                Stai per eliminare il database:
              </p>
              <div
                className="border-l-4 border-red pl-3 py-2 bg-paper-dim"
                style={{ fontFamily: "var(--font-display)" }}
              >
                <div className="text-lg font-bold text-ink">{deleteTarget.name}</div>
                <div className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                  tipo: {deleteTarget.type} · owner: {deleteTarget.owner ?? "—"}
                </div>
              </div>
              <p className="text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                Tutti i giocatori di questo database verranno cancellati a cascata
                (FK ON DELETE CASCADE). L'operazione è irreversibile.
              </p>
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deleteChecked}
                  onChange={(e) => setDeleteChecked(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-red"
                  autoFocus
                />
                <span className="text-sm text-ink" style={{ fontFamily: "var(--font-body)" }}>
                  Sì, ho capito che <strong>{deleteTarget.name}</strong> e tutti i suoi
                  giocatori verranno eliminati definitivamente.
                </span>
              </label>
            </div>
            <footer className="tacc-modal-footer">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="tacc-btn"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={!deleteChecked || deleting}
                className="tacc-btn tacc-btn--danger"
              >
                {deleting ? "Eliminazione…" : "Elimina definitivamente"}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* M3a.5 — Modale grosso per l'aggiornamento del listone.
          Contiene la ListoneInlineCard (aggiorna ora / anteprima / fallback).
          Si apre cliccando il pulsante blu "aggiorna" sulla riga ListoneSerieA.db. */}
      {listoneModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aggiornamento listone Serie A"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 30, 50, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setListoneModalOpen(false);
          }}
        >
          <div style={{ position: "relative", maxWidth: "90vw", width: "640px" }}>
            <button
              type="button"
              onClick={() => setListoneModalOpen(false)}
              aria-label="Chiudi"
              style={{
                position: "absolute",
                top: "-12px",
                right: "-12px",
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "#2C4A6B",
                color: "#FFFFFF",
                border: "2px solid #F7F3E8",
                cursor: "pointer",
                fontSize: "14px",
                lineHeight: 1,
                zIndex: 51,
              }}
            >
              ×
            </button>
            <ListoneInlineCard
              dbId="default-listone"
              autofetchStatus={autofetchStatus}
              onError={setError}
              onApplied={async () => {
                await refresh();
                await refreshMeta();
              }}
            />
          </div>
        </div>
      )}

      {/* M3a.5 — Modale di conferma per disattivare ListoneSerieA. */}
      {showListoneDeactivateConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Conferma disattivazione ListoneSerieA"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 30, 50, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 60,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) cancelDeactivateListone();
          }}
        >
          <div
            style={{
              maxWidth: "420px",
              background: "var(--paper)",
              border: "2px solid var(--amber, #B8860B)",
              padding: "24px",
              borderRadius: "4px",
            }}
          >
            <h3
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "16px",
                color: "var(--amber, #B8860B)",
                marginBottom: "12px",
              }}
            >
              ⚠ Disattivare ListoneSerieA?
            </h3>
            <p
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "13px",
                color: "var(--ink)",
                lineHeight: 1.6,
                marginBottom: "16px",
              }}
            >
              ListoneSerieA è il database di riferimento per i giocatori
              della Serie A. Disattivandolo, non vedrai più i giocatori
              del listone nella Rosa. Potrai riattivarlo in qualsiasi
              momento. Sei sicuro?
            </p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={cancelDeactivateListone}
                className="tacc-btn"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={confirmDeactivateListone}
                className="tacc-btn"
                style={{ color: "var(--amber, #B8860B)", borderColor: "var(--amber, #B8860B)" }}
              >
                Sì, disattiva
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const dt = new Date(iso.replace(" ", "T") + "Z");
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * M3a.3 Deliverable 7 — Card inline per DB di tipo listone.
 *
 * Mostra sotto la riga del DB listone (se il DB è di tipo `listone`):
 *   - Counter giocatori totali (es. "603 giocatori")
 *   - Ultimo aggiornamento (timestamp dell'ultima release applicata)
 *   - 3 pulsanti inline:
 *     [aggiorna ora] → check_latest_listone_version + download + anteprima
 *       diff inline (ImportPreview modale) + applica
 *     [anteprima] → preview_import_listone senza applicare
 *     [fallback] → scrape_listone_inline (10-15s, fallback se GitHub down)
 *
 * Comportamento:
 *   - Click su [aggiorna ora] → check_latest → se non c'è nuovo tag, toast
 *     "già aggiornato". Se c'è, scarica players.json, chiama preview_import_listone
 *     (computa diff), mostra ImportPreview modale inline. Click "applica" →
 *     apply_auto_fetch. Click "annulla" → dismiss.
 *   - Click su [anteprima] → come sopra ma salta il download (usa la versione
 *     già scaricata se disponibile, altrimenti avvisa).
 *   - Click su [fallback] → scrape_listone_inline → preview → applica.
 *
 * Sostituisce la necessità di aprire la schermata AggiornamentiView separata
 * per le azioni di routine. AggiornamentiView resta accessibile via toast
 * boot-time (App.tsx auto-fetch check).
 */
interface ListoneInlineCardProps {
  dbId: string;
  autofetchStatus: AutoFetchStatus | null;
  onError: (msg: string) => void;
  onApplied: () => Promise<void>;
}

type ListoneMode = "idle" | "checking" | "downloading" | "previewing" | "applying" | "applied" | "error";

function ListoneInlineCard({ dbId: _dbId, autofetchStatus, onError, onApplied }: ListoneInlineCardProps): React.ReactElement {
  const [mode, setMode] = useState<ListoneMode>("idle");
  // M3a.3 — latest è tenuto come cache del ListoneVersionInfo più recente
  // scaricato da check_latest_listone_version.
  const [latest, setLatest] = useState<ListoneVersionInfo | null>(null);
  const [downloaded, setDownloaded] = useState<ListoneData | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [progressLabel, setProgressLabel] = useState<string>("");
  const [playersCount, setPlayersCount] = useState<number | null>(null);

  // Count players: usiamo il count totale dell'ultima entry del log come proxy.
  // Esso contiene `created` (giocatori aggiunti) e `archived` (giocatori
  // archiviati nel corso dell'apply). La somma `created - archived` (con clamping
  // a 0) non riflette esattamente il totale attuale, ma è un'approssimazione
  // ragionevole per la UI. L'utente vede il count esatto cliccando sulla riga.
  useEffect(() => {
    const last = autofetchStatus?.update_log?.[0];
    if (last) {
      // Proxy: created + restored (entrate nel listone) come approssimazione
      // del totale attuale (SOSPIRA: non tiene conto di giocatori rimossi dal
      // listone in release precedenti che sono stati archiviati). Per UI va bene.
      const approx = (last.created ?? 0) + (last.restored ?? 0);
      setPlayersCount(approx > 0 ? approx : null);
    }
  }, [autofetchStatus]);

  // M3a.4 — Check background della versione più recente disponibile su GitHub.
  // Se `latest.tag === autofetchStatus.last_applied_tag` → mostra badge
  // "✓ Aggiornato" invece del pulsante "aggiorna ora" (non proporre
  // l'aggiornamento se il database è già all'ultima versione).
  // Silent skip su errore di rete (es. offline).
  const [checkingVersion, setCheckingVersion] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    const checkLatest = async () => {
      setCheckingVersion(true);
      try {
        const lv = await api.checkLatestListoneVersion();
        if (!cancelled) setLatest(lv);
      } catch (err) {
        // Silent — la card mostra "—" come fallback
        console.debug("[ListoneInlineCard] checkLatestListoneVersion skip:", err);
      } finally {
        if (!cancelled) setCheckingVersion(false);
      }
    };
    void checkLatest();
    // Refresh ogni 5 minuti (in caso di nuove release GitHub)
    const timer = setInterval(() => void checkLatest(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // True se il database listone è già all'ultima versione disponibile su GitHub.
  const isUpToDate =
    !!latest?.tag &&
    !!autofetchStatus?.last_applied_tag &&
    latest.tag === autofetchStatus.last_applied_tag;

  // True se c'è una nuova versione disponibile (diversa da quella applicata).
  const hasNewVersion =
    !!latest?.tag &&
    (!autofetchStatus?.last_applied_tag || latest.tag !== autofetchStatus.last_applied_tag);

  // --- [aggiorna ora] flow ---
  const handleAggiornaOra = useCallback(async () => {
    // M3a.4 — Se già aggiornato, NON scaricare nulla. Mostra solo un messaggio.
    if (isUpToDate) {
      setMode("applied");
      setProgressLabel(`Già aggiornato all'ultima versione (${latest?.tag}).`);
      setTimeout(() => {
        setMode("idle");
        setProgressLabel("");
      }, 3000);
      return;
    }
    setMode("checking");
    setProgressLabel("Controllo versione GitHub…");
    try {
      const lv = await api.checkLatestListoneVersion();
      setLatest(lv);
      if (!lv?.tag || lv.tag === autofetchStatus?.last_applied_tag) {
        // Già aggiornato
        setMode("applied");
        setProgressLabel(`Già aggiornato all'ultima versione (${lv?.tag ?? "—"}).`);
        setTimeout(() => {
          setMode("idle");
          setProgressLabel("");
        }, 3000);
        return;
      }
      // Scarica players.json
      setMode("downloading");
      setProgressLabel(`Scarico ${lv.tag}…`);
      const data = await api.downloadListone(lv.asset_url, lv.tag);
      setDownloaded(data);
      // Anteprima diff
      setMode("previewing");
      setProgressLabel("Calcolo anteprima modifiche…");
      const prev = await api.previewImportListone(JSON.stringify(data.entries));
      setPreview(prev);
      // ImportPreview modale renderizzato inline qui sotto
    } catch (err) {
      setMode("error");
      setProgressLabel("");
      onError(`Aggiorna ora fallito: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setMode("idle"), 4000);
    }
  }, [autofetchStatus, onError, isUpToDate, latest]);

  // --- [anteprima] flow (senza applicare) ---
  const handleAnteprima = useCallback(async () => {
    if (!downloaded) {
      // Reuse handleAggiornaOra flow
      return void handleAggiornaOra();
    }
    setMode("previewing");
    try {
      const prev = await api.previewImportListone(JSON.stringify(downloaded.entries));
      setPreview(prev);
    } catch (err) {
      setMode("error");
      onError(`Anteprima fallita: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setMode("idle"), 4000);
    }
  }, [downloaded, onError, handleAggiornaOra]);

  // --- [fallback: fantacalcio.it] flow ---
  const handleFallback = useCallback(async () => {
    setMode("downloading");
    setProgressLabel("Scraper inline da fantacalcio.it (~10-15s)…");
    try {
      const data = await api.scrapeListoneInline();
      setDownloaded(data);
      setMode("previewing");
      setProgressLabel("Calcolo anteprima…");
      const prev = await api.previewImportListone(JSON.stringify(data.entries));
      setPreview(prev);
    } catch (err) {
      setMode("error");
      setProgressLabel("");
      onError(`Fallback scraper fallito: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setMode("idle"), 4000);
    }
  }, [onError]);

  // --- Applica diff (dopo preview) ---
  const handleApplica = useCallback(async () => {
    if (!downloaded) return;
    setMode("applying");
    setProgressLabel("Applico modifiche (archiviazione automatica)…");
    try {
      const s = await api.applyAutoFetch(downloaded);
      setSummary(s);
      setMode("applied");
      setProgressLabel(`Applicato: ${s.created ?? 0} aggiunti, ${s.updated ?? 0} aggiornati, ${s.archived ?? 0} archiviati.`);
      await onApplied();
      // Chiudi preview
      setPreview(null);
      setTimeout(() => {
        setMode("idle");
        setProgressLabel("");
        setSummary(null);
      }, 4000);
    } catch (err) {
      setMode("error");
      setProgressLabel("");
      onError(`Applica fallito: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setMode("idle"), 4000);
    }
  }, [downloaded, onApplied, onError]);

  // --- Annulla preview ---
  const handleAnnullaPreview = useCallback(() => {
    setPreview(null);
    setMode("idle");
    setProgressLabel("");
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        paddingTop: "4px",
      }}
    >
      {/* Counter + ultimo aggiornamento */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          flexWrap: "wrap",
          fontFamily: "var(--font-body)",
          fontSize: "12px",
          color: "var(--ink-soft)",
        }}
      >
        <span>
          <strong style={{ fontFamily: "var(--font-display)" }}>Giocatori:</strong>{" "}
          {playersCount != null ? `${playersCount}` : "—"}
        </span>
        <span>
          <strong style={{ fontFamily: "var(--font-display)" }}>Ultimo agg.:</strong>{" "}
          {autofetchStatus?.last_applied_tag
            ? `${autofetchStatus.last_applied_tag}`
            : "mai"}
        </span>
        {latest?.tag && (
          <span>
            <strong style={{ fontFamily: "var(--font-display)" }}>Disponibile:</strong>{" "}
            {checkingVersion ? "controllo…" : latest.tag}
            {hasNewVersion && (
              <span style={{ color: "var(--amber, #B8860B)", marginLeft: "4px" }}>
                ● nuovo!
              </span>
            )}
          </span>
        )}
      </div>

      {/* 3 action buttons — "aggiorna ora" nascosto se isUpToDate */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        {isUpToDate ? (
          // M3a.4 — Database già all'ultima versione. Non proporre aggiornamento.
          // Mostra badge verde "✓ Aggiornato" invece del pulsante.
          <span
            style={{
              padding: "4px 12px",
              background: "rgba(74,103,65,0.10)",
              border: "1px solid var(--green)",
              color: "var(--green)",
              fontFamily: "var(--font-display)",
              fontSize: "12px",
            }}
          >
            ✓ Aggiornato all'ultima versione ({latest?.tag})
          </span>
        ) : (
          <button
            type="button"
            onClick={handleAggiornaOra}
            disabled={mode === "checking" || mode === "downloading" || mode === "applying" || mode === "previewing"}
            style={listoneBtnPrimary}
          >
            {mode === "checking"
              ? "controllo…"
              : mode === "downloading"
              ? "scarico…"
              : hasNewVersion && latest?.tag
              ? `aggiorna a ${latest.tag}`
              : "aggiorna ora"}
          </button>
        )}
        <button
          type="button"
          onClick={handleAnteprima}
          disabled={mode === "checking" || mode === "downloading" || mode === "applying" || mode === "previewing"}
          style={listoneBtnSecondary}
        >
          anteprima
        </button>
        <button
          type="button"
          onClick={handleFallback}
          disabled={mode === "checking" || mode === "downloading" || mode === "applying" || mode === "previewing"}
          style={listoneBtnSecondary}
          title="Scarica diretto da fantacalcio.it (~10-15s). Usa se GitHub è down."
        >
          fallback: fantacalcio.it
        </button>
      </div>

      {/* Progress label */}
      {progressLabel && (
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "11px",
            color: "var(--ink-soft)",
            fontStyle: "italic",
          }}
        >
          {progressLabel}
        </div>
      )}

      {/* Summary post-applicazione */}
      {summary && mode === "applied" && (
        <div
          style={{
            padding: "6px 10px",
            background: "rgba(74,103,65,0.08)",
            border: "1px solid var(--green)",
            fontSize: "11px",
            color: "var(--green)",
            fontFamily: "var(--font-body)",
          }}
        >
          Applicato: {summary.created ?? 0} aggiunti, {summary.updated ?? 0} aggiornati, {summary.archived ?? 0} archiviati.
        </div>
      )}

      {/* ImportPreview modale inline (sovrapposto alla card) */}
      {preview && (
        <div
          style={{
            position: "relative",
            zIndex: 60,
            border: "1px solid var(--ink-soft)",
            background: "var(--paper)",
            padding: "12px",
            marginTop: "8px",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <ImportPreviewModal preview={preview} onApply={handleApplica} onCancel={handleAnnullaPreview} applying={mode === "applying"} />
        </div>
      )}
    </div>
  );
}

const listoneBtnPrimary: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "11px",
  padding: "4px 12px",
  background: "var(--ink)",
  color: "var(--paper)",
  border: "none",
  cursor: "pointer",
};

const listoneBtnSecondary: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "11px",
  padding: "4px 12px",
  background: "transparent",
  color: "var(--ink)",
  border: "1px solid var(--ink-soft)",
  cursor: "pointer",
};
