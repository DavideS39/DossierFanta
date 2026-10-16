/**
 * PlayerOSWindow — contenuto per la finestra OS nativa (M2.1, B5 Layer 2).
 *
 * Quando l'utente doppio-click su una card o usa il pulsante apposito,
 * il comando Tauri `open_player_window(player_id)` crea una nuova finestra
 * OS con URL `/player/:id`. Il frontend (App.tsx) rileva il pathname e
 * renderizza questo componente invece di RosaView.
 *
 * Questo componente:
 *  - Legge player_id dal pathname
 *  - Inizializza il DB (idempotente, non fa danni se già inizializzato)
 *  - Fetch il player via api.getPlayer(player_id)
 *  - Renderizza PlayerForm embedded (senza backdrop modale, riempie la finestra)
 *  - Header con pulsante "Torna in-app" → api.closePlayerWindow(player_id)
 *
 * v2.3.6: lo sfondo è UNO dei 2 PNG forniti dal product owner
 * (desk-tile.png = legal pad rigato, desk-vintage.png = pergamena),
 * scelto stabilmente per player_id via hashString. Non più due PNG
 * sovrapposti (legal pad + pergamena in multiply) come in v2.3.5.
 *
 * M2.2 — FIX A2 (F12, Cap.17): stato sincronizzato via eventi Tauri.
 * Quando il backend emette `player-updated` (dopo save_scouting_note /
 * save_auction_data / set_player_status / assign_player), questa finestra
 * OS refresha il player + i dati collegati (auction_data, scouting_notes)
 * in automatico. Simmetricamente, le modifiche fatte qui refreshano la
 * main window (RosaView). Niente più refresh manuale come in M2.1.
 *
 * M2.2 — BUG B1 (Cap.16 "Texture handling"): il desk-tile.png è ora
 * ripetuto con `background-repeat: round` invece di `repeat` per evitare
 * il gap trasparente al resize della finestra.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "@/api/tauri";
// M2.2 — FIX A2 (F12): hook per sync live con la main window.
import { usePlayerSync } from "@/lib/usePlayerSync";
// M3a.1 (PB4) — Usa lo store Zustand per updatePlayer: lo store cabla
// automaticamente il bridge Rust→Yjs (bridgePlayerUpdate) DOPO il commit
// SQLite, propagando l'update ai peer remoti via Iroh gossip.
import { usePlayersStore } from "@/stores/usePlayersStore";
import type { CreatePlayerInput, Player, UpdatePlayerInput } from "@/types/player";
import { PlayerForm } from "./PlayerForm";
import { hashString } from "@/assets/paper";
// I 2 PNG "dati" dal product owner per lo sfondo della finestra OS nativa.
// Stessa logica della WM in-app: uno solo, scelto a caso per player_id.
import deskTileUrl from "@/assets/backgrounds/desk-tile.png";
import deskVintageUrl from "@/assets/backgrounds/desk-vintage.png";

interface SheetBgConfig {
  img: string;
  size: string;
  repeat: "repeat" | "round" | "no-repeat";
  pos: string;
}

// M2.2 — BUG B1 (Cap.16 "Texture handling"): come in Window.tsx, il
// desk-tile.png era ripetuto con `background-repeat: repeat` — al resize
// della finestra OS nativa si vedevano gap trasparenti tra le ripetizioni.
// `round` scala la texture per evitare gap (leggera distorsione su tile
// di carta rigata, impercettibile). desk-vintage è già 100% 100% no-repeat.
const WM_SHEET_BG: SheetBgConfig[] = [
  { img: deskTileUrl, size: "440px 584px", repeat: "round", pos: "top left" },
  { img: deskVintageUrl, size: "100% 100%", repeat: "no-repeat", pos: "center top" },
];

interface Props {
  /** player_id estratto dal pathname `/player/:id`. */
  playerId: string;
}

