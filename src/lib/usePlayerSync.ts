/**
 * usePlayerSync — hook React che sottoscrive l'evento Tauri `player-updated`
 * per sync live tra finestre (M2.2 — FIX A2 / F12, Cap.17).
 *
 * Quando l'utente modifica una scheda in una finestra (OS nativa o WM
 * in-app), il backend Rust emette `player-updated` con `{ id }`. Questo
 * hook ascolta l'evento e chiama `onUpdated(id)` quando:
 *  - `playerId === null`: qualunque id (use case: refresh lista Rosa in
 *    App.tsx per refreshare usePlayersStore)
 *  - `playerId === <id>`: solo se l'id corrisponde (use case: PlayerOSWindow
 *    e PlayerForm embedded refreshano i dati del player corrente)
 *
 * In anteprima web (browser, mock API) è no-op: il backend mock non
 * emette eventi. Il check è `isDesktop` dall'api/tauri.ts.
 *
 * Implementazione: usa un ref interno alla callback più recente, così il
 * caller può passare una callback inline senza preoccuparsi di
 * useCallback. L'effect si ri-sottoscrive solo quando `playerId` cambia
 * (dipendenza intenzionale del listener), non a ogni cambio callback.
 *
 * Uso:
 *   // Refresh lista Rosa (qualunque player cambi):
 *   usePlayerSync(null, debouncedRefresh);
 *
 *   // Refresh singolo player in finestra OS:
 *   usePlayerSync(playerId, async (id) => {
 *     const updated = await api.getPlayer(id);
 *     setPlayer(updated);
 *   });
 */

import { useEffect, useRef } from "react";
import { api, isDesktop } from "@/api/tauri";

export function usePlayerSync(
  playerId: string | null,
  onUpdated: (id: string) => void,
): void {
  // Ref alla callback più recente: NON fa re-render dell'effect. Questo
  // permette al caller di passare callback inline senza useCallback.
  const cbRef = useRef(onUpdated);
  cbRef.current = onUpdated;

  useEffect(() => {
    if (!isDesktop) return; // mock mode: no-op
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        unlisten = await api.onPlayerUpdated((id) => {
          if (playerId === null || playerId === id) {
            cbRef.current(id);
          }
        });
      } catch (e) {
        console.warn("[usePlayerSync] subscribe failed:", e);
      }
      // Se il componente si è smontato durante l'await di listen(),
      // puliamo subito per evitare leak del listener.
      if (cancelled && unlisten) {
        unlisten();
        unlisten = null;
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };
    // Dipendenza intenzionale: playerId. Quando cambia il target
    // (es. PlayerOSWindow passa da un player a un altro), ci
    // ri-sottoscriviamo con il nuovo filtro. onUpdated NON è in deps
    // perché usiamo il ref — evita ri-sottoscrizioni inutili.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId]);
}
