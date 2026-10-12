/**
 * windowActions — helper condivisi per il Window Manager ibrido (Cap.17, M2.2).
 *
 * M2.2 — FIX A1 (F11): il doppio-click sulla chrome di una finestra WM
 * in-app DEVE staccare la scheda in finestra OS nativa, NON massimizzare.
 * Per evitare di duplicare il flusso detach (closeWindow in-app →
 * openPlayerWindow Tauri → detachToOs → sync backend) tra i due entry
 * points (Window.tsx chrome + RosaView.handleDetachOs), lo estraiamo qui.
 *
 * La funzione è desktop-only: in anteprima web (browser, mock API) non fa
 * nulla e ritorna false. Il chiamante è responsabile di mostrare un toast
 * informativo in web mode (vedi RosaView.handleDetachOs).
 *
 * Flusso:
 *  1. closeWindow(playerId) — chiude la versione WM in-app (se aperta)
 *  2. api.openPlayerWindow(playerId) — crea la finestra OS via Tauri
 *  3. detachToOs(playerId) — traccia il detach nello store Zustand
 *  4. listOsPlayerWindows → setDetachedToOs — sync dal backend
 *
 * Una scheda è O in-app O OS nativa (switch, non duplica) — Cap.17 spec.
 */

import { api, isDesktop } from "@/api/tauri";
import { useWindowsStore } from "@/stores/useWindowsStore";

/**
 * Stacca una scheda dal Window Manager in-app in una finestra OS nativa.
 *
 * @param playerId id del giocatore da staccare
 * @returns true se il detach è andato a buon fine, false altrimenti
 *          (in web mode ritorna false senza lanciare — il chiamante
 *           deve gestire il toast informativo)
 */
export async function detachWindowToOs(playerId: string): Promise<boolean> {
  if (!isDesktop) {
    // In anteprima web le finestre OS non esistono: il chiamante mostra
    // un toast informativo (vedi RosaView.handleDetachOs).
    return false;
  }
  try {
    // 1. Chiudi la finestra WM in-app (se aperta). safe: no-op se non aperta.
    useWindowsStore.getState().closeWindow(playerId);
    // 2. Crea la finestra OS nativa via Tauri multi-window.
    //    Il backend (windows.rs::open_player_window) fa pre-check:
    //    se già aperta → focus + return; se limite 6 raggiunto → errore.
    await api.openPlayerWindow(playerId);
    // 3. Traccia il detach nello store: WindowManager non renderizzerà
    //    la versione in-app (evita duplica — Cap.17 "switch, non duplica").
    useWindowsStore.getState().detachToOs(playerId);
    // 4. Sync dal backend per coerenza (anche altre schede eventualmente
    //    aperte in OS verrebbero rilevate qui).
    const ids = await api.listOsPlayerWindows();
    useWindowsStore.getState().setDetachedToOs(ids);
    return true;
  } catch (e) {
    console.error("[M2.2 detachWindowToOs] failed:", e);
    return false;
  }
}

/**
 * Riattacca una scheda dalla finestra OS nativa al Window Manager in-app.
 *
 * M2.2 — FIX A2: la chiusura della finestra OS (pulsante "Torna in-app" in
 * PlayerOSWindow, o il close nativo della chrome Windows) deve liberare la
 * scheda per renderla di nuovo disponibile in-app. Chiamato da:
 *  - PlayerOSWindow.handleClose (pulsante esplicito)
 *  - evento Tauri 'tauri://close-requested' sulla finestra OS (chroma OS)
 *
 * Il flusso è l'inverso di detachWindowToOs:
 *  1. closePlayerWindow(playerId) — chiude la finestra OS via Tauri
 *  2. attachFromOs(playerId) — rimuove dal set detachedToOs
 *  3. listOsPlayerWindows → setDetachedToOs — sync dal backend
 *
 * NON riapre automaticamente la finestra in-app: il chiamante può farlo
 * esplicitamente con useWindowsStore.openPlayerWindow(playerId, title)
 * se lo desidera (es. l'utente ha click X sulla OS → torniamo in-app).
 */
export async function attachWindowFromOs(playerId: string): Promise<boolean> {
  if (!isDesktop) {
    return false;
  }
  try {
    await api.closePlayerWindow(playerId);
    useWindowsStore.getState().attachFromOs(playerId);
    const ids = await api.listOsPlayerWindows();
    useWindowsStore.getState().setDetachedToOs(ids);
    return true;
  } catch (e) {
    console.error("[M2.2 attachWindowFromOs] failed:", e);
    return false;
  }
}
