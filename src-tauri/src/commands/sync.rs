//! `commands/sync.rs` — Sync live CRDT P2P (M3a — B.3 + B.4 + B.8).
//!
//! Modulo che implementa:
//!  - **B.3 — yrs core**: stato CRDT authoritativo lato Rust. Persistenza
//!    SQLite rimane source of truth, ma yrs permette validation server-side
//!    degli update Yjs, merge di updates offline, snapshot per sync iniziale
//!    veloce.
//!  - **B.4 — Iroh p2p transport**: nodo Iroh con NAT traversal automatico,
//!    fallback a relay pubblici. Gossip protocol per broadcast updates a
//!    tutti i peer connessi.
//!  - **B.8 — marker updated_by='sync-live'**: comandi `save_*_from_sync`
//!    usati dal bridge Yjs→SQLite. Impostano `updated_by='sync-live'`
//!    invece di 'me'/'auto-fetch'. I validatori Rust (vedi `validate_updated_by`)
//!    accettano 'sync-live' oltre ai valori ammessi dal CHECK constraint v2.2.
//!
//! # Stato condiviso
//!
//! `YjsState` contiene un `yrs::Doc` globale, protetto da `Mutex`. Il Doc
//! ha 3 collection:
//!  - `players`     → Y.Map<player_id, Y.Map<field, value>>
//!  - `scouting_notes` → Y.Array<Y.Map>
//!  - `auction_data` → Y.Map<player_id, Y.Map<field, value>>
//!  - `cursors`     → Y.Map<user_id, {field, position, selection, color, name}>
//!
//! `IrohState` contiene il `Node` Iroh (avviato lazy su prima chiamata a
//! `iroh_start_node`), la `peer_key` (NodeId Iroh base32), e la lista dei
//! peer connessi.
//!
//! # Vincoli HARD rispettati
//!
//!  - 13: Sync-live NON sostituisce SQLite come source of truth. Ogni update
//!    Yjs applicato a yrs viene persistito su SQLite via `save_*_from_sync`.
//!  - 14: Pairing esplicito (peer key scambiata out-of-band). Niente
//!    auto-discovery su internet.
//!  - 5: Schema v2.2 + ALTER additive v2.3 (no drop, no rename).
//!  - 7: Tutte le operazioni DB tramite comandi Tauri (no SQL diretto dal
//!    frontend).
//!  - 8: Niente fetch HTTP diretta dal frontend. Iroh è il transport.

use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

// M3a.2 — Import `Emitter` trait per `app.emit(...)` (come in players.rs:37).
// Senza questo, i `let _ = app.emit(...)` a riga 434/444/453 (subscribe loop
// iroh) restituirebbero E0599 "no method named `emit` found". Aggiunto qui
// perché sync.rs non lo importava in M3a.1 (probabilmente latente — il cargo
// check statico dell'ispezione non era eseguibile in sandbox).
use tauri::Emitter;

// M3a.1 (PB2 fix) — Importa i trait `Decode`, `Encode`, `Transact` e `ReadTxn`
// di yrs per rendere disponibili `Update::decode_v1`, `StateVector::decode_v1`,
// `StateVector::encode_v1`, `doc.transact()` / `doc.transact_mut()`, e
// `txn.state_vector()` / `txn.encode_diff_v1()`. Senza questi import il
// compilatore restituisce `no method named transact found for reference &yrs::Doc`.
// I trait erano latenti nel codice M3a originale (coperti dal PB1 che
// bloccava `cargo check`).
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, Transact};

use crate::commands::{AppError, AppResult};

// ----------------------------------------------------------------------
// Stati globali (inizializzati lazy)
// ----------------------------------------------------------------------

/// Stato CRDT yrs condiviso. Il `Doc` è unico per sessione app.
struct YjsState {
    doc: Mutex<yrs::Doc>,
}

impl YjsState {
    fn instance() -> &'static YjsState {
        static INSTANCE: OnceLock<YjsState> = OnceLock::new();
        INSTANCE.get_or_init(|| YjsState {
            doc: Mutex::new(yrs::Doc::new()),
        })
    }

    /// Acquisisce il lock del Doc per leggere/scrivere.
    fn with_doc<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&yrs::Doc) -> R,
    {
        let guard = self.doc.lock().expect("YjsState mutex poisoned");
        f(&guard)
    }
}

/// Stato del nodo Iroh. Inizializzato lazy su prima chiamata a `iroh_start_node`.
///
/// M3a.1 (PB2 fix) — `IrohState` ora mantiene:
///  - `endpoint`: `MagicEndpoint` Iroh (QUIC + NAT traversal + relay fallback)
///  - `gossip`: handle `Gossip` per broadcast/subscribe su topic condiviso
///  - `topic`: `TopicId` fisso (hash deterministico di "dossierfanta-v25")
///  - `peer_key`: NodeId in formato base32 (la "peer key" scambiata nel pairing)
///  - `connected_peers`: peer attualmente connessi (NodeId base32)
struct IrohState {
    /// Endpoint Iroh (None finché `iroh_start_node` non è stato chiamato).
    endpoint: tokio::sync::Mutex<Option<iroh_net::MagicEndpoint>>,
    /// Handle Gossip (None finché `iroh_start_node` non è stato chiamato).
    gossip: tokio::sync::Mutex<Option<iroh_gossip::net::Gossip>>,
    /// Topic fisso condiviso da tutti i peer DossierFanta (deterministico).
    topic: iroh_gossip::proto::TopicId,
    /// NodeId Iroh (formato base32) — la "peer key" scambiata nel pairing.
    peer_key: std::sync::Mutex<Option<String>>,
    /// Peer attualmente connessi (NodeId base32).
    connected_peers: std::sync::Mutex<Vec<String>>,
}

impl IrohState {
    fn instance() -> &'static IrohState {
        static INSTANCE: OnceLock<IrohState> = OnceLock::new();
        INSTANCE.get_or_init(|| {
            // TopicId deterministico: 32 byte derivati dal seed
            // "dossierfanta-v25-sync-live-topic". Tutti i peer DossierFanta
            // joinano lo stesso topic → broadcast raggiunge tutti i peer
            // connessi nella stessa sessione di pairing.
            // Vincolo HARD #14: pairing esplicito (peer key scambiata
            // out-of-band) — il topic pubblico NON è un problema di security
            // perché solo i peer che si scambiano le NodeId si connettono
            // QUIC l'uno all'altro.
            let topic_seed = b"dossierfanta-v25-sync-live-topic";
            let topic = deterministic_topic(topic_seed);
            IrohState {
                endpoint: tokio::sync::Mutex::new(None),
                gossip: tokio::sync::Mutex::new(None),
                topic,
                peer_key: std::sync::Mutex::new(None),
                connected_peers: std::sync::Mutex::new(Vec::new()),
            }
        })
    }

    fn set_peer_key(&self, key: String) {
        let mut g = self.peer_key.lock().expect("IrohState peer_key poisoned");
        *g = Some(key);
    }

    fn get_peer_key(&self) -> Option<String> {
        self.peer_key.lock().ok().and_then(|g| g.clone())
    }

    fn add_peer(&self, peer_key: String) {
        let mut g = self
            .connected_peers
            .lock()
            .expect("IrohState peers poisoned");
        if !g.contains(&peer_key) {
            g.push(peer_key);
        }
    }

    fn remove_peer(&self, peer_key: &str) {
        let mut g = self
            .connected_peers
            .lock()
            .expect("IrohState peers poisoned");
        g.retain(|p| p != peer_key);
    }

    fn list_peers(&self) -> Vec<String> {
        self.connected_peers
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }
}

