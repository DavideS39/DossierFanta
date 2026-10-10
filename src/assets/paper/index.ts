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
