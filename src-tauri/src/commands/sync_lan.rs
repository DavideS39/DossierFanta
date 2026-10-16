//! `commands/sync_lan.rs` — Fallback WebSocket LAN-only (M3a — B.9).
//!
//! Modulo dietro feature flag `lan-only`. Attivato con:
//!   cargo build --features lan-only
//!
//! Quando `lan-only` è attivo:
//!  - Iroh NON viene inizializzato (i comandi iroh_* ritornano errore
//!    "lan-only mode attivo — usa sync_lan_* invece")
//!  - Sync via WebSocket su LAN (ws://192.168.x.x:port)
//!  - Discovery via mDNS (service `_dossierfanta._tcp.local.`)
//!  - Perde p2p a distanza, mantiene sync live in casa
//!
//! Il flag è documentato ma NON attivato di default. Si attiva solo se
//! Iroh presenta bug in production (insurance policy).
//!
//! M3a.1 (Fix aggiuntivo B) — `lan_broadcast_update` ora invia effettivamente
//! bytes a tutti i peer connessi tramite canali mpsc dedicati per ogni peer.
//! In precedenza era log-only (placeholder) — sync era unidirezionale.
//! Aggiunta inoltre discovery mDNS automatico per trovare peer DossierFanta
//! sulla stessa LAN senza scambio manuale di IP:port.
//!
//! # CSP
//!
//! Per attivare lan-only, l'utente deve aggiornare il CSP in
//! `tauri.conf.json`:
//!
//!   "csp": "default-src 'self'; ...; connect-src 'self' ws://*:* wss://*:*; ..."
//!
//! (aggiungere `ws://*:* wss://*:*` a `connect-src`).

#![cfg(feature = "lan-only")]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::commands::{AppError, AppResult};

// ----------------------------------------------------------------------
// Stato LAN (IP:port del server locale, peers connessi con sender)
// ----------------------------------------------------------------------

/// Capacità del canale mpsc per peer (messaggi in coda per invio).
/// 128 updates = ~256KB se ogni update è 2KB. Sufficiente per sync live
/// lettera-per-lettera anche con typing molto rapido.
const PEER_SEND_QUEUE_CAP: usize = 128;

/// Tipo alias per il sender di un peer connesso.
type PeerSender = mpsc::Sender<Message>;

struct LanState {
    /// Indirizzo del server WebSocket locale (es. "192.168.1.42:9876").
    server_addr: Mutex<Option<String>>,
    /// Peers connessi con il loro sender channel (per broadcast).
    /// Chiave: peer_key (IP:port o hostname). Valore: sender per scrivere
    /// messaggi sul WebSocket di quel peer.
    peers: Mutex<HashMap<String, PeerSender>>,
}

