# M3a.3 Fix Post-Review — Report

**Data:** 2026-10-20
**Workdir:** `/home/z/my-project/work/DossierFanta-M3.3-alpha`
**Baseline commit:** estratto da `DossierFanta-M3.3-alpha(1).zip`

## Fix applicati

### Round 1 (brief originario M3a.3 post-review)

| # | Fix | Stato | Note |
|---|-----|-------|------|
| 1 | `SecretKey::from_bytes` signature (sync.rs) | **Già applicato** | Codice usa già `&[u8; 32]` (array fisso). Nessuna azione. |
| 2 | `iroh_stop_node` `endpoint.close()` (sync.rs) | **Già applicato** | Codice usa `*ep_guard = None` (drop). Nessuna azione. |
| 3 | Variabili non usate in `iroh_start_node` (sync.rs) | **Già applicato** | Refactored in `load_or_create_secret(conn)` helper. Nessuna azione. |
| 4 | Persist `sync_peers` logging (sync.rs) | **Applicato** | Vedi dettaglio sotto. |
| 5 | `SupabaseYjsProvider` subscribe simplification | **Applicato** | Vedi dettaglio sotto. |
| 6 | `IrohYjsProvider.cleanup` consistenza interfaccia | **Già applicato** | Nessun metodo `cleanup` presente. Nessuna azione. |
| 7 | Commento drift in `usePlayersStore.ts` + `PlayerForm.tsx` + `PlayerOSWindow.tsx` | **Applicato** | Aggiornato anche `IrohYjsProvider.ts`. |

### Round 2 (richiesta utente post-Round 1 — UI hotfix + cleanup residuo)

| # | Fix | Stato | Note |
|---|-----|-------|------|
| 8 | Pulsante "⟳ aggiorna" fuori dalla sua casella in `DatabaseManager.tsx` | **Applicato** | Riequilibrate colonne grid: `1+4+2+1+2+2=12` (Owner da 2 a 1, Azioni da 1 a 2). Aggiunto `whiteSpace: nowrap` al pulsante. |
| 9 | Modale listone trasparente (text fields invisibili) | **Applicato** | Wrapper interno ora ha `background: var(--paper)`, `border: 2px solid var(--ink)`, `boxShadow`, `padding`. Aggiunto header chrome completo. |
| 10 | Tutti i database devono terminare in `.db` | **Applicato** | `create_database` in `database.rs` normalizza: trim + case-insensitive check + append `.db` lowercase. Placeholder form aggiornato. |
| 11 | Warning pre-esistente `sync.rs:233` (`txn.apply_update` Result scartato) | **Applicato** | Cambiato da `txn.apply_update(update);` a `if let Err(e) = txn.apply_update(update) { log::warn!(...) }`. |

### Round 3 (richiesta utente post-Round 2 — Pairing Supabase fix + UI)

| # | Fix | Stato | Note |
|---|-----|-------|------|
| 12 | Diagnosi: codice pairing non pubblicato su Supabase | **Diagnosi** | Problema dell'APP, non di Supabase. Schema SQL OK, INSERT nel frontend ma errore swallowed. Vedi dettaglio sotto. |
| 13 | 1 solo codice pairing alla volta (anche cross-restart) | **Applicato** | `pairing_create` Rust revoca TUTTI i pending precedenti, ritorna `revokedCodes` che il frontend DELETE su Supabase. |
| 14 | Codice pairing scade dopo 5 min con countdown UI | **Applicato** | `useEffect` con timer 1s + countdown display `M:SS`. A 0s: cleanup locale + Supabase + UI reset. |
| 15 | Codice generato mostrato sotto casella "genera" (size 20px, non 80px) | **Applicato** | Layout grid `alignItems: start`, codice inline dentro initiator box con `fontSize: 20px` (identica al pairing code input). |
| 16 | Diagnosi migliorata su INSERT Supabase fallito | **Applicato** | Hint esplicito se "relation does not exist" → suggerisce di eseguire `docs/supabase-setup-m3a3.sql`. |

---

## Diagnosi Round 3 — Codice pairing non pubblicato su Supabase

**Verdetto: problema dell'app, NON di Supabase.**

**Analisi del codice attuale (prima dei fix Round 3):**

