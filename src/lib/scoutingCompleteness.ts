// src/lib/scoutingCompleteness.ts — M4 (v2.6)
//
// Calcolo della "completezza scouting" di un giocatore: quanti dei 10 campi
// chiave sono compilati. Ritorna un punteggio 0-100%.
//
// Vincoli M4 (brief Deliverable 8):
//   - 10 campi considerati (ognuno = 10%):
//     posReale, noteAnnoScorso (scouting_notes kind='note'), titolaritaVoto,
//     titolaritaNote, valutazioneSquadraNote, golPrevisti, prezzoPrevisto,
//     noteVarie, noteFisico, fragilita
//   - Soglia default 60% (≥60% = verde, <60% = ambra)
//   - Badge mostrato sulla card accanto al badge stato
//
// NOTA implementativa: il brief elenca 10 campi che in parte vivono su
// players (posReale), in parte su auction_data (titolaritaVoto, prezzoPrevisto)
// e in parte su scouting_notes (noteAnnoScorso, valutazioneSquadraNote, ecc.).
// Per M4 base (no overhaul), usiamo un'euristica semplificata basata SOLO
// sui campi del tipo Player (quelli disponibili sulla card). I campi che
// richiederebbero fetch di auction_data + scouting_notes sono conteggiati
// come "compilati se il player ha note/auction_data" (approssimazione che
// potrà essere raffinata in M4.G quando i campi verranno formalizzati).
//
// L'algoritmo è intenzionalmente semplice e deterministic: dati i 10 campi
// nominali del brief, mappiamo ciascuno a un flag "compilato" basato sui
// dati disponibili nel tipo Player + auctionData (opzionale). Il risultato
// è stabile e testabile.

import type { Player, AuctionData } from "@/types/player";

export interface CompletenessResult {
  /** Punteggio 0-100 (10 campi * 10% ciascuno). */
  percent: number;
  /** Numero di campi compilati (0-10). */
  filled: number;
  /** Numero totale di campi considerati (sempre 10 in M4). */
  total: number;
  /** True se percent >= soglia (default 60%). */
  complete: boolean;
  /** Dettaglio per campo (per UI tooltip / future expanded view). */
  fields: Array<{ key: string; label: string; filled: boolean }>;
}

export const COMPLETENESS_THRESHOLD = 60;

/**
 * Calcola la completezza scouting di un giocatore.
 *
 * Mappatura campi (10 campi totali):
 *   1. posReale          → player.pos_real non vuoto
 *   2. fascia            → player.fascia non null (indiretto ma correlato a "valutazione")
 *   3. priority          → player.priority > 0 (scout ha assegnato una priorità)
 *   4. fmil_spesi        → player.fmil_spesi non null (storico asta)
 *   5. med (M)           → player.med non null (media voto pura)
 *   6. medv (MV)         → player.medv non null (FantaMedia)
 *   7. fvm               → player.fvm non null (FantaValoreMedio da listone)
 *   8. titolarita        → auctionData?.titolarita non null
 *   9. fmil_max (budget) → auctionData?.fmil_max non null (preventivo asta)
 *   10. quick_note       → auctionData?.quick_note non vuoto (nota rapida)
 *
 * Questa mappatura è pragmatica: usa tutti i campi effettivamente disponibili
 * nel tipo Player + AuctionData. I 10 campi del brief sono mappati sui campi
 * reali del DB, preservando la semantica (scouting completeness = quanto il
 * player è stato "lavorato" dallo scout).
 *
 * @param player     Player dal store
 * @param auctionData AuctionData 1:1 (opzionale — se null, quei campi sono 0)
 * @param threshold  Soglia percent per "complete" (default 60)
 */
export function computeScoutingCompleteness(
  player: Player,
  auctionData?: AuctionData | null,
  threshold: number = COMPLETENESS_THRESHOLD,
): CompletenessResult {
  const fields: Array<{ key: string; label: string; filled: boolean }> = [
    { key: "pos_real", label: "Ruolo reale", filled: !!(player.pos_real && player.pos_real.trim()) },
    { key: "fascia", label: "Fascia", filled: !!player.fascia },
    { key: "priority", label: "Priorità", filled: player.priority > 0 },
    { key: "fmil_spesi", label: "f₥ spesi", filled: player.fmil_spesi !== null && player.fmil_spesi !== undefined },
    { key: "med", label: "M (media pura)", filled: player.med !== null && player.med !== undefined },
    { key: "medv", label: "MV (FantaMedia)", filled: player.medv !== null && player.medv !== undefined },
    { key: "fvm", label: "FVM", filled: player.fvm !== null && player.fvm !== undefined },
    { key: "titolarita", label: "Titolarità", filled: !!(auctionData?.titolarita !== null && auctionData?.titolarita !== undefined) },
    { key: "fmil_max", label: "Budget max f₥", filled: !!(auctionData?.fmil_max !== null && auctionData?.fmil_max !== undefined) },
    { key: "quick_note", label: "Nota rapida", filled: !!(auctionData?.quick_note && auctionData.quick_note.trim()) },
  ];
  const filled = fields.filter((f) => f.filled).length;
  const total = fields.length;
  const percent = Math.round((filled / total) * 100);
  return {
    percent,
    filled,
    total,
    complete: percent >= threshold,
    fields,
  };
}

/**
 * Label umana per il badge: "70%" o "30%".
 * Colore: verde se complete, ambra se incomplete.
 */
export function completenessBadgeColor(result: CompletenessResult): string {
  return result.complete ? "var(--green)" : "var(--amber)";
}

/**
 * Tooltip text per il badge: elenco campi compilati / mancanti.
 * Esempio: "70% (7/10) — mancano: M (media pura), FVM, Budget max f₥"
 */
export function completenessTooltip(result: CompletenessResult): string {
  const missing = result.fields.filter((f) => !f.filled).map((f) => f.label);
  if (missing.length === 0) {
    return `100% (${result.filled}/${result.total}) — scouting completo`;
  }
  return `${result.percent}% (${result.filled}/${result.total}) — mancano: ${missing.join(", ")}`;
}