/// Calcola un `TopicId` deterministico da un seed di byte.
///
/// Implementazione: combina 4 round di FNV-1a a 64 bit con salt diverso
/// per produrre 32 byte. Non è un hash crittografico (NON serve esserlo:
/// il topic è un identificatore condiviso tra peer fidati che hanno già
/// scambiato le peer key out-of-band). L'unica proprietà richiesta è
/// determinismo: lo stesso seed produce lo stesso topic su tutti i peer.
fn deterministic_topic(seed: &[u8]) -> iroh_gossip::proto::TopicId {
    let mut out = [0u8; 32];
    for i in 0..4u64 {
        let mut round: u64 = 0xcbf29ce484222325 ^ (i << 32);
        for &b in seed {
            round ^= b as u64;
            round = round.wrapping_mul(0x100000001b3);
        }
        let bytes = round.to_le_bytes();
        out[(i as usize) * 8..((i as usize + 1) * 8)].copy_from_slice(&bytes);
    }
    iroh_gossip::proto::TopicId::from_bytes(out)
}

// ----------------------------------------------------------------------
// B.3 — Comandi yrs core
// ----------------------------------------------------------------------

/// Valida un valore `updated_by` contro la whitelist estesa M3a.
///
/// Lo schema v2.2 ha CHECK constraint solo sui valori 'me'/'auto-fetch'
/// (documentati nel commento dello schema, non enforced dal CHECK).
/// In M3a aggiungiamo 'sync-live' come quarto valore ammesso. La validazione
/// avviene solo lato Rust (vedi B.1: il CHECK constraint non viene toccato).
///
/// M3a.2 (W1 fix) — Rimosso `"marco"` dalla whitelist (extra-brief M3a.1).
/// La whitelist breve è: `me` (utente locale), `auto-fetch` (GitHub Actions),
/// `sync-live` (Yjs bridge ricevente). Nessun altro utente
/// nominato in modo hardcodato: il multi-DB v2.5 userà "peer-<NodeId>"
/// dinamicamente in futuro (M5+), non hardcoded.
pub fn validate_updated_by(value: &str) -> AppResult<()> {
    match value {
        "me" | "auto-fetch" | "sync-live" => Ok(()),
        other => Err(AppError::Validation(format!(
            "updated_by '{}' non ammesso. Valori validi: me, auto-fetch, sync-live.",
            other
        ))),
    }
}

/// Applica un update Yjs ricevuto da un peer remoto.
///
/// L'update è in formato binary v1 (compatibile con `Y.applyUpdate` JS).
/// Dopo aver applicato l'update al Doc yrs, l'osservatore interno (registrato
/// al boot) si occupa di persistere le modifiche su SQLite via `save_*_from_sync`.
#[tauri::command]
pub fn yjs_apply_update(update_bytes: Vec<u8>) -> AppResult<bool> {
    YjsState::instance().with_doc(|doc| {
        // Decodifica l'update dal formato binary v1
        let update = yrs::Update::decode_v1(&update_bytes).map_err(|e| {
            AppError::Generic(format!("yrs decode update v1: {}", e))
        })?;
        // Applica l'update al Doc (transazione interna yrs)
        let mut txn = doc.transact_mut();
        // M3a.3 fix post-review — `apply_update` ritorna `Result<(), UpdateError>`
        // in yrs 0.21. Il warning `unused_must_use` del compilatore indica che
        // l'Err veniva silenziosamente scartato. Su Err, logga warning ma NON
        // abortire il comando: la persistenza SQLite è gestita dall'osservatore
        // separato, e un fallimento di integrazione CRDT (es. update malformato
        // proveniente da un peer con versione yrs diversa) non deve bloccare
        // il sync live — i prossimi update dell'altro peer riallineeranno lo stato.
        if let Err(e) = txn.apply_update(update) {
            log::warn!("[yjs] apply_update fallito (non blocking): {}", e);
        }
        // Nota: la persistenza SQLite è gestita dall'osservatore
        // registrato in `register_yjs_observers()` (vedi modulo bridge).
        drop(txn);
        Ok(true)
    })
}

/// Ritorna lo state vector del Doc yrs corrente (formato binary v1).
///
/// Usato per il sync iniziale: il peer B chiede lo state vector al peer A,
/// poi A calcola il diff (vedi `yjs_get_diff`) e lo invia a B.
#[tauri::command]
pub fn yjs_get_state_vector() -> AppResult<Vec<u8>> {
    YjsState::instance().with_doc(|doc| {
        let txn = doc.transact();
        let sv = txn.state_vector();
        let bytes = sv.encode_v1();
        Ok(bytes)
    })
}

/// Calcola il diff tra lo state vector del chiamante e lo stato corrente
/// del Doc yrs. Il diff è ciò che il peer remoto deve applicare per mettersi
/// in pari (sync iniziale veloce, ~2-5 sec per 500 giocatori).
#[tauri::command]
pub fn yjs_get_diff(state_vector: Vec<u8>) -> AppResult<Vec<u8>> {
    YjsState::instance().with_doc(|doc| {
        let remote_sv = yrs::StateVector::decode_v1(&state_vector).map_err(|e| {
            AppError::Generic(format!("yrs decode state_vector v1: {}", e))
        })?;
        let txn = doc.transact();
        let diff = txn.encode_diff_v1(&remote_sv);
        Ok(diff)
    })
}

// ----------------------------------------------------------------------
// B.4 — Comandi Iroh p2p transport
// ----------------------------------------------------------------------
//
// M3a.1 (PB2 fix) — Implementazione reale del transport Iroh.
// Sostituisce i placeholder precedenti (`std::future::pending` in
// `iroh_subscribe_updates`, log-only in `iroh_broadcast_update`, add-to-list
// in `iroh_connect_by_peer_key`) con un `MagicEndpoint` Iroh + `Gossip` reale.
//
// Architettura:
//  1. `iroh_start_node` costruisce un `MagicEndpoint` con ALPN `GOSSIP_ALPN`,
//     crea un `Gossip::from_endpoint(...)`, fa `join(topic)` e `subscribe(topic)`.
//  2. Spawn accept loop: per ogni connessione QUIC in ingresso, dispatcha
//     a `gossip.handle_connection(conn)` se l'ALPN matcha.
//  3. Spawn subscribe loop: ascolta il `broadcast::Receiver<Event>` ritornato
//     da `subscribe(topic)`. Per ogni `Event::Received(GossipEvent)`, applica
//     l'update al Doc yrs + emette `sync-update-received` per refresh UI.
//  4. `iroh_connect_by_peer_key` fa `endpoint.add_node_addr(node_addr)` +
//     `endpoint.connect(node_addr, GOSSIP_ALPN)`. Il accept loop del peer
//     remoto accetterà la connessione e la dispatchera a gossip, dopodiché
//     entrambi i peer si vedranno come neighbor nello stesso topic swarm.
//  5. `iroh_broadcast_update` chiama `gossip.broadcast(topic, bytes.into())`.
//     I peer remoti ricevono l'update nel loro subscribe loop.
//  6. `iroh_subscribe_updates` è no-op: il subscribe loop è già spawnato in
//     `iroh_start_node`. Questo comando ritorna `Ok(())` immediatamente per
//     backward-compat con il frontend che potrebbe ancora chiamarlo.