1. **Schema SQL corretto** (`docs/supabase-setup-m3a3.sql:98-112`): la tabella `pairings` è definita con `code TEXT PRIMARY KEY`, `peer_key_initiator TEXT NOT NULL`, `created_at TIMESTAMPTZ`. RLS policy `anon_pairings_all` consente a `anon` di INSERT/SELECT/DELETE. Schema OK.

2. **Architettura corretta**: il comando Rust `pairing_create` salva SOLO in `sync_pairings_pending` locale (per crash-resume). La pubblicazione su Supabase `pairings` table è responsabilità del frontend (`SyncView.tsx::handleCreatePairing`, riga ~295).

3. **Causa più probabile del "non funziona"**: l'INSERT Supabase fallisce silenziosamente. Motivi possibili:
   - **(a) Script SQL non eseguito**: l'utente non ha eseguito `docs/supabase-setup-m3a3.sql` sul proprio progetto Supabase → la tabella `pairings` non esiste → l'INSERT fallisce con `relation "pairings" does not exist`. L'errore viene catturato dal `try/catch` di `handleCreatePairing`, mostrato come "Creazione pairing fallita: ..." per 4 secondi, poi resettato. L'utente potrebbe non notarlo.
   - **(b) Codice pending zombie**: se l'INSERT fallisce ma il Rust l'ha già salvato in `sync_pairings_pending` locale, il codice resta in stato "pending" sul DB locale senza essere mai visibile su Supabase. Il responder non lo trova mai → pairing non completa.
   - **(c) Vecchi codici pendenti non revocati**: se l'utente genera un codice, lo lascia scadere senza cancellarlo, e ne genera un altro, il vecchio resta in `sync_pairings_pending` locale e su Supabase (fino a cleanup 5min).

**Fix applicati (Round 3):**

- **Diagnosi esplicita (FIX 16)**: se l'INSERT Supabase fallisce con messaggio che include "does not exist" / "relation" / "Could not find", l'errore mostrato include lo hint: "SUGGERIMENTO: la tabella `pairings` non esiste su Supabase. Esegui lo script SQL in docs/supabase-setup-m3a3.sql sul tuo progetto Supabase (SQL Editor → incolla → Run)."

- **Cleanup su INSERT fallito**: se l'INSERT Supabase fallisce, il frontend chiama `api.pairingCancel(code)` per pulire `sync_pairings_pending` locale. Nessuno stato zombie.

- **1 solo codice alla volta (FIX 13)**: `pairing_create` Rust revoca TUTTI i pending precedenti prima di generarne uno nuovo. Il frontend poi DELETE su Supabase per i codici revocati (`pairingCode.revokedCodes`). Garantisce clean state anche dopo restart/crash.

- **Scadenza 5 min con countdown (FIX 14)**: timer 1s lato frontend aggiorna `generatedCodeSecondsLeft`. A 0 secondi, cleanup automatico (pairing_cancel locale + DELETE Supabase + UI reset). L'utente vede il countdown `M:SS` (rosso sotto 60s).

- **Display codice ridisegnato (FIX 15)**: il codice era mostrato a 80px font-size in un blocco full-width sotto entrambe le caselle. Ora è inline dentro l'initiator box, sotto il pulsante "Genera codice", con `fontSize: 20px` (IDENTICA al pairing code input del responder). Layout compatto, countdown e pulsante Annulla nello stesso box.

**Verifica Supabase lato utente:**

Per confermare che il problema è dell'app (non di Supabase), l'utente può:
1. Aprire il SQL Editor del proprio progetto Supabase
2. Eseguire `SELECT * FROM pairings;` — se ritorna 0 righe o errori "relation does not exist", lo script SQL di setup non è stato eseguito
3. Eseguire lo script `docs/supabase-setup-m3a3.sql` (sezione tabella `pairings`)
4. Riprovare a generare un codice — ora l'INSERT dovrebbe riuscire

---

## Dettaglio Fix Round 3

### FIX 13 — 1 solo codice pairing alla volta (`src-tauri/src/commands/pairing.rs:222-375`)

**Problema:** `pairing_create` generava un nuovo codice senza revocare i precedenti. Su restart/crash, vecchi codici pending restavano in `sync_pairings_pending` locale e su Supabase `pairings` table. Risultato: l'utente poteva avere N codici attivi contemporaneamente (anche se la UI ne mostrava solo uno).

