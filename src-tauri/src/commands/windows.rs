//! Comandi per la multi-window Tauri (M2.1 — IMPROVEMENT B5, Cap.17).
//!
//! Una scheda giocatore può "staccarsi" dalla finestra principale in-app
//! (Window Manager ibrido Layer 1) e aprirsi in una finestra OS nativa
//! separata. Questo modulo espone il comando `open_player_window(player_id)`
//! che crea una nuova finestra Tauri con URL `/player/:id`.
//!
//! Stato sincronizzato via eventi Tauri (emit/listen) + store Zustand
//! condiviso: una modifica in una finestra si propaga all'altra via eventi.
//!
//! M2.2 — BUG B2 (Cap.17 "Troubleshooting layer 2"): aggiunto logging
//! esteso (log::info!) su ogni step di open/close per diagnosticare i
//! casi di finestre OS native che non si aprono o si renderizzano vuote.
//! I log vanno nel pannello console del binario (stdout/stderr) e nel
//! viewer di tauri-plugin-log. Da ispezionare se l'utente riporta problemi
//! con il layer 2 del WM ibrido.
//!
//! Limiti:
//! - Max 5-6 finestre OS native contemporanee (ognuna +30-50MB). Alla 7a,
//!   l'app suggerisce di chiudere o tornare in-app.
//! - Una scheda è O in-app O OS nativa, non entrambe (switch, non duplica).

use crate::commands::{AppError, AppResult};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Crea una nuova finestra OS nativa per un giocatore. URL: /player/:id
/// (la route è gestita dal frontend con un branch condizionale in App.tsx
/// che legge `window.location.pathname`).
///
/// Limiti: max 6 finestre OS contemporanee. Alla 7a, ritorna errore
/// che l'UI mostra come toast warning che suggerisce di chiudere.
///
/// M2.2 — BUG B2 (Cap.17 troubleshooting punto 1): logging esteso per
/// diagnosticare i casi in cui il comando viene chiamato ma la finestra
/// non si apre o si renderizza vuota. Ogni step critico è loggato:
/// ingresso comando, pre-check finestra esistente, conteggio finestre,
/// costruzione WebviewWindowBuilder, build(), successo/errore.
#[tauri::command]
pub fn open_player_window(app: AppHandle, player_id: String) -> AppResult<bool> {
    log::info!(
        "[M2.2 open_player_window] IN — player_id={},",
        player_id
    );

    let label = format!("player-{}", player_id);

    // Pre-check: finestra già aperta? Se sì, focus + return.
    if let Some(existing) = app.get_webview_window(&label) {
        log::info!(
            "[M2.2 open_player_window] finestra già aperta con label={} → focus + return",
            label
        );
        let _ = existing.set_focus();
        return Ok(true);
    }

    // Conta finestre player-* aperte. Limite: 6.
    let count = app
        .webview_windows()
        .iter()
        .filter(|(l, _)| l.starts_with("player-"))
        .count();
    log::info!(
        "[M2.2 open_player_window] finestre player-* attualmente aperte: {}",
        count
    );
    if count >= 6 {
        log::warn!(
            "[M2.2 open_player_window] LIMITE RAGGIUNTO ({} finestre) — errore di validation",
            count
        );
        return Err(AppError::Validation(format!(
            "limite massimo di finestre OS native raggiunto ({}). \
             Chiudine qualcuna o usa la finestra in-app.",
            count
        )));
    }

    // Crea la nuova finestra OS.
    let url = format!("/player/{}", player_id);
    let title = format!(
        "DossierFanta — Scheda giocatore {}",
        &player_id[..8.min(player_id.len())]
    );

    log::info!(
        "[M2.2 open_player_window] WebviewWindowBuilder::new — label='{}', url='{}', title='{}'",
        label,
        url,
        title
    );

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(560.0, 720.0)
        .min_inner_size(320.0, 400.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| {
            log::error!(
                "[M2.2 open_player_window] build() FAILED per label='{}': {}",
                label,
                e
            );
            AppError::Generic(format!("cannot create window: {}", e))
        })?;

    log::info!(
        "[M2.2 open_player_window] OUT — finestra '{}' creata con successo",
        label
    );

    Ok(true)
}

/// Chiude una finestra OS nativa aperta per un giocatore. Chiamato dal
/// pulsante "Torna in-app" nella chrome OS, oppure quando l'utente
/// doppio-click sulla chrome OS.
///
/// M2.2 — BUG B2: logging esteso anche su close per diagnosticare i casi
/// in cui la finestra non viene effettivamente chiusa (label mismatch,
/// webview già droppata, ecc.).
#[tauri::command]
pub fn close_player_window(app: AppHandle, player_id: String) -> AppResult<bool> {
    let label = format!("player-{}", player_id);
    log::info!(
        "[M2.2 close_player_window] IN — player_id={}, label='{}'",
        player_id,
        label
    );

    if let Some(win) = app.get_webview_window(&label) {
        match win.close() {
            Ok(_) => {
                log::info!(
                    "[M2.2 close_player_window] OUT — finestra '{}' chiusa con successo",
                    label
                );
                return Ok(true);
            }
            Err(e) => {
                log::error!(
                    "[M2.2 close_player_window] close() FAILED per '{}': {}",
                    label,
                    e
                );
                return Err(AppError::Generic(format!(
                    "cannot close window: {}",
                    e
                )));
            }
        }
    }

    log::warn!(
        "[M2.2 close_player_window] nessuna finestra con label='{}' → no-op (return false)",
        label
    );
    Ok(false)
}

/// Elenca gli id dei giocatori attualmente aperti in finestre OS native.
/// Usato dall'UI per sapere quali schede sono "staccate" e mostrare il
/// badge corrispondente nella finestra in-app (vedi WindowManager).
#[tauri::command]
pub fn list_os_player_windows(app: AppHandle) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for (label, _) in app.webview_windows().iter() {
        if let Some(id) = label.strip_prefix("player-") {
            out.push(id.to_string());
        }
    }
    log::info!(
        "[M2.2 list_os_player_windows] trovate {} finestre player-* aperte",
        out.len()
    );
    Ok(out)
}