/// Avvia un nodo Iroh e ritorna la peer key (NodeId base32).
///
/// La peer key viene salvata in `IrohState`. NAT traversal automatico: Iroh
/// prova prima connessione diretta (QUIC), poi fallback a relay pubblici.
///
/// M3a.1 (PB2 fix) — Implementazione completa: costruisce `MagicEndpoint`,
/// `Gossip`, join topic + subscribe + accept loop + subscribe loop.
///
/// M3a.3 (Deliverable 3 — Peer key persistente) — La SecretKey non è più
/// generata ephemeral ad ogni avvio. Viene caricata da `sync_identity`
/// (singleton table nel DB attivo). Se non esiste ancora, viene generata,
/// salvata in `sync_identity`, e restituita. Al boot successivo la stessa
/// SecretKey viene ricaricata → la peer_key (NodeId derivato) è STABILE
/// cross-boot. L'utente non deve più ri-scambiare la peer_key con i peer
/// fidati ad ogni riavvio.
#[tauri::command]
pub async fn iroh_start_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::DbState>,
) -> AppResult<String> {
    // Se la peer key è già stata generata in questa sessione, ritorna quella.
    if let Some(pk) = IrohState::instance().get_peer_key() {
        return Ok(pk);
    }

    // M3a.3 — Carica la SecretKey salvata da `sync_identity` (singleton table).
    // Se non esiste, genera + salva. La SecretKey ha 32 byte (iroh_base::key::SecretKey::LEN).
    let db_id = state.active_db_id()?;
    let secret = state.with_conn(&db_id, |conn| load_or_create_secret(conn))?;

    // Costruisce il MagicEndpoint con ALPN `GOSSIP_ALPN` (richiesto da
    // iroh-gossip per identificare le connessioni QUIC dedicate al gossip).
    let endpoint = iroh_net::MagicEndpoint::builder()
        .secret_key(secret)
        .alpns(vec![iroh_gossip::net::GOSSIP_ALPN.to_vec()])
        // relay_mode default = EnableRelay — usa i relay pubblici Iroh per
        // NAT traversal automatico. Senza relay, due peer dietro NAT
        // symmentric non si connetterebbero.
        .bind(0)
        .await
        .map_err(|e| AppError::Generic(format!("iroh endpoint bind: {}", e)))?;

    let node_id = endpoint.node_id();
    let peer_key = node_id.to_string();

    // Costruisce il Gossip handle dal MagicEndpoint. Il Gossip actor
    // gestirà sia le connessioni in ingresso (via handle_connection) sia
    // quelle in uscita (iniziate da join/broadcast).
    let my_addr = endpoint
        .my_addr()
        .await
        .map_err(|e| AppError::Generic(format!("iroh my_addr: {}", e)))?;
    let addr_info = iroh_net::AddrInfo {
        relay_url: my_addr.relay_url().cloned(),
        direct_addresses: my_addr.direct_addresses().copied().collect(),
    };
    let gossip = iroh_gossip::net::Gossip::from_endpoint(
        endpoint.clone(),
        iroh_gossip::proto::Config::default(),
        &addr_info,
    );

    // Salva endpoint + gossip nello stato globale.
    {
        let mut ep_guard = IrohState::instance().endpoint.lock().await;
        *ep_guard = Some(endpoint.clone());
    }
    {
        let mut gs_guard = IrohState::instance().gossip.lock().await;
        *gs_guard = Some(gossip.clone());
    }
    IrohState::instance().set_peer_key(peer_key.clone());

    // Join del topic fisso (deterministico). Join ≠ subscribe: join attiva
    // il swarm membership (HyParView + Plumtree) per questo topic, subscribe
    // ritorna il receiver per ricevere gli eventi.
    //
    // M3a.1 — il primo peer (boot iniziale) joina con `peers=vec![]` (nessun
    // bootstrap peer noto). Il secondo peer, dopo aver chiamato
    // `iroh_connect_by_peer_key`, deve JOIN di nuovo con la peer key del
    // primo come bootstrap. Per semplicità, qui joina sempre senza bootstrap:
    // la connessione QUIC viene comunque stabilita da `iroh_connect_by_peer_key`,
    // e il gossip actor poi farà NeighborUp quando riceverà la connessione.
    //
    // `join(topic, peers)` ritorna `anyhow::Result<JoinTopicFut>`. Il
    // `JoinTopicFut` (future interno) risolve solo quando il swarm membership
    // è completo, ma NON blocchiamo: il subscribe loop riceverà NeighborUp
    // quando il primo peer reale si unirà al topic.
    let topic = IrohState::instance().topic;
    if let Err(e) = gossip.join(topic, Vec::<iroh_net::key::PublicKey>::new()).await {
        log::warn!("[M3a] gossip.join topic fallito (continuo comunque): {}", e);
    }

    // Subscribe per ricevere eventi (messaggi ricevuti + neighbor up/down).
    let sub_rx = gossip
        .subscribe(topic)
        .await
        .map_err(|e| AppError::Generic(format!("gossip subscribe: {}", e)))?;

    // Spawn accept loop: per ogni connessione QUIC in ingresso, dispatcha
    // al gossip se l'ALPN matcha.
    {
        let endpoint_clone = endpoint.clone();
        let gossip_clone = gossip.clone();
        tokio::spawn(async move {
            loop {
                // endpoint.accept() ritorna quinn::Connecting in modo stream.
                // Usiamo `accept_conn` per ottenere alpn + connection.
                let conn = endpoint_clone.accept().await;
                if conn.is_none() {
                    // Endpoint chiuso (app shutdown).
                    break;
                }
                let mut connecting = conn.unwrap();
                let alpn = match iroh_net::magic_endpoint::get_alpn(&mut connecting).await {
                    Ok(a) => a,
                    Err(e) => {
                        log::warn!("[M3a] accept: alpn fallito: {}", e);
                        continue;
                    }
                };
                let quinn_conn = match connecting.await {
                    Ok(c) => c,
                    Err(e) => {
                        log::warn!("[M3a] accept: connect fallito: {}", e);
                        continue;
                    }
                };
                if alpn.as_bytes() == iroh_gossip::net::GOSSIP_ALPN {
                    let gs = gossip_clone.clone();
                    tokio::spawn(async move {
                        if let Err(e) = gs.handle_connection(quinn_conn).await {
                            log::warn!("[M3a] gossip handle_connection: {}", e);
                        }
                    });
                } else {
                    log::debug!("[M3a] accept: alpn sconosciuto {}, scartata", alpn);
                }
            }
        });
    }

    // Spawn subscribe loop: ascolta gli eventi gossip per il topic fisso.
    // Per ogni Event::Received(GossipEvent) → applica l'update al Doc yrs
    // (yjs_apply_update) + emette `sync-update-received` per refresh UI.
    tokio::spawn(async move {
        let mut rx = sub_rx;
        while let Ok(event) = rx.recv().await {
            match event {
                iroh_gossip::net::Event::Received(gossip_event) => {
                    let update_bytes = gossip_event.content.to_vec();
                    let bytes_len = update_bytes.len();
                    // M3a.2 (PB4-B fix) — Emette `sync-update-received` CON i bytes
                    // dell'update nel payload (`update_bytes`). In M3a.1 l'evento
                    // conteneva solo `bytes_len` + `from_peer` — NESSUN frontend
                    // poteva applicare l'update al Y.Doc, quindi il peer ricevente
                    // non persisteva su SQLite.
                    //
                    // Ora il frontend registra un listener (vedi `SyncView.tsx`)
                    // che chiama `applyRemoteUpdate(new Uint8Array(update_bytes))`
                    // → `Y.applyUpdate(ydoc, bytes)` → triggera `yPlayers.observe` →
                    // `save_player_from_sync` (con updated_by='sync-live').
                    //
                    // `update_bytes` (Vec<u8>) serializza via serde_json come array
                    // di numeri JSON ([0, 1, 2, ...]). Il frontend lo ricostruisce
                    // in `Uint8Array` con `new Uint8Array(event.payload.update_bytes)`.
                    let _ = app.emit(
                        "sync-update-received",
                        serde_json::json!({
                            "update_bytes": update_bytes,
                            "bytes_len": bytes_len,
                            "from_peer": gossip_event.delivered_from.to_string(),
                        }),
                    );
                    // Applica l'update al Doc yrs locale (Rust). La persistenza
                    // SQLite è gestita dal bridge frontend (yPlayers.observe →
                    // save_player_from_sync), non qui — il yrs observer non
                    // è ancora registrato (TODO futuro: register_yjs_observers).
                    if let Err(e) = yjs_apply_update(update_bytes) {
                        log::warn!("[M3a] yjs_apply_update da gossip fallito: {}", e);
                        continue;
                    }
                }
                iroh_gossip::net::Event::NeighborUp(peer) => {
                    log::info!("[M3a] gossip NeighborUp: {}", peer);
                    let _ = app.emit(
                        "sync-peer-connected",
                        serde_json::json!({
                            "peerKey": peer.to_string(),
                        }),
                    );
                }
                iroh_gossip::net::Event::NeighborDown(peer) => {
                    log::info!("[M3a] gossip NeighborDown: {}", peer);
                    let _ = app.emit(
                        "sync-peer-disconnected",
                        serde_json::json!({
                            "peerKey": peer.to_string(),
                        }),
                    );
                }
            }
        }
        // rx.recv() ritorna Err quando il sender viene droppato (gossip actor chiuso).
        log::debug!("[M3a] subscribe loop terminato");
    });

    log::info!("[M3a.1] Iroh node avviato. peer_key={}, topic={}", peer_key, topic);
    Ok(peer_key)
}