export function PlayerOSWindow({ playerId }: Props) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  // Sfondo foglio: 1 dei 2 PNG "dati" dal product owner. Stabile per
  // player_id (hashString) → la stessa finestra OS mostra sempre lo
  // stesso foglio, finestre diverse ne possono mostrare uno diverso.
  const sheetBg = useMemo(
    () => WM_SHEET_BG[hashString(playerId + ":wm-sheet") % WM_SHEET_BG.length],
    [playerId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Inizializza DB (idempotente — non fa danni se già inizializzato)
        await api.initDb();
        // Fetch player
        const p = await api.getPlayer(playerId);
        if (!cancelled) {
          setPlayer(p);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playerId]);

  // M2.2 — FIX A2 (F12): ascolta `player-updated` per il playerId corrente.
  // Quando l'utente (o un'altra finestra) modifica il player, refreshiamo
  // i dati qui. Include il caso "auto-toggle da fare → scoutato" quando si
  // salva una nota scouting: lo status del player cambia e la card nella
  // finestra OS deve rifletterlo.
  usePlayerSync(playerId, async (id) => {
    try {
      const updated = await api.getPlayer(id);
      setPlayer(updated);
    } catch (e) {
      // Il player potrebbe essere stato eliminato nel frattempo — chiudiamo.
      console.warn("[PlayerOSWindow] refresh post player-updated failed:", e);
    }
  });

  const handleClose = async () => {
    setClosing(true);
    try {
      await api.closePlayerWindow(playerId);
      // La finestra si chiude dal lato Tauri — questo codice non gira più
    } catch (e) {
      setClosing(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSubmit = async (input: CreatePlayerInput | UpdatePlayerInput) => {
    if (!player) return;
    // M3a.1 (PB4) — Passa per lo store Zustand invece di api diretta:
    // lo store, dopo il commit SQLite, invoca bridgePlayerUpdate per
    // propagare l'update al Y.Doc locale + Iroh broadcast ai peer.
    await usePlayersStore.getState().updatePlayer(input as UpdatePlayerInput);
    // Re-fetch per mostrare i dati aggiornati (l'evento player-updated
    // non viene emesso da update_player — vedi M2.2 FIX A2 scope).
    const updated = await api.getPlayer(playerId);
    setPlayer(updated);
  };

  // Layout: chrome simulata in alto (Titolo + Torna in-app + Chiudi)
  // + corpo con PlayerForm embedded

  return (
    <div
      className="flex flex-col h-screen"
      style={
        {
          overflow: "hidden",
          // Sfondo foglio: UNO dei 2 PNG, copre tutto (header + corpo).
          // backgroundColor TRASPARENTE: i PNG hanno già i buchi della
          // spiralatura forati (alpha=0); con un colore solido di
          // fallback riempiremmo i buchi → sembrerebbero finti.
          backgroundColor: "transparent",
          backgroundImage: `url("${sheetBg.img}")`,
          backgroundSize: sheetBg.size,
          backgroundRepeat: sheetBg.repeat,
          backgroundPosition: sheetBg.pos,
          backgroundAttachment: "local",
        } as CSSProperties
      }
    >
      {/* Header locale della finestra OS — distinto dalla chrome nativa di Windows.
          In Tauri 2 con `decorations: true` la chrome nativa mostra già i pulsanti
          minimizza/massimizza/chiudi. Aggiungiamo qui solo "Torna in-app".
          v2.3.6: l'header è OPACO (background ink) per leggibilità del titolo
          anche quando il foglio sottostante è una pergamena con testo sbiadito. */}
      <header
        className="text-paper px-4 py-2 flex items-center justify-between flex-shrink-0"
        style={{ backgroundColor: "var(--ink)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-xs uppercase tracking-wider text-paper/60"
            style={{ fontFamily: "var(--font-body)" }}
          >
            » DossierFanta · Scheda OS
          </span>
          {player && (
            <span className="text-sm" style={{ fontFamily: "var(--font-display)" }}>
              {player.name}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleClose}
          disabled={closing}
          className="px-2 py-1 text-xs uppercase tracking-wider border border-paper/40 text-paper hover:bg-paper hover:text-ink"
          style={{ fontFamily: "var(--font-display)" }}
          title="Chiudi questa finestra OS — la scheda torna disponibile in-app"
        >
          ⤺ Torna in-app
        </button>
      </header>

      {/* Corpo: foglio strappato come le finestre in-app (v2.3.4) */}
      <div className="flex-1 overflow-hidden">
        {loading && (
          <div
            className="flex items-center justify-center h-full"
            style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--ink-soft)" }}
          >
            <span className="inline-block w-4 h-4 border-2 border-ink/30 border-t-ink rounded-full animate-spin mr-2 align-middle" />
            Caricamento giocatore…
          </div>
        )}

        {error && !loading && (
          <div
            className="m-4 p-3 border-2"
            style={{
              borderColor: "var(--red)",
              backgroundColor: "rgba(139, 46, 31, 0.08)",
              color: "var(--ink)",
              fontFamily: "var(--font-body)",
              fontSize: "13px",
            }}
          >
            <strong style={{ color: "var(--red)" }}>Errore:</strong> {error}
            <div className="mt-2 text-xs" style={{ color: "var(--ink-soft)" }}>
              Verifica che il giocatore id={playerId} esista ancora nel DB attivo.
              Potrebbe essere stato eliminato o archiviato.
            </div>
          </div>
        )}

        {player && !loading && !error && (
          <div className="wf-os-sheet">
            <PlayerForm
              player={player}
              embedded
              onClose={handleClose}
              onSubmit={handleSubmit}
            />
          </div>
        )}
      </div>
    </div>
  );
}
