/**
 * Texture carta fotografiche per le schede giocatore (v2.3.2 — Cap.16).
 *
 * Le 5 immagini fornite dal product owner sono state normalizzate con
 * `scripts/preprocess_paper.py`: crop sul bounding-box dell'alpha, crop
 * leggero per rientrare nella banda postcard 1.50-1.75 (senza stretch),
 * export WebP RGBA a 720px di larghezza (~180 KB totali).
 *
 * Il bordo strappato delle card NON è un clip-path CSS: è l'alpha della
 * fotografia. Le ombre multilayer del Cap.16 sono applicate come
 * `filter: drop-shadow()` sul layer di sfondo, così la sagoma strappata
 * proietta la propria ombra sulla scrivania.
 *
 * Le safe-area (`safe`) sono percentuali del box card dentro le quali il
 * contenuto non collide con fori, strappi, riga di margine rosa o angoli
 * piegati. Misurate analiticamente (paper-meta.json) e rifinite a occhio
 * su screenshot reali.
 */

import paper1 from "./paper-1.webp";
import paper2 from "./paper-2.webp";
import paper3 from "./paper-3.webp";
import paper4 from "./paper-4.webp";
import paper5 from "./paper-5.webp";
import sheet1 from "./sheet-1.webp";
import sheet2 from "./sheet-2.webp";
import sheet3 from "./sheet-3.webp";

export interface PaperSafeArea {
  /** inset superiore in % dell'altezza card */
  t: number;
  /** inset destro in % della larghezza card */
  r: number;
  /** inset inferiore in % dell'altezza card */
  b: number;
  /** inset sinistro in % della larghezza card */
  l: number;
}

export interface PaperVariant {
  id: string;
  img: string;
  /** aspect ratio larghezza/altezza della texture (== aspect della card) */
  aspect: number;
  safe: PaperSafeArea;
  /** x della riga di margine rosa in % (se presente), per allineare il testo */
  pink?: number;
  note: string;
}

/** Bigliettino orizzontale per empty state / nastri masthead. */
export const BANNER_PAPER: PaperVariant = {
  id: "banner",
  img: paper1,
  aspect: 2.368,
  safe: { t: 16, r: 5, b: 14, l: 13 },
  note: "striscia rigata, fori a sinistra",
};

/** Le 4 varianti usate come fondo delle schede giocatore. */
export const CARD_PAPERS: PaperVariant[] = [
  {
    id: "scribbles",
    img: paper2,
    aspect: 1.497,
    safe: { t: 7, r: 4, b: 6, l: 17 },
    pink: 13,
    note: "carta bianca stropicciata, fori a sx, appunti a matita",
  },
  {
    id: "aged",
    img: paper3,
    aspect: 1.748,
    safe: { t: 14, r: 3, b: 8, l: 18 },
    pink: 14.4,
    note: "carta invecchiata, fori in alto, margine rosa",
  },
  {
    id: "clean",
    img: paper4,
    aspect: 1.607,
    safe: { t: 14, r: 6, b: 16, l: 7 },
    note: "foglio chiaro pulito, fori in alto, strappo in basso",
  },
  {
    id: "folded",
    img: paper5,
    aspect: 1.706,
    safe: { t: 10, r: 9, b: 12, l: 19 },
    pink: 15,
    note: "carta stropicciata, fori a sx, angolo piegato in alto a dx",
  },
];

/** Hash stabile (FNV-1a semplificata) per assegnazioni deterministiche. */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Variante carta di un giocatore: stabile nel tempo (hash dell'id). */
export function paperFor(playerId: string): PaperVariant {
  return CARD_PAPERS[hashString(playerId) % CARD_PAPERS.length];
}

/* ============================================================
   FOGLI FINESTRA WM (v2.3.4 — "schede windowed su fogli strappati")
   ============================================================
   Le 3 fotografie fornite dal product owner (1.png/2.png/3.png,
   normalizzate da scripts/preprocess_sheets.py in sheet-*.webp)
   diventano il fondo delle finestre del Window Manager in-app e
   delle finestre OS native: la finestra NON è un rettangolo CSS,
   è un foglio strappato posato sulla scrivania.

   Geometrie misurate analiticamente (alpha + profilo righe):
   - safe  : area interna (%) dove il contenuto non collide con
             strappi, fori di spiralatura, perforazione o nastro;
   - ruled : prima riga e passo della rigatura (% altezza foglio),
             per ancorare visivamente titolo e blocchi al rigo;
   - tape  : dove va il nastro adesivo CSS ("top" = aggiunto noi,
             "baked" = già impresso nella fotografia, non duplicare).
   ============================================================ */

export interface SheetRuling {
  /** y della prima riga scrivibile, in % dell'altezza foglio */
  start: number;
  /** passo fra le righe, in % dell'altezza foglio */
  step: number;
}

export interface SheetVariant {
  id: string;
  img: string;
  /** aspect ratio larghezza/altezza della texture */
  aspect: number;
  safe: PaperSafeArea;
  ruled: SheetRuling;
  tape: "top" | "baked";
  note: string;
}

export const SHEET_PAPERS: SheetVariant[] = [
  {
    id: "tape-note",
    img: sheet1,
    aspect: 0.7488,
    safe: { t: 13, r: 8, b: 5, l: 10 },
    ruled: { start: 8.2, step: 4.93 },
    tape: "baked", // il nastro grigio è già nella foto: non duplicarlo
    note: "bigliettino rigato con nastro adesivo impresso in alto",
  },
  {
    id: "spiral",
    img: sheet2,
    aspect: 0.717,
    safe: { t: 14, r: 6, b: 4, l: 24 },
    ruled: { start: 16.9, step: 5.19 },
    tape: "top",
    note: "foglio da quaderno spiralato: fori a sx, righe blu, margine rosa",
  },
  {
    id: "pad",
    img: sheet3,
    aspect: 0.7827,
    safe: { t: 11, r: 6, b: 4, l: 7 },
    ruled: { start: 11.8, step: 3.3 },
    tape: "top",
    note: "blocco perforato strappato: righe fitte grigie, denti in alto",
  },
];

/** Foglio di una finestra WM: stabile per player_id (hash dell'id). */
export function sheetFor(playerId: string): SheetVariant {
  return SHEET_PAPERS[hashString(playerId + ":sheet") % SHEET_PAPERS.length];
}