impl LanState {
    fn instance() -> &'static LanState {
        static INSTANCE: OnceLock<LanState> = OnceLock::new();
        INSTANCE.get_or_init(|| LanState {
            server_addr: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
        })
    }

    fn add_peer(&self, peer_key: String, sender: PeerSender) {
        if let Ok(mut g) = self.peers.lock() {
            g.insert(peer_key, sender);
        }
    }

    fn remove_peer(&self, peer_key: &str) {
        if let Ok(mut g) = self.peers.lock() {
            g.remove(peer_key);
        }
    }

    fn list_peers(&self) -> Vec<String> {
        self.peers
            .lock()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// M3a.1 (Fix aggiuntivo B) — Invia un messaggio a tutti i peer connessi.
    /// Ritorna il numero di peer a cui l'invio è stato completato con successo.
    fn broadcast(&self, msg: Message) -> usize {
        let senders: Vec<(String, PeerSender)> = self
            .peers
            .lock()
            .map(|g| g.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        let mut sent = 0;
        for (key, tx) in senders {
            // try_send: non-blocka se il canale è pieno (drop del messaggio
            // per quel peer — il sync è CRDT, l'update successivo recupera).
            match tx.try_send(msg.clone()) {
                Ok(()) => sent += 1,
                Err(e) => {
                    log::warn!("[M3a lan-only] broadcast a {} fallito: {}", key, e);
                }
            }
        }
        sent
    }
}

// ----------------------------------------------------------------------
// Comandi esposti (solo con feature `lan-only`)
// ----------------------------------------------------------------------

/// Avvia un server WebSocket LAN su `addr` (es. "0.0.0.0:9876").
/// Ritorna l'indirizzo effettivo su cui è in ascolto.
///
/// M3a.1 (Fix aggiuntivo B) — Registra anche il servizio mDNS
/// `_dossierfanta._tcp.local.` così gli altri peer DossierFanta sulla stessa
/// LAN possono scoprire automaticamente questo nodo senza scambio manuale
/// di IP:port.
///
/// M3a.2 (PB4-B fix) — Aggiunto parametro `app: tauri::AppHandle` per
/// passar lo a `handle_peer`, che lo userà per emettere `sync-update-received`
/// con i bytes dell'update (come nel path Iroh).
#[tauri::command]
pub async fn lan_start_server(app: tauri::AppHandle, addr: String) -> AppResult<String> {
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| AppError::Generic(format!("bind {}: {}", addr, e)))?;

    let actual_addr = listener
        .local_addr()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| addr.clone());

    if let Ok(mut g) = LanState::instance().server_addr.lock() {
        *g = Some(actual_addr.clone());
    }

    log::info!("[M3a.1 lan-only] WS server avviato su {}", actual_addr);

    // M3a.1 — Registra servizio mDNS per discovery automatico.
    // Best-effort: se fallisce, logga warning ma continua (pairing manuale
    // via lan_connect rimane disponibile).
    let _ = register_mdns_service(&actual_addr).await;

    // Spawn accept loop di background
    tokio::spawn(async move {
        loop {
            let (stream, peer_addr) = match listener.accept().await {
                Ok(t) => t,
                Err(e) => {
                    log::warn!("[M3a.1 lan-only] accept error: {}", e);
                    continue;
                }
            };
            log::info!("[M3a.1 lan-only] new peer from {}", peer_addr);
            // Handshake WebSocket
            let ws_stream = match accept_async(stream).await {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[M3a.1 lan-only] handshake error: {}", e);
                    continue;
                }
            };
            // Crea mpsc channel per questo peer
            let (tx, rx) = mpsc::channel::<Message>(PEER_SEND_QUEUE_CAP);
            let peer_key = peer_addr.to_string();
            LanState::instance().add_peer(peer_key.clone(), tx);
            // M3a.2 (PB4-B) — passa `app.clone()` a handle_peer per emit eventi.
            tokio::spawn(handle_peer(ws_stream, peer_key, rx, app.clone()));
        }
    });

    Ok(actual_addr)
}

/// Connette a un server WebSocket LAN su `addr` (es. "192.168.1.42:9876").
///
/// M3a.2 (PB4-B fix) — Aggiunto parametro `app: tauri::AppHandle` per
/// passar lo a `handle_peer`.
#[tauri::command]
pub async fn lan_connect(app: tauri::AppHandle, addr: String) -> AppResult<bool> {
    use tokio_tungstenite::connect_async;

    let url = format!("ws://{}", addr);
    let (ws_stream, _response) = connect_async(&url)
        .await
        .map_err(|e| AppError::Generic(format!("connect {}: {}", url, e)))?;

    log::info!("[M3a.1 lan-only] connected to {}", addr);
    // Crea mpsc channel per questo peer
    let (tx, rx) = mpsc::channel::<Message>(PEER_SEND_QUEUE_CAP);
    LanState::instance().add_peer(addr.clone(), tx);
    tokio::spawn(handle_peer(ws_stream, addr, rx, app));

    Ok(true)
}

/// Broadcast un update Yjs a tutti i peer connessi via WebSocket LAN.
///
/// M3a.1 (Fix aggiuntivo B) — Implementazione reale: invia `Message::Binary`
/// a tutti i peer connessi tramite i loro sender mpsc. Ogni task `handle_peer`
/// legge dal proprio receiver e scrive sul WebSocket.
#[tauri::command]
pub async fn lan_broadcast_update(update_bytes: Vec<u8>) -> AppResult<()> {
    let peers_count = LanState::instance().list_peers().len();
    if peers_count == 0 {
        log::debug!("[M3a.1 lan-only] broadcast: 0 peer connessi, skip");
        return Ok(());
    }
    let msg = Message::Binary(update_bytes.into());
    let sent = LanState::instance().broadcast(msg);
    log::info!(
        "[M3a.1 lan-only] broadcast inviato a {} / {} peer",
        sent,
        peers_count
    );
    Ok(())
}

/// Lista peer connessi (IP:port).
#[tauri::command]
pub fn lan_get_connected_peers() -> AppResult<Vec<String>> {
    Ok(LanState::instance().list_peers())
}