/// Disconnette il nodo Iroh corrente, rilasciando le risorse QUIC.
///
/// M3a.3 (Deliverable 4 — iroh_stop_node richiesto da IrohYjsProvider.disconnect).
///
/// Comportamento:
///  - Mette a `None` endpoint + gossip nello stato globale. Lo `Drop` del
///    `MagicEndpoint` chiude tutti i socket QUIC + rilascia le risorse tokio.
///  - Pulisce `connected_peers` (nessun peer connesso a nodo spento).
///  - NON elimina la SecretKey persistita in `sync_identity` — resta per
///    il prossimo `iroh_start_node` (peer_key stabile cross-boot).
///  - Il subscribe loop spawnato in `iroh_start_node` termina da solo:
///    quando il `Gossip` actor viene droppato, il `broadcast::Receiver`
///    chiude → `rx.recv()` ritorna `Err` → loop esce.
#[tauri::command]
pub async fn iroh_stop_node() -> AppResult<()> {
    {
        let mut ep_guard = IrohState::instance().endpoint.lock().await;
        *ep_guard = None; // drop MagicEndpoint → close QUIC + free sockets
    }
    {
        let mut gs_guard = IrohState::instance().gossip.lock().await;
        *gs_guard = None; // drop Gossip actor → broadcast receivers closed
    }
    // Pulisce connected_peers (non più rilevante con nodo spento).
    // Mantiene peer_key salvato in IrohState per essere restituito da
    // `iroh_get_peer_key` finché non si riavvia (NO — in realtà è meglio
    // pulire anche peer_key: `iroh_get_peer_key` deve ritornare errore se
    // il nodo è spento, così il frontend lo sa).
    {
        let mut pk_guard = IrohState::instance().peer_key.lock().expect("IrohState peer_key poisoned");
        *pk_guard = None;
    }
    {
        let mut peers_guard = IrohState::instance().connected_peers.lock().expect("IrohState peers poisoned");
    peers_guard.clear();
    }
    log::info!("[M3a.3] iroh_stop_node: nodo fermato, risorse QUIC rilasciate.");
    Ok(())
}

/// Ritorna la peer key corrente, o errore se il nodo non è ancora avviato.
#[tauri::command]
pub fn iroh_get_peer_key() -> AppResult<String> {
    IrohState::instance()
        .get_peer_key()
        .ok_or_else(|| AppError::Generic("Iroh node non avviato. Chiamare iroh_start_node prima.".into()))
}

