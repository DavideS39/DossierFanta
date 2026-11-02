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
// M3a.3 fix post-review (Round 11) — Per inviare inviti DB condiviso via Supabase Realtime
import { getSyncManager } from "@/lib/sync/SyncManager";
import { SupabaseYjsProvider } from "@/lib/sync/SupabaseYjsProvider";
import type { Pairing } from "@/types/sync";

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

  // M3a.3 fix post-review (Round 11) — Per DB condiviso nel form "Crea nuovo database".
  // Quando l'utente seleziona type="shared" nel dropdown, appare un menu a tendina
  // con i peer pairati (con nome). L'utente seleziona con chi condividere.
  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [selectedPeerKey, setSelectedPeerKey] = useState<string>("");
  // Stato per il dialog di accettazione invito DB condiviso (listener globale).
  const [pendingInvitation, setPendingInvitation] = useState<{
    dbId: string;
    dbName: string;
    peerKeyInitiator: string;
  } | null>(null);
  const [accepting, setAccepting] = useState(false);

  // M3a.3 fix post-review (Round 11) — Carica i pairings al boot + quando
  // si apre il form "Crea nuovo database" con type=selected. Usati per
  // popolare il dropdown dei peer conosciuti.
  useEffect(() => {
    let cancelled = false;
    const loadPairings = async () => {
      try {
        const list = await api.listPairings();
        if (!cancelled) {
          setPairings(list);
          // Seleziona il primo peer di default se non già selezionato
          if (list.length > 0 && !selectedPeerKey) {
            setSelectedPeerKey(list[0].peerKeyOther);
          }
        }
      } catch (err) {
        console.warn("[DatabaseManager] listPairings fallito:", err);
      }
    };
    void loadPairings();
    const timer = setInterval(() => void loadPairings(), 10000); // refresh ogni 10s
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listener per inviti DB condiviso in arrivo (CustomEvent dispatch dal SupabaseYjsProvider).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        kind: string;
        dbId: string;
        dbName: string;
        peerKeyInitiator: string;
      };
      if (detail?.kind === "db_invitation" && detail.dbId && detail.dbName) {
        console.info(
          `[DatabaseManager] Invito DB condiviso ricevuto: dbId=${detail.dbId}, dbName=${detail.dbName}, da=${detail.peerKeyInitiator.slice(0, 16)}...`
        );
        setPendingInvitation({
          dbId: detail.dbId,
          dbName: detail.dbName,
          peerKeyInitiator: detail.peerKeyInitiator,
        });
      }
    };
    window.addEventListener("dossierfanta-db-invitation", handler);
    return () => window.removeEventListener("dossierfanta-db-invitation", handler);
  }, []);

  // Handler per accettare invito DB condiviso.
  const handleAcceptInvitation = async () => {
    if (!pendingInvitation) return;
    setAccepting(true);
    setError(null);
    try {
      const meta = await api.acceptSharedDatabaseInvitation(
        pendingInvitation.dbId,
        pendingInvitation.dbName
      );
      console.info(
        `[DatabaseManager] ✓ DB condiviso accettato: id=${meta.id}, name=${meta.name}`
      );
      setPendingInvitation(null);
      await refresh();
      await refreshMeta();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccepting(false);
    }
  };

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
    // M3a.3 fix post-review (Round 11) — Se type=shared, valida che un peer
    // sia selezionato dal dropdown. Poi usa createSharedDatabase + invia invito.
    if (newType === "shared") {
      if (!selectedPeerKey.trim()) {
        setError(
          pairings.length === 0
            ? "Nessun peer pairato disponibile. Fai prima il pairing dalla schermata Sync."
            : "Seleziona un peer con cui condividere il database."
        );
        return;
      }
      setCreating(true);
      setError(null);
      try {
        // 1. Crea il DB condiviso lato Rust → ritorna SharedDatabaseInvitation.
        const invitation = await api.createSharedDatabase(newName.trim(), selectedPeerKey.trim());
        console.info(
          `[DatabaseManager] DB condiviso creato: dbId=${invitation.dbId}, dbName=${invitation.dbName}`
        );
        // 2. Invia l'invito al peer via Supabase Realtime.
        const syncManager = getSyncManager();
        const supabaseProvider = syncManager.getProvider("supabase") as
          | SupabaseYjsProvider
          | undefined;
        if (supabaseProvider && "sendDbInvitation" in supabaseProvider) {
          const sent = await supabaseProvider.sendDbInvitation(
            invitation.peerKeyOther,
            invitation.dbId,
            invitation.dbName,
            invitation.peerKeyInitiator
          );
          if (sent) {
            console.info("[DatabaseManager] ✓ Invito DB condiviso inviato al peer");
          } else {
            console.warn(
              "[DatabaseManager] Invito DB condiviso NON inviato — pairing non attivo?"
            );
            setError(
              "DB condiviso creato, ma invito NON inviato al peer. Verifica che il pairing sia attivo."
            );
          }
        } else {
          console.warn(
            "[DatabaseManager] SupabaseYjsProvider non disponibile — invito NON inviato"
          );
          setError(
            "DB condiviso creato, ma Supabase provider non disponibile per inviare l'invito."
          );
        }
        setNewName("");
        setNewType("personal");
        setSelectedPeerKey("");
        setShowCreate(false);
        await refreshMeta();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
      return;
    }
    // type=personal o listone: usa il path originale.
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
              <div className="col-span-1">Owner</div>
              <div className="col-span-2">Creato</div>
              <div className="col-span-2 text-right">Azioni</div>
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
                    <div className="col-span-1 text-xs text-ink-soft truncate" style={{ fontFamily: "var(--font-body)" }} title={db.owner ?? ""}>
                      {db.owner ?? "—"}
                    </div>
                    <div className="col-span-2 text-xs text-ink-soft" style={{ fontFamily: "var(--font-body)" }}>
                      {db.created_at ? formatDate(db.created_at) : "—"}
                    </div>
                    <div className="col-span-2 text-right flex items-center justify-end gap-1">
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
                          (stessa interfaccia: aggiorna ora / anteprima / fallback).
                          M3a.3 fix post-review — colonna Azioni allargata da
                          col-span-1 a col-span-2 (ridotto Owner a 1) per dare
                          spazio al pulsante blu col testo "aggiorna" senza
                          overflow fuori dalla cella. */}
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
                            whiteSpace: "nowrap",
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
                    placeholder="Nome (es. marco, listone-2026 — .db aggiunto in automatico)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="tacc-input"
                    autoFocus
                  />
                </div>
                <select
                  value={newType}
                  onChange={(e) => {
                    const t = e.target.value as DatabaseType;
                    setNewType(t);
                    // M3a.3 fix post-review (Round 11) — Quando si seleziona
                    // "shared", pre-seleziona il primo peer pairato se disponibile.
                    if (t === "shared" && !selectedPeerKey && pairings.length > 0) {
                      setSelectedPeerKey(pairings[0].peerKeyOther);
                    }
                  }}
                  className="tacc-input"
                >
                  <option value="personal">Personale</option>
                  <option value="shared">Condiviso</option>
                  {/* "listone" non creabile da UI — solo via import_listone */}
                </select>
              </div>
              {/* M3a.3 fix post-review (Round 11) — Quando type=shared, mostra
                  il dropdown dei peer pairati (con nome) invece del campo
                  peerkey manuale. Se non ci sono peer pairati, mostra un
                  messaggio che invita a fare prima il pairing. */}
              {newType === "shared" && (
                <div className="space-y-1">
                  {pairings.length === 0 ? (
                    <div
                      style={{
                        padding: "8px 10px",
                        background: "rgba(184,134,11,0.06)",
                        border: "1px dashed var(--amber, #B8860B)",
                        fontSize: "11px",
                        color: "var(--ink-soft)",
                        fontFamily: "var(--font-body)",
                      }}
                    >
                      ⚠ Nessun peer pairato disponibile. Per condividere un DB,
                      fai prima il pairing dalla schermata Sync (genera codice
                      di pairing sull'altro PC, inseriscilo qui).
                    </div>
                  ) : (
                    <>
                      <label
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "11px",
                          color: "var(--ink-soft)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        Condividi con:
                      </label>
                      <select
                        value={selectedPeerKey}
                        onChange={(e) => setSelectedPeerKey(e.target.value)}
                        className="tacc-input"
                        style={{ width: "100%" }}
                      >
                        {pairings.map((p) => (
                          <option key={p.peerKeyOther} value={p.peerKeyOther}>
                            {p.displayName || `${p.peerKeyOther.slice(0, 16)}...`}
                          </option>
                        ))}
                      </select>
                      <p
                        style={{
                          fontFamily: "var(--font-body)",
                          fontSize: "11px",
                          color: "var(--ink-soft)",
                          lineHeight: 1.4,
                        }}
                      >
                        Il DB verrà creato localmente e un invito verrà inviato
                        al peer selezionato. L'altro utente vedrà un dialog
                        "Vuoi accettare il DB condiviso?".
                      </p>
                    </>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button type="submit" disabled={creating} className="tacc-btn tacc-btn--primary">
                  {creating
                    ? (newType === "shared" ? "Creazione + invito…" : "Creazione…")
                    : (newType === "shared" ? "Crea e invita" : "Crea")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setError(null);
                    setNewName("");
                    setNewType("personal");
                    setSelectedPeerKey("");
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

      {/* M3a.3 fix post-review — Modale grosso per l'aggiornamento del listone.
          Contiene la ListoneInlineCard (aggiorna ora / anteprima / fallback).
          Si apre cliccando il pulsante blu "aggiorna" sulla riga ListoneSerieA.db.

          FIX: il wrapper interno ORA ha sfondo `var(--paper)`, bordo ink,
          padding, header + chrome completa — prima era solo un contenitore
          trasparente e il contenuto della card era illeggibile (text fields
          appena visibili sul backdrop scuro). */}
      {listoneModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Aggiornamento listone Serie A"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 30, 50, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: "16px",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setListoneModalOpen(false);
          }}
        >
          <div
            style={{
              position: "relative",
              maxWidth: "min(90vw, 720px)",
              width: "100%",
              maxHeight: "90vh",
              overflow: "auto",
              background: "var(--paper, #F4ECD8)",
              border: "2px solid var(--ink, #2B1B12)",
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.20)",
              borderRadius: "2px",
              padding: "0",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header del modale — titolo + close button. Stesso pattern
                degli altri modali (tacc-modal-header) ma inline perché
                questo modale non usa la classe `tacc-modal` (layout custom). */}
            <header
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 20px",
                background: "var(--ink, #2B1B12)",
                color: "var(--paper, #F4ECD8)",
                fontFamily: "var(--font-display, 'Special Elite', monospace)",
                fontSize: "14px",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "14px", fontWeight: "bold" }}>
                » Aggiornamento listone Serie A
              </h2>
              <button
                type="button"
                onClick={() => setListoneModalOpen(false)}
                aria-label="Chiudi"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--paper, #F4ECD8)",
                  fontSize: "20px",
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: "0 4px",
                }}
              >
                ×
              </button>
            </header>
            <div style={{ padding: "20px" }}>
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

      {/* M3a.3 fix post-review (Round 11) — Dialog accettazione invito DB condiviso.
          Appare quando un peer invia un messaggio "db_invitation" sul canale
          Realtime del pairing. L'utente può accettare (crea il DB localmente
          con lo stesso UUID) o rifiutare. */}
      {pendingInvitation && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Invito database condiviso"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20, 30, 50, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 70,
            padding: "16px",
          }}
        >
          <div
            style={{
              maxWidth: "min(90vw, 480px)",
              width: "100%",
              background: "var(--paper, #F4ECD8)",
              border: "2px solid var(--blue, #2C4A6B)",
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.20)",
              borderRadius: "2px",
            }}
          >
            <header
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 20px",
                background: "var(--blue, #2C4A6B)",
                color: "var(--paper, #F4ECD8)",
                fontFamily: "var(--font-display, 'Special Elite', monospace)",
                fontSize: "14px",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "14px", fontWeight: "bold" }}>
                » Invito database condiviso
              </h2>
              <button
                type="button"
                onClick={() => setPendingInvitation(null)}
                aria-label="Chiudi"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--paper, #F4ECD8)",
                  fontSize: "20px",
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: "0 4px",
                }}
              >
                ×
              </button>
            </header>
            <div style={{ padding: "20px" }}>
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "13px",
                  color: "var(--ink)",
                  lineHeight: 1.5,
                  marginBottom: "12px",
                }}
              >
                <strong>{pendingInvitation.peerKeyInitiator.slice(0, 16)}...</strong> ti sta invitando a condividere un database:
              </p>
              <div
                style={{
                  padding: "12px",
                  background: "var(--paper-dim, #E8DCC0)",
                  border: "1px solid rgba(43,27,18,0.2)",
                  marginBottom: "12px",
                }}
              >
                <div style={{ fontFamily: "var(--font-display)", fontSize: "16px", color: "var(--ink)" }}>
                  {pendingInvitation.dbName}
                </div>
                <div style={{ fontFamily: "var(--font-mono, var(--font-body))", fontSize: "10px", color: "var(--ink-soft)", marginTop: "4px", wordBreak: "break-all" }}>
                  UUID: {pendingInvitation.dbId}
                </div>
              </div>
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "12px",
                  color: "var(--ink-soft)",
                  lineHeight: 1.5,
                  marginBottom: "16px",
                }}
              >
                Accettando, il database verrà creato anche sulla tua app con lo stesso UUID.
                Le modifiche verranno sincronizzate live via Yjs + Iroh/Supabase.
              </p>
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setPendingInvitation(null)}
                  disabled={accepting}
                  className="tacc-btn"
                >
                  Rifiuta
                </button>
                <button
                  type="button"
                  onClick={handleAcceptInvitation}
                  disabled={accepting}
                  className="tacc-btn tacc-btn--primary"
                  style={{ background: "var(--blue, #2C4A6B)" }}
                >
                  {accepting ? "Accettazione…" : "Accetta"}
                </button>
              </div>
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