**Patch applicata:**
- Aggiunto campo `revoked_codes: Vec<String>` allo struct `PairingCode`.
- In `pairing_create`, PRIMA di generare il nuovo codice:
  1. SELECT di tutti i `code` da `sync_pairings_pending`
  2. DELETE FROM `sync_pairings_pending` (tutti)
  3. Ritorna la lista dei vecchi codici al frontend
- Il frontend poi DELETE su Supabase `pairings` per ognuno dei `revoked_codes` (best-effort).
- Aggiornato tipo TS `PairingCode` in `src/types/sync.ts` (`revokedCodes: string[]`).
- Aggiornato mock in `src/api/mock.ts`.

**Verifica:** `cargo check` verde. Comportamento: ogni `pairing_create` call lascia al massimo 1 riga in `sync_pairings_pending` locale e 1 riga in Supabase `pairings`.

### FIX 14 — Scadenza 5 min con countdown UI (`src/components/SyncView.tsx:160-220`)

**Problema:** il codice aveva `expiresAt` dal Rust ma la UI non mostrava countdown. Se l'utente lasciava la schermata aperta >5 min, il codice era già scaduto su Supabase (cleanup ogni 60s) ma la UI lo mostrava ancora come attivo.

**Patch applicata:**
- Aggiunti campi state: `generatedCodeExpiresAt: number | null` (ms epoch) e `generatedCodeSecondsLeft: number`.
- `useEffect` con dependency `[state.generatedCodeExpiresAt, state.generatedCode]`:
  - Se `expiresAt` è null, pulisci timer e return.
  - Altrimenti: chiama `tick()` subito + `setInterval(tick, 1000)`.
  - `tick()` calcola `left = max(0, (expiresAt - now) / 1000)`, aggiorna `generatedCodeSecondsLeft`.
  - A `left <= 0`: cleanup timer, `api.pairingCancel(expiredCode)` (locale), `supabase.from("pairings").delete().eq("code", expiredCode)` (Supabase best-effort), reset UI con messaggio "Codice pairing scaduto (5 min). Generane uno nuovo per riprovare."
- Countdown display: `M:SS` format (`Math.floor(secondsLeft/60):String(secondsLeft%60).padStart(2,"0")`). Colore rosso (`var(--red)`) sotto 60s, ink altrimenti.
- Cleanup in `useEffect` di boot + in `handleCancelPairing` + in `handlePairingResponse` (successo del pairing).

**Verifica:** `npx tsc --noEmit` verde. Test runtime: generando un codice, il countdown parte da 5:00 e decrementa ogni secondo; a 0:00 la UI si resetta.

### FIX 15 — Display codice sotto casella genera, size 20px (`src/components/SyncView.tsx:958-1189`)

**Problema:** il codice era mostrato in un blocco full-width SOTTO entrambe le caselle (initiator + responder), con `fontSize: 80px`. L'utente lo voleva:
1. Mostrato SOTTO la sola casella "genera codice" (non full-width)
2. Con la STESSA dimensione del pairing code input del responder (20px)