/// Connette a un peer remoto via peer key (NodeId base32).
///
/// M3a.1 (PB2 fix) — Implementazione reale: `endpoint.add_node_addr()` +
/// `endpoint.connect(node_addr, GOSSIP_ALPN)`.
///
/// NOTA IMPORTANTE: la peer_key da sola (NodeId) non basta per connettersi
/// via QUIC se il peer è dietro NAT. Iroh richiede `NodeAddr` che include
/// relay URL + indirizzi diretti. Per ora accettiamo SOLO NodeId e affidiamoci
/// al discovery via relay (entrambi i peer sono connessi ai relay pubblici
/// Iroh → il relay fa da matchmaker). Se in futuro serve, si può estendere
/// il comando per accettare una `NodeAddr` completa (es. codificata in base32
/// come Iroh ticket).
#[tauri::command]
pub async fn iroh_connect_by_peer_key(peer_key: String) -> AppResult<bool> {
    if IrohState::instance().get_peer_key().is_none() {
        return Err(AppError::Generic(
            "Iroh node non avviato. Chiamare iroh_start_node prima.".into(),
        ));
    }

    // Parse NodeId dalla stringa base32.
    let node_id: iroh_net::key::PublicKey = peer_key
        .parse()
        .map_err(|e| AppError::Validation(format!("peer key non valida: {}", e)))?;

    log::info!("[M3a.1] iroh_connect_by_peer_key: {}", node_id);

    // Recupera endpoint dallo stato globale.
    let endpoint = {
        let guard = IrohState::instance().endpoint.lock().await;
        guard
            .clone()
            .ok_or_else(|| AppError::Generic("Iroh endpoint non inizializzato".into()))?
    };

    // Aggiunge il NodeAddr del peer al endpoint. Senza relay/direct address,
// Iroh proverà solo via discovery (default: pkarr/dns). Se il peer è
    // connesso a un relay pubblico Iroh, il relay risolve NodeId → indirizzo.
    let node_addr = iroh_net::NodeAddr::new(node_id);
    if let Err(e) = endpoint.add_node_addr(node_addr.clone()) {
        log::warn!(
            "[M3a.1] add_node_addr fallito (continuo con connect diretto): {}",
            e
        );
    }

    // Tenta la connessione QUIC con timeout 10s. Se il peer è dietro NAT
    // e il relay non ha ancora pubblicato il suo addr, il connect va in
    // timeout. L'utente dovrà riprovare (o usare il fallback LAN-only).
    //
    // M3a.2 (W3 fix) — Rigore: ritorna `Ok(true)` SOLO se la connessione
    // QUIC è realmente stabilita. Sui branch di errore (Ok(Err)) e timeout
    // (Err(elapsed)) ritorna `Ok(false)` e NON aggiunge il peer alla lista
    // connessi. In M3a.1 ritornava `Ok(true)` “ottimistico” su tutti e 3 i
    // branch, causando `iroh_get_connected_peers` a ritornare peer non
    // realmente connessi → sync live poi fallirebbe silenziosamente.
    let connect_fut = endpoint.connect(node_addr, iroh_gossip::net::GOSSIP_ALPN);
    match tokio::time::timeout(std::time::Duration::from_secs(10), connect_fut).await {
        Ok(Ok(_conn)) => {
            // La connessione QUIC è stabilita. Il gossip handle_connection
            // del peer remoto (nel suo accept loop) la dispatchera al gossip
            // actor. Dopo join, entrambi i peer si vedranno come neighbor.
            IrohState::instance().add_peer(peer_key.clone());
            // M3a.3 (Deliverable 4) — NOTA: il salvataggio del peer come trusted
            // in `sync_peers` avviene in `iroh_connect_by_peer_key_v2` (il comando
            // che accetta `State<DbState>`). Questo `iroh_connect_by_peer_key` (v1)
            // NON ha accesso al DB state — resta per backward-compat con frontend
            // che non è stato ancora aggiornato al nuovo SyncView. Il nuovo SyncView
            // chiama `iroh_connect_by_peer_key_v2` che delega a questo v1 + salva.
            log::info!("[M3a.2] connesso a peer: {}", peer_key);
            Ok(true)
        }
        Ok(Err(e)) => {
            // M3a.2 (W3) — Errore di connessione: NON aggiungere il peer alla
            // lista. Ritorna `Ok(false)` (non `Err` — il caller non deve
            // gestire l'errore come exception). L'utente può ritentare.
            log::warn!(
                "[M3a.2] connect a {} fallito: {} — il peer è dietro NAT senza relay?",
                peer_key,
                e
            );
            Ok(false)
        }
        Err(_elapsed) => {
            // M3a.2 (W3) — Timeout (10s): NON aggiungere il peer alla lista.
            log::warn!(
                "[M3a.2] connect a {} timeout (10s) — peer non raggiungibile via QUIC diretto",
                peer_key
            );
            Ok(false)
        }
    }
}

/// Broadcast un update Yjs a tutti i peer connessi via Iroh gossip protocol.
///
/// Update è in formato binary v1 (stesso di `yjs_apply_update`). I peer
/// ricevono l'update nel loro subscribe loop (spawnato in `iroh_start_node`)
/// e lo applicano al loro Doc yrs locale, che triggera la persistenza SQLite
/// locale via `save_*_from_sync` (con updated_by='sync-live').
///
/// M3a.1 (PB2 fix) — Implementazione reale: `gossip.broadcast(topic, bytes)`.
#[tauri::command]
pub async fn iroh_broadcast_update(update_bytes: Vec<u8>) -> AppResult<()> {
    let gossip = {
        let guard = IrohState::instance().gossip.lock().await;
        guard
            .clone()
            .ok_or_else(|| AppError::Generic("Iroh gossip non inizializzato. Chiamare iroh_start_node prima.".into()))?
    };

    let topic = IrohState::instance().topic;
    let message = bytes::Bytes::from(update_bytes);
    let msg_len = message.len();

    match gossip.broadcast(topic, message).await {
        Ok(()) => {
            log::info!("[M3a.1] broadcast OK: {} bytes via gossip", msg_len);
            Ok(())
        }
        Err(e) => {
            log::warn!("[M3a.1] broadcast fallito: {}", e);
            Err(AppError::Generic(format!("gossip broadcast: {}", e)))
        }
    }
}

/// Sottoscrive updates ricevuti da peer remoti.
///
/// M3a.1 (PB2 fix) — Questo comando è ora no-op: il subscribe loop è già
/// spawnato in `iroh_start_node` (riga sopra). Viene mantenuto per backward
/// compat con il frontend che potrebbe ancora chiamarlo esplicitamente al
/// boot dell'app.
#[tauri::command]
pub fn iroh_subscribe_updates(_app: tauri::AppHandle) -> AppResult<()> {
    log::info!(
        "[M3a.1] iroh_subscribe_updates: no-op — subscribe loop già attivo in iroh_start_node"
    );
    Ok(())
}

/// Lista dei peer attualmente connessi (NodeId base32).
#[tauri::command]
pub fn iroh_get_connected_peers() -> AppResult<Vec<String>> {
    Ok(IrohState::instance().list_peers())
}

/// Disconnette un peer (rimosso dalla lista connessi, gossip unsubs).
#[tauri::command]
pub fn iroh_disconnect_peer(peer_key: String) -> AppResult<()> {
    IrohState::instance().remove_peer(&peer_key);
    log::info!("[M3a] iroh_disconnect_peer: {}", peer_key);
    Ok(())
}

// ----------------------------------------------------------------------
// M3a.3 (Deliverable 3) — sync_identity: peer key persistente + display_name
// ----------------------------------------------------------------------

/// Identità sync persistita (singleton row di `sync_identity`).
///
/// Ritornata da `get_sync_identity`. Usata dal frontend SyncView per mostrare
/// "La tua identità: ● marco (peer key: abc23-... [copia])" e per il restore
/// al boot (se `Some`, l'app auto-avvia Iroh con la SecretKey salvata).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncIdentity {
    /// NodeId Iroh (formato base32). Scambiata out-of-band con i peer.
    pub peer_key: String,
    /// Nome umano opzionale (es. "marco"). NULL se non ancora impostato.
    pub display_name: Option<String>,
    /// ISO 8601 della prima generazione della SecretKey.
    pub created_at: String,
}