/// Disconnette un peer.
#[tauri::command]
pub fn lan_disconnect_peer(peer_key: String) -> AppResult<()> {
    LanState::instance().remove_peer(&peer_key);
    log::info!("[M3a.1 lan-only] peer {} disconnesso", peer_key);
    Ok(())
}

// ----------------------------------------------------------------------
// Helper: gestore di una connessione WebSocket (task di background)
// ----------------------------------------------------------------------

/// Gestisce una connessione WebSocket peer. Loop su `tokio::select!`:
///  - legge messaggi dal WebSocket → applica a yrs (path ricezione)
///  - legge messaggi dal receiver mpsc → scrive sul WebSocket (path invio)
///
/// M3a.1 (Fix aggiuntivo B) — In precedenza il task faceva solo `read.next()`
/// in loop senza mai usare il `write` half. Ora il loop usa `select!` per
/// gestire entrambe le direzioni simultaneamente.
///
/// M3a.2 (PB4-B fix) — Aggiunto parametro `app: tauri::AppHandle`. Quando
/// arriva un `Message::Binary(bytes)`, oltre ad applicare l'update al Doc yrs
/// locale (`yjs_apply_update`), emette l'evento Tauri `sync-update-received`
/// con i bytes nel payload — identico al path Iroh di `sync.rs:434`. Il
/// frontend (listener in `SyncView.tsx`) riceve l'evento, chiama
/// `applyRemoteUpdate(new Uint8Array(bytes))` → `Y.applyUpdate` sul Y.Doc
/// frontend → triggera `yPlayers.observe` → `save_player_from_sync` →
/// SQLite del peer ricevente aggiornato.
async fn handle_peer<S>(
    ws_stream: S,
    peer_key: String,
    mut rx: mpsc::Receiver<Message>,
    app: tauri::AppHandle,
) where
    S: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::tungstenite::stream::MaybeTls<tokio::net::TcpStream>,
    >,
{
    use futures_util::{SinkExt, StreamExt};

    let (mut write, mut read) = ws_stream.split();

    loop {
        tokio::select! {
            // Path ricezione: messaggio dal WebSocket del peer remoto
            msg_in = read.next() => {
                match msg_in {
                    Some(Ok(msg)) => match msg {
                        Message::Binary(bytes) => {
                            // Update Yjs ricevuto: applica al Doc yrs locale.
                            let bytes_len = bytes.len();
                            // M3a.2 (PB4-B) — Emette l'evento `sync-update-received`
                            // CON i bytes nel payload, come nel path Iroh. Il frontend
                            // listener chiama `applyRemoteUpdate(bytes)` → persistenza
                            // SQLite del peer ricevente via `save_*_from_sync`.
                            let _ = app.emit(
                                "sync-update-received",
                                serde_json::json!({
                                    "update_bytes": bytes.to_vec(),
                                    "bytes_len": bytes_len,
                                    "from_peer": peer_key.clone(),
                                }),
                            );
                            // Applica l'update al Doc yrs Rust (per allineamento
                            // state-vector; la persistenza SQLite è gestita dal
                            // bridge frontend).
                            if let Err(e) =
                                crate::commands::sync::yjs_apply_update(bytes.to_vec())
                            {
                                log::warn!(
                                    "[M3a.2 lan-only] yjs_apply_update fallito da {}: {}",
                                    peer_key,
                                    e
                                );
                            }
                        }
                        Message::Text(t) => {
                            log::debug!("[M3a.1 lan-only] text from {}: {}", peer_key, t);
                        }
                        Message::Close(_) => {
                            log::info!("[M3a.1 lan-only] peer {} closed", peer_key);
                            break;
                        }
                        _ => {}
                    },
                    Some(Err(e)) => {
                        log::warn!("[M3a.1 lan-only] ws error from {}: {}", peer_key, e);
                        break;
                    }
                    None => {
                        log::info!("[M3a.1 lan-only] peer {} stream closed", peer_key);
                        break;
                    }
                }
            }
            // Path invio: messaggio dal broadcast command → scrivi sul WebSocket
            msg_out = rx.recv() => {
                match msg_out {
                    Some(msg) => {
                        if let Err(e) = write.send(msg).await {
                            log::warn!(
                                "[M3a.1 lan-only] send error to {}: {}",
                                peer_key,
                                e
                            );
                            break;
                        }
                    }
                    None => {
                        // Sender droppato (lan_disconnect_peer): chiudi gracefully
                        log::info!("[M3a.1 lan-only] sender droppato per {}", peer_key);
                        let _ = write.close().await;
                        break;
                    }
                }
            }
        }
    }

    LanState::instance().remove_peer(&peer_key);
    let _ = write.close().await;
}