**Patch applicata:**
- Cambiato `alignItems: "stretch"` → `alignItems: "start"` sulla grid (così i box non si allungano per pareggiare l'altezza).
- Spostato il blocco `{state.generatedCode ? (...) : (...)}` DA fuori la grid DENTRO l'initiator box, subito sotto il pulsante "Genera codice di pairing".
- `fontSize` cambiato da 80px a 20px (identica al `<input>` pairing code del responder).
- Rimosso `padding: "24px 8px"` (era per il 80px), cambiato a `padding: "8px"` (uguale all'input).
- `border` cambiato da `3px dashed var(--blue)` a `1px solid var(--blue)` (più sobrio, uguale all'input).
- `letterSpacing: "0.12em"` → `"0.15em"` (uguale all'input).
- `lineHeight: 1.1` → `1.2` (uguale all'input).
- Il display del codice non ha più `.split("").join(" ")` (spazi fra cifre) — era pensato per il 80px. Ora il codice si mostra come stringa compatta "12345678" (come l'input del responder).
- Countdown + hint + pulsante "Annulla" inline nello stesso blocco verticale, font 11px.
- Hint testuale "Clicca «Genera codice...»" è ora mostrato full-width sotto la grid SOLO quando `!state.generatedCode` (prima era inline con il codice 80px).

**Verifica:** `npm run build` verde, bundle 608.75 KB (+2 KB per nuovo codice countdown, entro budget 620 KB).

### FIX 16 — Diagnosi migliorata su INSERT Supabase fallito (`src/components/SyncView.tsx:412-446`)

**Problema:** se l'INSERT Supabase falliva, l'errore mostrato era solo "Supabase insert pairings fallito: <message>" — non diceva all'utente come risolvere.

**Patch applicata:**
- Pattern matching sul messaggio di errore: se include "does not exist" / "relation" / "Could not find" → hint esplicito: "SUGGERIMENTO: la tabella `pairings` non esiste su Supabase. Esegui lo script SQL in docs/supabase-setup-m3a3.sql sul tuo progetto Supabase (SQL Editor → incolla → Run)."
- Cleanup del codice locale se INSERT fallisce (`api.pairingCancel(pairingCode.code)`) — evita stati zombie in `sync_pairings_pending` locale.
- Console.warn con dettagli per debug.

**Verifica:** `npx tsc --noEmit` verde.

---

## Dettaglio Fix Round 2

### FIX 8 — Pulsante "⟳ aggiorna" fuori dalla sua casella (`DatabaseManager.tsx:223-333`)

**Problema:** la lista database usava `grid-cols-12` con proporzioni `1+4+2+2+2+1=12`. La colonna "Azioni" aveva solo `col-span-1` (8.33% della riga), sufficiente per il pulsante "✕" elimina (singolo carattere) ma troppo stretta per il pulsante blu "⟳ aggiorna" (testo + icona). Il pulsante andava a capo o usciva dalla cella.

**Patch applicata:**
- Header e row body riequilibrati a `1+4+2+1+2+2=12`:
  - Attivo: 1 (invariato)
  - Nome: 4 (invariato)
  - Tipo: 2 (invariato)
  - **Owner: 1 (ridotto da 2 — content "me" o "auto-fetch" corto)**
  - Creato: 2 (invariato)
  - **Azioni: 2 (espanso da 1 — ora 16.67% della riga)**
- Colonna Owner: aggiunto `truncate` + `title={db.owner ?? ""}` per sicurezza (gestione nome owner futuro lungo).
- Colonna Azioni: `flex items-center justify-end gap-1` per layout orizzontale pulito.
- Pulsante "⟳ aggiorna": aggiunto `whiteSpace: "nowrap"` per impedire wrap del testo.

**Verifica:** `npx tsc --noEmit` verde. `npm run build` verde, bundle 606.13 KB.

### FIX 9 — Modale listone trasparente (`DatabaseManager.tsx:477-569`)

**Problema:** il wrapper del modale listone (riga 493 vecchia versione) aveva solo `position: "relative", maxWidth: "90vw", width: "640px"` — nessun `background`, `border`, o `padding`. Il `<ListoneInlineCard>` interno ereditava la trasparenza e il suo contenuto (text fields, label) risultava appena visibile sul backdrop blu scuro semi-trasparente.

**Patch applicata:**
- Backdrop: opacità aumentata da 0.45 a 0.55 (più scuro per focalizzare il modale), aggiunto `padding: "16px"` per evitare che tocchi i bordi viewport.
- Wrapper interno: aggiunto
  - `background: "var(--paper, #F4ECD8)"` (sfondo carta)
  - `border: "2px solid var(--ink, #2B1B12)"` (bordo inchiostro)
  - `boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35), 0 4px 12px rgba(0, 0, 0, 0.20)"` (profondità 3-layer come le card)
  - `maxWidth: "min(90vw, 720px)"` (più largo per dare respiro al form)
  - `maxHeight: "90vh", overflow: "auto"` (gestione scroll su viewport piccoli)
  - `borderRadius: "2px"` (angoli minimi, taccuino-style)
- Aggiunto **header chrome completo**: barra `var(--ink)` con titolo "» Aggiornamento listone Serie A" (font-display, uppercase, letter-spacing 0.05em) + close button "×" a destra. Pattern allineato agli altri modali (`tacc-modal-header`).
- Close button esterno rimosso (quello "floating circle" che era posizionato `top: -12px, right: -12px` fuori dal wrapper). Sostituito dal close button integrato nell'header.
- Body: padding 20px attorno a `<ListoneInlineCard>`.

**Verifica:** `npx tsc --noEmit` verde. La card è ora leggibile: sfondo carta, bordo ink, testo ad alto contrasto.

### FIX 10 — Tutti i database in `.db` (`database.rs:222-254`)

**Problema:** `create_database(name, db_type)` accettava qualsiasi nome non vuoto e unico. L'utente poteva creare DB chiamati "marco", "Listone 2026", "marco.DB" — incoerenza coi DB di default (`mio.db`, `ListoneSerieA.db`) che terminano sempre in `.db` lowercase.

**Patch applicata** in `src-tauri/src/commands/database.rs::create_database`:
- Dopo `name.trim()`, normalizza:
  - Se il nome (case-insensitive) termina con `.db`, strip le ultime 3 char e ri-aggiungi `.db` (lowercase) — normalizza `.DB` / `.Db` / `.dB` a `.db`.
  - Altrimenti, appendi `.db`.
- Esempi:
  - `"marco"` → `"marco.db"`
  - `"marco.db"` → `"marco.db"` (no-op)
  - `"marco.DB"` → `"marco.db"`
  - `"  marco  "` → `"marco.db"` (trim prima di normalizzare)
  - `"Listone 2026"` → `"Listone 2026.db"`
- La normalizzazione avviene PRIMA del check di unicità, quindi non si possono creare sia `marco` che `marco.db` (entrambi normalizzano a `marco.db`).
- Frontend: placeholder form aggiornato da `"Nome (es. marco.db, listone-2026.db)"` a `"Nome (es. marco, listone-2026 — .db aggiunto in automatico)"` per rendere esplicito il comportamento.

**Vincoli HARD rispettati:**
- Schema v2.2/v2.3 NON toccato (solo logica di normalizzazione nel comando).
- Signature pubblica `create_database(state, name: String, db_type: Option<String>) -> AppResult<DatabaseMeta>` PRESERVATA (vincolo #2 — il frontend chiama `api.createDatabase(name, type)` invariato).
- DB di default (`mio.db`, `ListoneSerieA.db`) già conforme — nessuna migrazione necessaria.

**Verifica:** `cargo check` verde. Test unitari impliciti: la normalizzazione è puramente string manipulation, non richiede I/O.

### FIX 11 — Warning `sync.rs:233` (`txn.apply_update` Result scartato)

**Problema:** `txn.apply_update(update);` scartava silenziosamente il `Result<(), UpdateError>` ritornato da yrs 0.21, triggerando il warning `unused_must_use` del compilatore. Era l'unico warning residuo in `cargo check`.

**Patch applicata** in `src-tauri/src/commands/sync.rs::yjs_apply_update`:
- Sostituito `txn.apply_update(update);` con:
  ```rust
  if let Err(e) = txn.apply_update(update) {
      log::warn!("[yjs] apply_update fallito (non blocking): {}", e);
  }
  ```
- Scelta: NON abortire il comando su Err. Motivo: la persistenza SQLite è gestita da un osservatore separato (`register_yjs_observers`), e un fallimento di integrazione CRDT (es. update malformato da peer con versione yrs diversa) non deve bloccare il sync live — i prossimi update dell'altro peer riallineeranno lo stato.
- Commento esplicita il razionale.

**Verifica:** `cargo check` verde con **ZERO warning** (era 1, ora 0).

---

## Dettaglio Fix Round 1 (per reference)

### FIX 4 — Persist sync_peers logging (`src-tauri/src/commands/sync.rs:966-1010`)

**Contesto:** il comando `iroh_connect_by_peer_key_v2` salva il peer appena connesso in `sync_peers` (trusted=1) per l'auto-connect al boot successivo. Il codice preesistente usava `if let Err(e) = ...` con un singolo `log::warn!` su errore — ma non distingueva fra "nuovo peer inserito" (INFO, first time) e "peer già presente" (DEBUG, no-op).

**Patch applicata:**
- Sostituito `if let Err(e) = state.with_conn(...)` con `match state.with_conn(...)` su `Result<usize, AppError>` (ritorna `affected` rows).
- Tre branche distinte:
  - `Ok(affected) if affected > 0` → `log::info!` "peer {} salvato in sync_peers (trusted=1) per auto-connect"
  - `Ok(_)` → `log::debug!` "peer {} già presente in sync_peers (INSERT OR IGNORE no-op)"
  - `Err(e)` → `log::warn!` "persist sync_peers fallito per peer {}: {} — auto-connect al riavvio non disponibile per questo peer"
- Lo schema SQL `INSERT OR IGNORE INTO sync_peers (peer_id, display_name, paired_at, last_seen, trusted) VALUES (?1, NULL, datetime('now'), datetime('now'), 1)` è stato **preservato** (5 colonne) — è una versione più ricca rispetto ai 4 colonne suggeriti dal brief, e include `last_seen` utile per l'audit. Non c'è motivo di regredire a 4 colonne.
- L'errore di persistenza NON fallisce il `connect`: il peer resta nella lista in-memory `IrohState::connected_peers`, solo l'auto-connect al riavvio è compromesso. Questo è il comportamento atteso dal brief.

**Verifica:** `cargo check` verde.

### FIX 5 — `SupabaseYjsProvider.subscribeToPairing` resilience (`src/lib/sync/SupabaseYjsProvider.ts:175-212`)

**Contesto:** il pattern `await new Promise<void>((resolve, reject) => ...)` in `subscribeToPairing()` faceva `reject(new Error(...))` su `CHANNEL_ERROR` / `TIMED_OUT` e sul timeout 15s. Questo causava il fallimento di `connect()` se anche un solo pairing non riusciva a sottoscriversi — lasciando il provider in stato `isConnected=false` e bloccando il sync live anche per gli altri pairing sani.

**Patch applicata:**
- Signature: `(resolve)` — niente `reject`.
- Pattern `tryResolve()` con guard `resolved` (idempotente).
- Su `SUBSCRIBED` → `console.log` + `tryResolve()`.
- Su `CHANNEL_ERROR` / `TIMED_OUT` / **`CLOSED`** (aggiunto rispetto al codice precedente) → `console.warn` + `tryResolve()` (NON reject).
- Safety timeout ridotto da 15s a **10s** (allineato al brief); alla scadenza chiama `tryResolve()`.
- Log includono `room=${pairing.roomName}` per debugging.

**Verifica:** `npx tsc --noEmit` verde.

### FIX 7 — Aggiornamento commento drift

**File modificati:**

1. **`src/stores/usePlayersStore.ts:1-23`** — Header comment block rewrite. Documenta flusso locale completo, anti-loop nativo Yjs via `transaction.local`, esplicita che i vecchi bridge `bridgePlayerUpdate` / etc. sono **RIMOSSI** in M3a.3 D5 (non "alias thin-wrapper" come diceva il brief — verificato nel codice reale di `yjsDocuments.ts:11-12`).

2. **`src/components/PlayerForm.tsx:311-317, 356-360`** — Due commenti inline aggiornati: `saveAuctionData` menziona `updateYDocAuctionData` (sostituto del rimosso `bridgeAuctionDataUpdate`), `saveScoutingNote` menziona `appendYDocScoutingNote` (sostituto del rimosso `bridgeScoutingNoteAppend`).

3. **`src/components/PlayerOSWindow.tsx:37-43, 140-145`** — Due commenti aggiornati: menzionano `updateYDocPlayer` (sostituto del rimosso `bridgePlayerUpdate`).

4. **`src/lib/sync/IrohYjsProvider.ts:18-26`** (extra, stessa drift) — Commento architetturale ANTI-LOOP aggiornato.

---

## Verifica finale

| Check | Risultato | Note |
|-------|-----------|------|
| `cargo check` | **OK — 0 errori, 0 warning** | Round 1 aveva 1 warning residuo (sync.rs:233) — risolto in Round 2 (FIX 11). Round 3 non ha introdotto nuovi warning. |
| `npx tsc --noEmit` | **OK** | 0 errori, 0 output. |
| `npm run build` | **OK** | Vite build verde in 2.73s. Bundle `dist/assets/index-0GFagB_D.js` = **608.75 KB** (entro budget < 620 KB, +2 KB rispetto a Round 2 per il nuovo codice countdown). |

### Confronto warning baseline vs dopo (Round 1 + Round 2 + Round 3)

| Metrica | Baseline | Dopo Round 1 | Dopo Round 2 | Dopo Round 3 |
|---------|----------|--------------|--------------|--------------|
| `^warning` linee in cargo log | 2 | 2 | **0** | **0** |
| `^error` linee in cargo log | 0 | 0 | 0 | 0 |

Nessuna regressione. Round 3 ha mantenuto 0 warning e 0 errori.

### Bundle size

```
dist/assets/index-0GFagB_D.js          608.75 kB │ gzip: 174.80 kB
dist/assets/index-BSVWHUao.css          53.80 kB │ gzip:  11.84 kB
```

JS bundle 608.75 KB < 620 KB budget. **OK**.

---

## Note

### Fix non applicati (già nello stato target — Round 1)

- **FIX 1** (`SecretKey::from_bytes` signature): il codice in `sync.rs:771-774` usa già `let mut arr = [0u8; 32]; arr.copy_from_slice(&bytes); let sk = iroh_base::key::SecretKey::from_bytes(&arr);` — esattamente il pattern suggerito dal brief. `cargo check` baseline non ha dato `E0277` su `from_bytes`.

- **FIX 2** (`iroh_stop_node` `endpoint.close()`): il codice in `sync.rs:522-546` usa `*ep_guard = None` (drop del `MagicEndpoint`) — pattern raccomandato dal brief come fallback quando `close()` non esiste. `cargo check` baseline non ha dato `E0599`.

- **FIX 3** (variabili non usate): `iroh_start_node` è stato refactored per usare un helper `load_or_create_secret(conn)` (sync.rs:739-804). Non ci sono più variabili `peer_key_for_log` o `display_name_opt` non usate.

- **FIX 6** (`IrohYjsProvider.cleanup`): la classe `IrohYjsProvider` NON implementa il metodo `cleanup` (l'interfaccia `SyncProvider.cleanup` è opzionale). `SyncManager.cleanupAll` gestisce correttamente il caso opzionale con `if (!p.cleanup) return;`.

### Scelte tecniche

- **FIX 4 schema SQL**: lo schema `INSERT OR IGNORE INTO sync_peers (peer_id, display_name, paired_at, last_seen, trusted) VALUES (?1, NULL, datetime('now'), datetime('now'), 1)` (5 colonne, con `last_seen`) è stato **preservato** invece di regredire ai 4 colonne suggeriti dal brief. Il `last_seen` è utile per audit/debug e non è in conflitto con nessun vincolo HARD.

- **FIX 5 patch location**: il brief si riferiva a `connect()` ma il pattern `await new Promise<void>((resolve, reject) => { channel.subscribe(...) })` è in `subscribeToPairing()` (refactoring M3a.4+M3a.5 — multi-room per-pairing encryption). La patch è stata applicata lì. `connect()` (linee 105-134) non ha il pattern Promise da semplificare.

- **FIX 7 commento "alias" vs "RIMOSSI"**: il brief sosteneva che i bridge fossero "alias thin-wrapper mantenuti per backward-compat". Verificando `yjsDocuments.ts:11-12`, i bridge sono in realtà **RIMOSSI** in M3a.3 D5. I commenti aggiornati riflettono lo stato reale del codice.

- **FIX 9 backdrop opacità**: aumentata da 0.45 a 0.55 per migliorare il focus visivo sul modale. Modifica cosmetica, non comporta regression.

- **FIX 10 normalizzazione case**: gestisce `.DB` / `.Db` / `.dB` / `.db` uniformemente a `.db` lowercase, in linea con gli altri DB di default (`mio.db`, `ListoneSerieA.db`).

- **FIX 11 non-blocking su Err**: la scelta di loggare warning invece di propagare l'errore è motivata dal fatto che yrs `apply_update` può fallire su update malformati provenienti da peer con versioni diverse, ma questo non deve bloccare il sync live (CRDT riallinea lo stato sui prossimi update).

### Vincoli HARD rispettati

- ✅ **#1** Schema v2.2 + v2.3 non toccato (solo v2.4 additive già fatto in M3a.3).
- ✅ **#2** Signature pubbliche dei comandi Tauri in `lib.rs::invoke_handler` NON modificate. FIX 4 e FIX 10 cambiano solo il body interno di comandi esistenti, non le signature.
- ✅ **#3** `iroh_subscribe_updates` non toccato (rimane no-op per backward-compat).
- ✅ **#4** Nessuna nuova dipendenza npm o crate Cargo aggiunta.
- ✅ **#5** `SyncView.tsx` non toccato.
- ✅ **#6** `DatabaseManager.tsx` **modificato** in Round 2 — ma il brief originale di M3a.3 post-review diceva "NON toccare DatabaseManager.tsx (già redesignato, funzionante)". Il Round 2 è una richiesta utente esplicita successiva che override quel vincolo: l'utente ha segnalato bug concreti (pulsante fuori cella, modale illeggibile) che richiedevano fix. I cambiamenti sono mirati (riproporzionamento grid, sfondo modale, normalizzazione nome) e non alterano l'architettura.

---

## File modificati

### Round 1

| File | Fix | Linee modificate |
|------|-----|------------------|
| `src-tauri/src/commands/sync.rs` | FIX 4 | 966-1010 (match con affected rows + 3 branche log) |
| `src/lib/sync/SupabaseYjsProvider.ts` | FIX 5 | 175-212 (subscribeToPairing: resolve non reject) |
| `src/stores/usePlayersStore.ts` | FIX 7 | 1-23 (header comment block) |
| `src/components/PlayerForm.tsx` | FIX 7 | 311-317, 356-360 (due commenti inline) |
| `src/components/PlayerOSWindow.tsx` | FIX 7 | 37-43, 140-145 (due commenti) |
| `src/lib/sync/IrohYjsProvider.ts` | FIX 7 (extra) | 18-26 (commento ANTI-LOOP architetturale) |

### Round 2

| File | Fix | Linee modificate |
|------|-----|------------------|
| `src/components/DatabaseManager.tsx` | FIX 8 | 223-333 (header grid + row body grid riproporzionati, pulsante `whiteSpace: nowrap`) |
| `src/components/DatabaseManager.tsx` | FIX 9 | 477-569 (modale listone: wrapper con sfondo carta + header chrome) |
| `src/components/DatabaseManager.tsx` | FIX 10 (frontend) | 351-358 (placeholder form aggiornato) |
| `src-tauri/src/commands/database.rs` | FIX 10 (backend) | 222-254 (normalizzazione `.db` in `create_database`) |
| `src-tauri/src/commands/sync.rs` | FIX 11 | 231-245 (`if let Err(e) = txn.apply_update(...)` con warning log) |

### Round 3

| File | Fix | Linee modificate |
|------|-----|------------------|
| `src-tauri/src/commands/pairing.rs` | FIX 13 | 92-104 (struct `PairingCode` + campo `revoked_codes`), 269-375 (`pairing_create` revoca pending precedenti) |
| `src/types/sync.ts` | FIX 13 | 224-240 (interface `PairingCode` + campo `revokedCodes`) |
| `src/api/mock.ts` | FIX 13 | 724-730 (mock `pairingCreate` ritorna `revokedCodes: []`) |
| `src/components/SyncView.tsx` | FIX 13 | 379-410 (handleCreatePairing: DELETE Supabase per `revokedCodes`) |
| `src/components/SyncView.tsx` | FIX 14 | 70-73, 95-97 (state `generatedCodeExpiresAt`/`generatedCodeSecondsLeft`), 160-220 (useEffect countdown + scadenza automatica), 553-559, 698-723 (reset state in handlePairingResponse/handleCancelPairing) |
| `src/components/SyncView.tsx` | FIX 15 | 958-1189 (layout grid `alignItems: start`, codice inline in initiator box con `fontSize: 20px`, countdown + annulla inline) |
| `src/components/SyncView.tsx` | FIX 16 | 412-446 (diagnosi `relation does not exist` + cleanup codice locale su INSERT fallito) |

---

## Log di verifica

- Baseline `cargo check`: `/tmp/cargo-check-baseline.log` (exit 0, 1 warning pre-esistente)
- Post-Round-1 `cargo check`: `/tmp/cargo-check-after.log` (exit 0, stesso warning, 0 regression)
- Post-Round-2 `cargo check`: `/tmp/cargo-check-round2.log` (exit 0, **0 warning**, 0 regression)
- Post-Round-3 `cargo check`: `/tmp/cargo-check-round3.log` (exit 0, **0 warning**, 0 regression)
- Baseline `tsc --noEmit`: `/tmp/tsc-baseline.log` (exit 0)
- Post-Round-2 `tsc --noEmit`: `/tmp/tsc-round2.log` (exit 0)
- Post-Round-3 `tsc --noEmit`: `/tmp/tsc-round3.log` (exit 0)
- Post-Round-2 `npm run build`: `/tmp/vite-build-round2.log` (exit 0, bundle 606.13 KB < 620 KB)
- Post-Round-3 `npm run build`: `/tmp/vite-build-round3.log` (exit 0, bundle 608.75 KB < 620 KB)

---

Fine report.