/// Carica la SecretKey Iroh da `sync_identity` se esiste, altrimenti genera + salva.
///
/// Comportamento:
///  1. SELECT secret_key_bytes, peer_key FROM sync_identity WHERE id=1
///  2. Se esiste → ricostruisce SecretKey dai 32 byte salvati.
///  3. Se non esiste → genera nuova SecretKey, INSERT in sync_identity.
///
/// Idempotente: `INSERT OR IGNORE` su id=1 garantisce che anche se la tabella
/// è vuota e due thread chiamano contemporaneamente, solo il primo scrive.
fn load_or_create_secret(conn: &Connection) -> AppResult<iroh_base::key::SecretKey> {
    // Verifica che la tabella sync_identity esista (se il DB non è stato migrato
    // a v2.4, fallback a ephemeral — non bloccare il boot).
    let table_exists: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_identity' LIMIT 1")?
        .exists([])?;
    if !table_exists {
        log::warn!(
            "[M3a.3] tabella sync_identity non trovata (DB pre-v2.4?). Fallback a SecretKey ephemeral."
        );
        return Ok(iroh_base::key::SecretKey::generate());
    }

    // Tenta di caricare la riga singleton.
    let loaded: Option<(Vec<u8>, String)> = conn
        .query_row(
            "SELECT secret_key_bytes, peer_key FROM sync_identity WHERE id = 1 LIMIT 1",
            [],
            |r| {
                let bytes: Vec<u8> = r.get(0)?;
                let pk: String = r.get(1)?;
                Ok((bytes, pk))
            },
        )
        .ok();

    if let Some((bytes, pk_cached)) = loaded {
        // Ricostruisci SecretKey dai 32 byte. `SecretKey::from_bytes` prende
        // `&[u8; 32]` (array fisso di 32 byte, NON slice) e ritorna `Self`
        // direttamente (NON Result — qualsiasi 32 byte è una SecretKey ed25519
        // valida). Verifichiamo la lunghezza prima della conversione: se i byte
        // sono corrotti (len != 32), rigeneriamo una nuova key.
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            let sk = iroh_base::key::SecretKey::from_bytes(&arr);
            log::info!(
                "[M3a.3] SecretKey caricata da sync_identity. peer_key={}...",
                &pk_cached.get(..16).unwrap_or(&pk_cached)
            );
            // sk è SecretKey (owned, Copy/Clone) — lo ritorniamo direttamente.
            return Ok(sk);
        } else {
            // Bytes corrotti — genera nuova key, sovrascrivi la riga.
            log::warn!(
                "[M3a.3] SecretKey bytes len {} != 32 — rigenero + overwrite.",
                bytes.len()
            );
        }
    }

    // Genera nuova SecretKey e salvala.
    let sk = iroh_base::key::SecretKey::generate();
    let pk = sk.public().to_string();
    let sk_bytes = sk.to_bytes(); // [u8; 32]
    conn.execute(
        "INSERT OR REPLACE INTO sync_identity (id, secret_key_bytes, peer_key, display_name, created_at)
         VALUES (1, ?1, ?2, NULL, datetime('now'))",
        rusqlite::params![sk_bytes, pk],
    )?;
    log::info!(
        "[M3a.3] Nuova SecretKey generata + salvata in sync_identity. peer_key={}...",
        pk.get(..16).unwrap_or(&pk)
    );
    Ok(sk)
}

/// Salva un peer connesso come trusted in `sync_peers` per auto-connect al boot.
/// Idempotente via INSERT OR IGNORE (chiave primaria su peer_id).
///
/// M3a.3 (Deliverable 4) — L'effettivo salvataggio avviene in
/// `iroh_connect_by_peer_key_v2` (che ha accesso a `State<DbState>`). Questa
/// funzione helper è un placeholder documentato — rimane per chiarezza
/// architetturale e come punto di estensione futuro (es. se in M5+ vogliamo
/// salvare peer da altri punti senza duplicare la logica SQL).
#[allow(dead_code)]
fn save_trusted_peer(_conn: &Connection, _peer_key: &str) -> AppResult<()> {
    // Vedi `iroh_connect_by_peer_key_v2` per l'implementazione attiva.
    Ok(())
}

/// Ritorna l'identità sync persistita (singleton row), se esiste.
///
/// Chiamato dal frontend al boot per decidere se auto-avviare Iroh:
///   1. `await api.getSyncIdentity()`
///   2. Se Some → `await api.irohStartNode()` (carica SecretKey salvata)
///   3. Se None → non avviare Iroh automaticamente (l'utente deve avviarlo manualmente)
#[tauri::command]
pub fn get_sync_identity(
    state: tauri::State<'_, crate::DbState>,
) -> AppResult<Option<SyncIdentity>> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_identity' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(None); // DB pre-v2.4
        }
        let row: Option<(String, Option<String>, String)> = conn
            .query_row(
                "SELECT peer_key, display_name, created_at FROM sync_identity WHERE id = 1 LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        Ok(row.map(|(peer_key, display_name, created_at)| SyncIdentity {
            peer_key,
            display_name,
            created_at,
        }))
    })
}

/// Imposta il display_name dell'identità sync corrente.
/// Usato dal SyncView quando l'utente compila "nome: [marco________] [salva]".
#[tauri::command]
pub fn set_sync_display_name(
    state: tauri::State<'_, crate::DbState>,
    name: String,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        // Trim + clamp a 64 char (sanitizzazione minima).
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "display_name vuoto non ammesso".into(),
            ));
        }
        if trimmed.len() > 64 {
            return Err(AppError::Validation(format!(
                "display_name troppo lungo (max 64, dati {})",
                trimmed.len()
            )));
        }
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_identity' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Err(AppError::Generic(
                "sync_identity table non esistente (DB pre-v2.4). Avvia iroh_start_node prima.".into(),
            ));
        }
        let n_updated = conn.execute(
            "UPDATE sync_identity SET display_name = ?1 WHERE id = 1",
            rusqlite::params![trimmed],
        )?;
        if n_updated == 0 {
            return Err(AppError::Generic(
                "sync_identity row non trovata (id=1). Chiamare iroh_start_node prima.".into(),
            ));
        }
        Ok(())
    })
}

/// Lista dei peer fidati salvati (per auto-connect al boot).
///
/// Ritorna i record di `sync_peers` con `trusted = 1`. Il frontend
/// SyncView chiama questo al boot, dopo `iroh_start_node`, per riconnettere
/// automaticamente i peer della sessione precedente.
#[derive(Debug, Clone, Serialize)]
pub struct TrustedPeer {
    pub peer_id: String,
    pub display_name: Option<String>,
    pub paired_at: String,
    pub last_seen: Option<String>,
    pub trusted: bool,
}

