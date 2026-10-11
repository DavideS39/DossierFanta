// Formattatori per la valuta disambiguata v2.2.
//
// Simboli UI (NON confondere — vedi design doc Cap.2):
//   f₥  = Fantamilioni (Unicode: f + U+20A5 MILL SIGN)  — valuta della lega
//   M   = Med (media voto pura senza bonus)              — range 0-10
//   MV  = MedV (FantaMedia con bonus/malus)              — range 0-10
//   FVM = FantaValoreMedio (valore mercato da listone)   — integer

/** Glifo Unicode U+20A5 (Mill Sign), usato come simbolo Fantamilioni. */
export const FMIL_SYMBOL = "\u20A5"; // ₥

/**
 * Formatta un valore in Fantamilioni: 78 → "f₥ 78". Null → "—".
 *
 * Simbolo: `f` + U+20A5 (Mill Sign) = "f₥", SENZA spazio tra le due parti
 * (vincolo hard specifica v2.2: "f minuscola + ₥ Unicode U+20A5").
 * L'unica spaziatura ammessa è tra il simbolo e il valore numerico.
 */
export function fmtFmil(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `f${FMIL_SYMBOL} ${v}`;
}

/** Formatta la Med (media voto pura): 6.05 → "M 6.05". Null → "—". */
export function fmtMed(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `M ${v.toFixed(2)}`;
}

/** Formatta la MedV (FantaMedia con bonus): 6.85 → "MV 6.85". Null → "—". */
export function fmtMedv(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `MV ${v.toFixed(2)}`;
}

/** Formatta il FVM (FantaValoreMedio): 32 → "FVM 32". Null → "—". */
export function fmtFvm(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `FVM ${v}`;
}

/** Formatta una data ISO SQLite: "2026-09-15 12:34:56" → "15 set 2026, 12:34". */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    // SQLite datetime format: "YYYY-MM-DD HH:MM:SS" (UTC)
    const dt = new Date(iso.replace(" ", "T") + "Z");
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleString("it-IT", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Colore CSS per badge ruolo (usa palette taccuino). */
export const ROLE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  P: { bg: "#B8860B", fg: "#FFF", label: "P" },
  D: { bg: "#2C4A6B", fg: "#FFF", label: "D" },
  C: { bg: "#4A6741", fg: "#FFF", label: "C" },
  A: { bg: "#8B2E1F", fg: "#FFF", label: "A" },
};

/** Colore CSS per stato scouting. */
export const STATUS_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  totali: { bg: "#4A6741", fg: "#FFF", label: "Totali" },
  scoutato: { bg: "#2C4A6B", fg: "#FFF", label: "Scoutato" },
  da_fare: { bg: "#B8860B", fg: "#FFF", label: "Da fare" },
};

/** Colore CSS per fascia giocatore. */
export const FASCIA_COLORS: Record<string, string> = {
  Top: "#8B2E1F",
  Semitop: "#B8860B",
  Medio: "#4A6741",
  Regolarista: "#2C4A6B",
  Scommessa: "#6B4A2C",
};
