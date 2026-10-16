/**
 * useAutoFetchStore — store Zustand per la notifica "aggiornamento disponibile".
 *
 * M3 (Cap.7): App.tsx al mount chiama `check_latest_listone_version` e
 * `get_autofetch_status`, confronta il tag latest con `last_applied_tag`.
 * Se diversi, setta `notice` con un messaggio — RosaView lo mostra come
 * toast cartaceo non bloccante in cima alla scrivania. L'utente clicka
 * per aprire la schermata Aggiornamenti e decidere se applicare.
 *
 * Vincolo hard M3 #12: l'auto-fetch NON si triggera in modo invisibile
 * all'avvio. L'utente vede sempre il toast e deve clickare per applicare
 * (l'archiviazione è irreversibile senza restore esplicito).
 *
 * Il toast è dismissable e sparisce anche se l'utente chiude la schermata
 * Aggiornamenti senza applicare (verrà ri-mostrato al prossimo avvio
 * se il tag è ancora diverso).
 */

import { create } from "zustand";

interface AutoFetchState {
  /** Messaggio del toast (null se nessuna notifica attiva). */
  notice: string | null;
  /** Tag della release disponibile (per reference UI). */
  pendingTag: string | null;
  /** Mostra il toast. */
  setNotice: (notice: string, tag?: string) => void;
  /** Pulisce il toast. */
  clearNotice: () => void;
}

export const useAutoFetchStore = create<AutoFetchState>((set) => ({
  notice: null,
  pendingTag: null,
  setNotice: (notice, tag) => set({ notice, pendingTag: tag ?? null }),
  clearNotice: () => set({ notice: null, pendingTag: null }),
}));