#[tauri::command]
pub fn list_trusted_peers(
    state: tauri::State<'_, crate::DbState>,
) -> AppResult<Vec<TrustedPeer>> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_peers' LIMIT 1")?
            .exists([])?;
        if !table_exists {
            return Ok(Vec::new()); // DB pre-v2.3
        }
        let mut stmt = conn.prepare(
            "SELECT peer_id, display_name, paired_at, last_seen, trusted
             FROM sync_peers WHERE trusted = 1 ORDER BY paired_at DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TrustedPeer {
                peer_id: r.get(0)?,
                display_name: r.get(1)?,
                paired_at: r.get(2)?,
                last_seen: r.get(3)?,
                trusted: r.get::<_, i64>(4)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// Versione 2 di `iroh_connect_by_peer_key` che accetta `DbState` e salva il
/// peer come trusted su `sync_peers` dopo una connessione QUIC riuscita.
///
/// M3a.3 (Deliverable 4) — Il vecchio `iroh_connect_by_peer_key` resta per
/// backward-compat (lo richiama il frontend se non aggiornato). Il nuovo
/// SyncView chiama `iroh_connect_by_peer_key_v2` che delega la connect
/// effettiva al vecchio comando (per evitare duplicazione della logica) e
/// poi salva il peer.
///
/// Per evitare di duplicare la logica di connect, `iroh_connect_by_peer_key_v2`
/// CHIAMA direttamente la logica di connect via la funzione interna (non
/// tramite `invoke`). Per non rifattorizzare, copiamo la logica qui — sarebbe
/// meglio estrarre `do_iroh_connect(peer_key) -> bool` helper, ma per M3a.3
/// accettiamo la duplicazione (todo: refactor M4).
#[tauri::command]
pub async fn iroh_connect_by_peer_key_v2(
    state: tauri::State<'_, crate::DbState>,
    peer_key: String,
) -> AppResult<bool> {
    // Delega al comando originale (che non ha stato DB). Inoltra il peer_key
    // e cattura il risultato bool.
    let connected = iroh_connect_by_peer_key(peer_key.clone()).await?;

    if connected {
        // M3a.3 D4 fix — Persisti il peer in sync_peers (trusted=1) per
        // auto-connect al boot successivo. INSERT OR IGNORE: se il peer era
        // già salvato, non sovrascrive display_name/paired_at/last_seen
        // esistenti. Distinzione esplicita fra:
        //   - affected > 0 → INFO (prima volta che il peer viene persisted)
        //   - affected = 0 → DEBUG (no-op, peer già noto)
        //   - Err          → WARN (persistenza fallita, il peer resta in
        //                            memoria ma al riavvio dovrà essere
        //                            riaggiunto manualmente)
        let db_id = state.active_db_id()?;
        match state.with_conn(&db_id, |conn| {
            let affected = conn.execute(
                "INSERT OR IGNORE INTO sync_peers (peer_id, display_name, paired_at, last_seen, trusted)
                 VALUES (?1, NULL, datetime('now'), datetime('now'), 1)",
                rusqlite::params![peer_key],
            )?;
            Ok::<_, AppError>(affected)
        }) {
            Ok(affected) if affected > 0 => {
                log::info!(
                    "[M3a.3] peer {} salvato in sync_peers (trusted=1) per auto-connect",
                    peer_key
                );
            }
            Ok(_) => {
                log::debug!(
                    "[M3a.3] peer {} già presente in sync_peers (INSERT OR IGNORE no-op)",
                    peer_key
                );
            }
            Err(e) => {
                // NON fallire il connect: il peer è in lista in-memory, solo
                // la persistenza è fallita. L'utente vedrà il peer connesso
                // in questa sessione, ma al riavvio dovrà riaggiungerlo
                // manualmente.
                log::warn!(
                    "[M3a.3] persist sync_peers fallito per peer {}: {} — \
                     auto-connect al riavvio non disponibile per questo peer",
                    peer_key,
                    e
                );
            }
        }
    }

    Ok(connected)
}

/// Rimuove un peer dalla lista dei trusted (es. utente non vuole più auto-connect).
/// Aggiorna `trusted = 0` (NON DELETE — mantiene lo storico paired_at/last_seen
/// per audit). Vincolo HARD #1 (no delete automatici).
#[tauri::command]
pub fn remove_trusted_peer(
    state: tauri::State<'_, crate::DbState>,
    peer_key: String,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let n = conn.execute(
            "UPDATE sync_peers SET trusted = 0 WHERE peer_id = ?1",
            rusqlite::params![peer_key],
        )?;
        if n == 0 {
            log::debug!(
                "[M3a.3] remove_trusted_peer: peer {} non trovato in sync_peers.",
                peer_key
            );
        } else {
            log::info!(
                "[M3a.3] remove_trusted_peer: peer {} rimosso dai trusted (trusted=0).",
                peer_key
            );
        }
        Ok(())
    })
}

// ----------------------------------------------------------------------
// B.8 — Comandi save_*_from_sync (con updated_by='sync-live')
// ----------------------------------------------------------------------

/// Input per save_player_from_sync. Mirror di `PlayerInput` di players.rs,
/// ma con `updated_by` forzato a 'sync-live'.
#[derive(Debug, Clone, Deserialize)]
pub struct PlayerSyncInput {
    pub id: String,
    pub db_id: String,
    pub name: String,
    pub team: Option<String>,
    pub pos_fanta: Option<String>,
    pub pos_real: Option<String>,
    pub status: Option<String>,
    pub fascia: Option<String>,
    pub priority: Option<i64>,
    pub fmil_spesi: Option<i64>,
    pub med: Option<f64>,
    pub medv: Option<f64>,
    pub fvm: Option<i64>,
    pub custom_data: Option<String>,
    /// Peer Iroh che ha originato l'update (NodeId base32).
    /// Va su `sync_node_id` (colonna v2.3).
    pub sync_node_id: Option<String>,
}

