// src/lib/tagHash.ts — M4 (v2.6)
//
// Helper condiviso per il calcolo del colore e della rotazione di un tag-timbro.
// Entrambi gli algoritmi sono deterministici (stesso label → stesso output).
//
// Vincolo HARD #22: tag-timbro testo libero, colore hash-based, rotazione
// hash-based. Niente tag predefiniti.
//
// IMPORTANTE: questi algoritmi sono lo specchio esatto di quelli lato Rust
// (src-tauri/src/commands/tags.rs — `hash_to_color` e `hash_to_rotation_deg`).
// Modifiche qui vanno replicate lato Rust e viceversa, altrimenti tag con
// stesso label avrebbero colore diverso tra backend (cache su DB) e frontend
// (rendering live).

/**
 * FNV-1a 32-bit hash di una stringa.
 *
 * Stesso algoritmo di Rust `hash_to_color`:
 *   h = 0x811c9dc5 (offset basis)
 *   for each byte: h ^= byte; h = h * 0x01000193 (FNV prime)
 *
 * Usiamo `Math.imul` per moltiplicazione 32-bit senza overflow JS.
 */
export function fnv1a32(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // `>>> 0` converte in unsigned 32-bit
  return h >>> 0;
}

/**
 * Calcola il colore HSL di un label.
 *
 * Algoritmo (vincolo M4 brief):
 *   - hue = hash(label) % 360
 *   - saturation = 45%
 *   - lightness = 35% (colori scuri su carta chiara #F4ECD8)
 *
 * Ritorna una stringa CSS `hsl(h, s%, l%)`.
 *
 * Identico a Rust `hash_to_color` (commands/tags.rs).
 */
export function hashToColor(label: string): string {
  const hue = fnv1a32(label) % 360;
  return `hsl(${hue}, 45%, 35%)`;
}

/**
 * Calcola la rotazione in gradi di un label (range ±10°).
 *
 * Identico a Rust `hash_to_rotation_deg` (commands/tags.rs):
 *   h = 0x811c9dc5 + xorshift mixer per indipendenza statistica dal hue.
 *
 * La rotazione è stabile per label (stesso testo = stessa rotazione, sempre).
 */
export function hashToRotationDeg(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h = (h + label.charCodeAt(i)) >>> 0;
    h ^= (h << 13) >>> 0;
    h ^= h >>> 17;
    h ^= (h << 5) >>> 0;
  }
  // 0..20 → -10..+10
  return (h % 20) - 10;
}

/**
 * Converte una stringa colore HSL "hsl(42, 45%, 35%)" in una tripla RGB
 * per uso in `rgba()` (quando serve un canale alpha — es. background
 * del selected state).
 *
 * Implementazione: standard HSL→RGB conversion.
 */
export function hslToRgbTriple(hsl: string): [number, number, number] {
  const m = hsl.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  if (!m) return [43, 27, 18]; // fallback ink
  const h = parseInt(m[1], 10);
  const s = parseInt(m[2], 10) / 100;
  const l = parseInt(m[3], 10) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else if (hp < 6) [r, g, b] = [c, 0, x];
  const m1 = l - c / 2;
  return [Math.round((r + m1) * 255), Math.round((g + m1) * 255), Math.round((b + m1) * 255)];
}
