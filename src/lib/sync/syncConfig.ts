// src/lib/sync/syncConfig.ts — M3a.3 Deliverable 2.
//
// Configurazione centralizzata di tutti i provider sync.
//
// *** PER CAMBIARE BACKEND SUPABASE (es. domani prendi un server tuo): ***
//   1. Sostituisci `supabase.url` e `supabase.anonKey` qui sotto con le
//      credenziali del tuo nuovo progetto Supabase (o del tuo server).
//   2. Esegui lo stesso SQL di setup sul nuovo database (vedi
//      `docs/supabase-setup-m3a3.sql`).
//   3. Tutto il resto (Y.Doc, listener, save_*_from_sync, SQLite, UI) resta
//      IDENTICO. L'astrazione SyncProvider garantisce swap senza toccare
//      altro codice.
//
// Vincolo HARD #19: SUPABASE_URL e SUPABASE_ANON_KEY sono hardcoded qui (come
// v1). NON sincronizzate, NON nel DB. È la chiave publishable/anon — può
// essere pubblica (RLS protegge i dati, vedi setup SQL).
//
// Vincolo HARD #20: la tabella yjs_updates NON contiene dati sensibili —
// solo bytes binari Yjs (CRDT update diffs). Il contenuto è decodificabile
// solo con il Y.Doc locale (che vive solo sul PC dell'utente).

/**
 * Credenziali Supabase per DossierFanta M3a.3.
 *
 * Queste sono la chiave `anon` / `publishable` di Supabase — è PUBLIC e
 * può essere inclusa nel bundle frontend senza rischi. La sicurezza dei
 * dati è garantita da Row Level Security (RLS) policies sulla tabella
 * `yjs_updates` (vedi `docs/supabase-setup-m3a3.sql`).
 *
 * Sostituisci con le credenziali del tuo progetto Supabase:
 * https://supabase.com/dashboard → tuo progetto → Settings → API
 */
export const SYNC_CONFIG = {
  supabase: {
    /**
     * URL del progetto Supabase (formato: https://<project-ref>.supabase.co).
     * Trovabile in: Supabase Dashboard → Settings → API → Project URL.
     */
    url: "https://liwfffxhokbvzyzhivzc.supabase.co",

    /**
     * Chiave `anon` / `publishable` — pubblica, inclusa nel bundle frontend.
     * Trovabile in: Supabase Dashboard → Settings → API → Project API keys
     * → "anon public".
     *
     * NOTA: NON usare la chiave `service_role` qui! Quella è privata e va
     * usata solo in un server sicuro, MAI nel bundle frontend.
     */
    anonKey: "sb_publishable_BHRYkkm7KWB4eKZb1P88SQ_vUy0Q4RU",

    /**
     * Nome logico della stanza di sync. Tutti i peer DossierFanta usano
     * lo stesso room_name per syncare sullo stesso flusso di update.
     *
     * In futuro, per DB condivisi multipli con sync indipendente, si
     * potrebbe parametrizzare per db_id (es. `dossierfanta-sync-${dbId}`).
     * Per M3a.3 un solo room_name globale basta.
     */
    roomName: "dossierfanta-sync",

    /**
     * Tabella PostgreSQL per l'offline storage degli update Yjs binari.
     */
    updatesTable: "yjs_updates",

    /**
     * Cleanup automatico: rimuovi update più vecchi di N giorni dalla
     * tabella `yjs_updates`. Chiamato da SyncManager.cleanupAll() su
     * azione manuale o schedulazione futura.
     */
    cleanupDays: 30,
  },

  iroh: {
    /**
     * Seed deterministico per il topic gossip Iroh. Tutti i peer DossierFanta
     * si uniscono allo stesso topic. Valore cambiato ad ogni breaking-change
     * del protocollo (es. v26 → bump qui per forzare il re-pairing).
     *
     * Specicato come stringa, hashato via FNV-1a lato Rust per generare
     * il `TopicId` deterministico (vedi `deterministic_topic()` in sync.rs).
     */
    topicSeed: "dossierfanta-v25-sync-live-topic",

    /**
     * Timeout in millisecondi per la connect Iroh via QUIC. Se il peer è
     * dietro NAT simmetrico senza relay pubblico, la connect va in timeout
     * e il provider ritorna Ok(false) (vedi iroh_connect_by_peer_key).
     */
    connectTimeoutMs: 10000,
  },
} as const;

/**
 * Tipo utilità per accedere in modo type-safe alle chiavi di config.
 */
export type SyncConfig = typeof SYNC_CONFIG;