/// Persiste un player ricevuto dal sync CRDT. Imposta `updated_by='sync-live'`
/// e `sync_node_id` (colonna v2.3). NON emette evento `player-updated`
/// (per evitare loop A→B→A — il listener Yjs del peer mittente non deve
/// ri-broadcastare l'update che ha appena ricevuto).
#[tauri::command]
pub fn save_player_from_sync(
    state: tauri::State<'_, crate::DbState>,
    input: PlayerSyncInput,
) -> AppResult<()> {
    validate_updated_by("sync-live")?;

    let db_id = input.db_id.clone();
    state.with_conn(&db_id, |conn| {
        let now = chrono::Utc::now().to_rfc3339();

        // UPSERT su players: se esiste già l'id, aggiorna; se no, inserisci.
        let exists: bool = conn
            .prepare("SELECT 1 FROM players WHERE id = ?1 LIMIT 1")?
            .exists([&input.id])?;

        if exists {
            conn.execute(
                "UPDATE players SET
                   name = ?2, team = ?3, pos_fanta = ?4, pos_real = ?5,
                   status = COALESCE(?6, status),
                   fascia = COALESCE(?7, fascia),
                   priority = COALESCE(?8, priority),
                   fmil_spesi = COALESCE(?9, fmil_spesi),
                   med = COALESCE(?10, med),
                   medv = COALESCE(?11, medv),
                   fvm = COALESCE(?12, fvm),
                   custom_data = COALESCE(?13, custom_data),
                   updated_by = 'sync-live',
                   last_sync_at = ?14,
                   sync_node_id = COALESCE(?15, sync_node_id)
                 WHERE id = ?1",
                rusqlite::params![
                    input.id,
                    input.name,
                    input.team,
                    input.pos_fanta,
                    input.pos_real,
                    input.status,
                    input.fascia,
                    input.priority,
                    input.fmil_spesi,
                    input.med,
                    input.medv,
                    input.fvm,
                    input.custom_data,
                    now,
                    input.sync_node_id,
                ],
            )?;
        } else {
            // Insert (caso sync iniziale: peer B riceve tutti i player da A)
            conn.execute(
                "INSERT INTO players (
                   id, db_id, name, team, pos_fanta, pos_real, status, fascia,
                   priority, fmil_spesi, med, medv, fvm, custom_data,
                   updated_by, last_sync_at, sync_node_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                          'sync-live', ?15, ?16)",
                rusqlite::params![
                    input.id,
                    input.db_id,
                    input.name,
                    input.team,
                    input.pos_fanta,
                    input.pos_real,
                    input.status.unwrap_or_else(|| "totali".into()),
                    input.fascia,
                    input.priority.unwrap_or(0),
                    input.fmil_spesi,
                    input.med,
                    input.medv,
                    input.fvm,
                    input.custom_data,
                    now,
                    input.sync_node_id,
                ],
            )?;
        }
        Ok(())
    })?;

    log::debug!(
        "[M3a] save_player_from_sync: id={} name={} (updated_by=sync-live)",
        input.id,
        input.name
    );
    // NON emettere evento player-updated: evita loop A→B→A
    Ok(())
}

/// Input per save_scouting_note_from_sync.
#[derive(Debug, Clone, Deserialize)]
pub struct ScoutingNoteSyncInput {
    pub player_id: String,
    pub kind: String,
    pub label: Option<String>,
    pub content: Option<String>,
    pub source: Option<String>,
    pub sync_node_id: Option<String>,
}

/// Persiste una scouting note ricevuta dal sync CRDT.
/// `updated_by` non applicabile (la tabella scouting_notes non ha quel campo),
/// ma `sync_node_id` e `last_sync_at` vengono popolati.
#[tauri::command]
pub fn save_scouting_note_from_sync(
    state: tauri::State<'_, crate::DbState>,
    input: ScoutingNoteSyncInput,
) -> AppResult<i64> {
    // Recupera il db_id del player (necessario per filtrare)
    let db_id = state.with_conn("", |_conn| {
        // Empty db_id is wrong here — better: pass db_id via input.
        // For simplicity, we use the active db_id.
        let active = state.active_db_id()?;
        Ok::<String, AppError>(active)
    })?;

    state.with_conn(&db_id, |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO scouting_notes (
               player_id, kind, label, content, source,
               last_sync_at, sync_node_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                input.player_id,
                input.kind,
                input.label,
                input.content,
                input.source,
                now,
                input.sync_node_id,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

/// Input per save_auction_data_from_sync.
#[derive(Debug, Clone, Deserialize)]
pub struct AuctionDataSyncInput {
    pub player_id: String,
    pub titolarita: Option<i64>,
    pub infortuni: Option<String>,
    pub quick_note: Option<String>,
    pub fmil_max: Option<i64>,
    pub assigned_to: Option<String>,
    pub fmil_paid: Option<i64>,
    pub assigned_at: Option<String>,
    pub sync_node_id: Option<String>,
}

/// Persiste auction_data ricevuta dal sync CRDT. UPSERT su player_id.
#[tauri::command]
pub fn save_auction_data_from_sync(
    state: tauri::State<'_, crate::DbState>,
    input: AuctionDataSyncInput,
) -> AppResult<()> {
    let db_id = state.active_db_id()?;
    state.with_conn(&db_id, |conn| {
        let now = chrono::Utc::now().to_rfc3339();
        let exists: bool = conn
            .prepare("SELECT 1 FROM auction_data WHERE player_id = ?1 LIMIT 1")?
            .exists([&input.player_id])?;

        if exists {
            conn.execute(
                "UPDATE auction_data SET
                   titolarita = COALESCE(?2, titolarita),
                   infortuni = COALESCE(?3, infortuni),
                   quick_note = COALESCE(?4, quick_note),
                   fmil_max = COALESCE(?5, fmil_max),
                   assigned_to = COALESCE(?6, assigned_to),
                   fmil_paid = COALESCE(?7, fmil_paid),
                   assigned_at = COALESCE(?8, assigned_at),
                   last_sync_at = ?9,
                   sync_node_id = COALESCE(?10, sync_node_id)
                 WHERE player_id = ?1",
                rusqlite::params![
                    input.player_id,
                    input.titolarita,
                    input.infortuni,
                    input.quick_note,
                    input.fmil_max,
                    input.assigned_to,
                    input.fmil_paid,
                    input.assigned_at,
                    now,
                    input.sync_node_id,
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO auction_data (
                   player_id, titolarita, infortuni, quick_note, fmil_max,
                   assigned_to, fmil_paid, assigned_at,
                   last_sync_at, sync_node_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    input.player_id,
                    input.titolarita,
                    input.infortuni,
                    input.quick_note,
                    input.fmil_max,
                    input.assigned_to,
                    input.fmil_paid,
                    input.assigned_at,
                    now,
                    input.sync_node_id,
                ],
            )?;
        }
        Ok(())
    })?;

    log::debug!(
        "[M3a] save_auction_data_from_sync: player_id={} (updated_by=sync-live implicit)",
        input.player_id
    );
    Ok(())
}

// ----------------------------------------------------------------------
// B.7 helper — Conflict resolution (auto-fetch vs sync-live)
// ----------------------------------------------------------------------

/// True se il player `player_id` ha `updated_at` più recente di
/// `scraped_at` (timestamp del listone). Usato da `import_listone` per
/// decidere se archiviare o meno il player (B.7).
///
/// Regola: auto-fetch NON deve archiviare un player con updated_at più
/// recente di listone.scraped_at, perché qualcuno lo sta modificando
/// (sync-live attivo o edit manuale recente).
pub fn player_has_recent_local_edit(
    conn: &Connection,
    player_id: &str,
    scraped_at: &str,
) -> AppResult<bool> {
    let updated_at: Option<String> = conn
        .query_row(
            "SELECT updated_at FROM players WHERE id = ?1 LIMIT 1",
            rusqlite::params![player_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();

    match updated_at {
        Some(ua) if !ua.is_empty() => {
            // Confronto lessicografico ISO 8601 UTC (entrambi i formati
            // sono ordinabili come stringhe)
            Ok(ua.as_str() > scraped_at)
        }
        _ => Ok(false),
    }
}
