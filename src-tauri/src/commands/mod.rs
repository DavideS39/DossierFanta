//! Tauri commands esposti al frontend.
//!
//! Convenzione: ogni comando è sincrono (rusqlite è sync, niente async necessario).
//! Gli errori sono mappati a stringhe leggibili via `AppError`.

pub mod database;
pub mod listone;
pub mod players;
pub mod sync;
pub mod windows;

// M3a — B.9: modulo sync_lan solo se feature `lan-only` attiva.
// Quando `lan-only` è attivo, Iroh non viene inizializzato e il sync avviene
// via WebSocket su LAN. Modulo dietro feature flag per evitare dipendenze
// extra quando non richiesto.
#[cfg(feature = "lan-only")]
pub mod sync_lan;

use serde::Serialize;

/// Errore applicativo serializzato come stringa per il frontend.
/// Tauri converte automaticamente questo tipo in `Promise.reject(string)` JS.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("DB error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Validation: {0}")]
    Validation(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Generic(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.to_string().as_ref())
    }
}

pub type AppResult<T> = Result<T, AppError>;