// ----------------------------------------------------------------------
// mDNS discovery (M3a.1 fix aggiuntivo B)
// ----------------------------------------------------------------------

/// Tipo di servizio mDNS per DossierFanta LAN sync.
const MDNS_SERVICE_TYPE: &str = "_dossierfanta._tcp.local.";

/// Registra il servizio mDNS `_dossierfanta._tcp.local.` per il server
/// WebSocket LAN corrente. Best-effort: ritorna Ok(()) anche se fallisce
/// (il pairing manuale via `lan_connect` rimane disponibile).
///
/// Ritorna un `ServiceDaemon` che va tenuto in vita per tutta la durata
/// del server (altrimenti il servizio viene deregistrato). Lo salviamo
/// in una `OnceLock` statica per mantenerlo vivo.
async fn register_mdns_service(addr: &str) -> AppResult<()> {
    use mdns_sd::{ServiceDaemon, ServiceInfo};
    use std::net::IpAddr;

    // Parse addr: "0.0.0.0:9876" → ip + port
    let parts: Vec<&str> = addr.rsplitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(AppError::Generic(format!(
            "addr {} non nel formato IP:port",
            addr
        )));
    }
    let port: u16 = parts[0].parse().unwrap_or(0);
    let ip_str = parts[1];
    let ip: IpAddr = ip_str
        .parse()
        .map_err(|e| AppError::Generic(format!("ip {}: {}", ip_str, e)))?;

    // Crea il daemon mDNS (avvia il thread di discovery UDP multicast)
    let daemon = ServiceDaemon::new()
        .map_err(|e| AppError::Generic(format!("mdns daemon: {}", e)))?;

    // Hostname univoco per evitare collisioni se più istanze girano sulla stessa macchina
    let hostname = format!("dossierfanta-{:x}", std::process::id());
    let host = format!("{}.local.", hostname);

    // Costruisci service info
    let service_info = ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        &hostname,
        &host,
        ip,
        port,
        None, // nessun TXT record per ora
    )
    .map_err(|e| AppError::Generic(format!("mdns service info: {}", e)))?;

    // Registra il servizio
    daemon
        .register(service_info)
        .map_err(|e| AppError::Generic(format!("mdns register: {}", e)))?;

    // Salva il daemon in OnceLock per tenerlo in vita
    static MDNS_DAEMON: OnceLock<Mutex<Option<ServiceDaemon>>> = OnceLock::new();
    let cell = MDNS_DAEMON.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = cell.lock() {
        *g = Some(daemon);
    }

    log::info!(
        "[M3a.1 lan-only] mDNS servizio {} registrato su {}:{} (host={})",
        MDNS_SERVICE_TYPE,
        ip,
        port,
        host
    );
    Ok(())
}

/// Cerca peer DossierFanta sulla LAN via mDNS. Ritorna una lista di
/// `addr:port` (ws://peer:port) da passare a `lan_connect`.
///
/// Attende fino a `timeout_ms` per raccogliere i servizi annunciati.
#[tauri::command]
pub async fn lan_discover_peers(timeout_ms: Option<u64>) -> AppResult<Vec<String>> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    use std::time::Duration;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(2000));

    let daemon = ServiceDaemon::new()
        .map_err(|e| AppError::Generic(format!("mdns daemon: {}", e)))?;

    let receiver = daemon
        .browse(MDNS_SERVICE_TYPE)
        .map_err(|e| AppError::Generic(format!("mdns browse: {}", e)))?;

    let mut peers: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        tokio::select! {
            event = receiver.recv_async() => {
                match event {
                    Ok(ServiceEvent::ServiceResolved(info)) => {
                        for addr in info.get_addresses() {
                            let peer_addr = format!("{}:{}", addr, info.get_port());
                            if !peers.contains(&peer_addr) {
                                peers.push(peer_addr);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("[M3a.1 lan-only] mdns recv error: {}", e);
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(remaining) => {
                // Timeout scaduto: ritorna i peer trovati finora
                break;
            }
        }
    }

    log::info!(
        "[M3a.1 lan-only] mDNS discovery: trovati {} peer(s) in {:?}",
        peers.len(),
        timeout
    );
    Ok(peers)
}

// Re-export per il modulo sync.rs se serve
// (non usato direttamente, ma esposto per futura integrazione)
#[allow(dead_code)]
pub fn lan_service_type() -> &'static str {
    MDNS_SERVICE_TYPE
}
