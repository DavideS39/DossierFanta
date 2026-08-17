Attenzione concettuale importante: tre tabelle, tre significati diversi di "squadra", da non confondere:

    players → giocatori del fantacalcio (persone).
    teams → squadre reali di Serie A (dossier tattici: baricentro, pressing, pericolosità offensiva, ecc. — non hanno budget/asta).
    league_teams → squadre della LEGA del fantacalcio (i partecipanti all'asta, inclusa "la propria"): budget, slot per reparto, giocatori assegnati. Contiene anche una riga speciale con id = '_settings' che non è una squadra ma le impostazioni globali dell'asta (budget di default, slot per reparto, flag "Modalità Asta" ON/OFF).
    roster_plans → piani rosa per l'asta (slot pianificati con fascia, archetipo, budget, note, candidati, ricerche). Aggiunta col kit v17.

Modello dati
players.data (per ogni giocatore)
Campi diretti (non in custom):

    nome, eta, squadra (nome squadra reale, testo libero con autocompletamento sulle squadre presenti in teams), posFanta (P/D/C/A)
    posReale (posizione reale nella squadra, testo libero con AUTOCOMPLETE basato sui ruoli reali già usati da altri giocatori dello stesso ruolo fanta)
    spesaAnnoScorso, fmAnnoScorso, golAnnoScorso, assistAnnoScorso
    xgAnnoScorso, tiriPartita, tocchiArea, noteAnnoScorso
    percVotoSufficiente, percPartiteBonus, percVotoInsufficiente (affidabilità del voto)
    ammonizioniAnnoScorso, espulsioniAnnoScorso, rigorista, autogolAnnoScorso (bonus/malus dettaglio)
    xaAnnoScorso, golPerTiri, passaggiChiave (rendimento avanzato)
    mediaVotoUltime5, trendNote, rendimentoBigMatch (trend e forma)
    fragilita (1-10), noteFisico, infortuniNumero, infortuniGiorniTotali, cambioSquadraGennaio, cambioAllenatoreNote, ruoliDiversiNote (fisico, infortuni e contesto)
    titolaritaVoto (1-10), titolaritaNote
    valutazioneSquadraNote (note sul contesto squadra per quel giocatore)
    golPrevisti, prezzoPrevisto (testo/numero libero), noteVarie, priorita (0-5, select con stelle da ★ a ★★★★★)
    fascia (una delle 5 fasce unificate, vedi sotto)
    trendPrevisto (select: forte_crescita / crescita / stabile / calo / forte_calo) — giudizio umano sulla direzione del giocatore (kit v16)
    variazionePrevista (numero, es. +0.3 / -0.2) — aggiustamento manuale della FM prevista, ha priorità sul trendPrevisto (kit v16)
    proiezione (oggetto {nota, twist, by, at}) — nota libera + aggiustamento salvati dal modale proiezione, sincronizzati su Supabase (kit v15/v16)
    tag: array di stringhe, gestito con UI dedicata (chip + autocomplete), NON è più un campo di testo semplice
    custom: oggetto libero per campi personalizzati aggiunti dall'utente dall'editor, PIÙ campi usati internamente dagli script di arricchimento (apiFootballId, enrichStatus, enrichNote, fuoriSerieA, squadraFonte) — alcuni di questi (es. fuoriSerieA) sono RIMOVIBILI dall'utente tramite l'editor campi personalizzati
    asta: null oppure {team, prezzo, assegnatoDa, assegnatoAt} — presente solo se il giocatore è stato assegnato durante l'asta
    aiSummary: riassunto AI generato (vedi sezione dedicata)
    aiRequest: stato coda riassunto async {status:'pending'|'error', ...}
    updatedBy, updatedAt: chi/quando ha modificato l'ultima volta (nome utente, oppure stringhe tipo "auto-enrichment (...)" quando a scrivere è stato uno script automatico)

roster_plans.data (per ogni piano rosa)
Aggiunta col kit v17. Ogni piano è un oggetto con:

    name: nome del piano (es. "Piano A", "Piano conservativo")
    slots: oggetto con chiavi P, D, C, A, ognuna un array di slot. Ogni slot ha:
        fascia: fascia target (Top/Semitop/Medio/Regolarista/Scommessa)
        archetipo: descrizione del profilo cercato (testo libero) o nome di un giocatore specifico
        budget: budget massimo allocato per quello slot (numero)
        note: note libere su cosa si cerca
        candidati: array di ID giocatore aggiunti come candidati per quello slot (kit v19/v20)
        ricerca: oggetto {posReali: [...], fasce: [...]} — criteri di ricerca salvati (kit v20 Ricerca per slot)

Sezioni del form giocatore
Anagrafica → Storico e statistiche anno scorso (sotto-sezioni: ⚽ Produzione offensiva, 📊 Qualità del voto, 🏃 Continuità e minutaggio, 🟨 Disciplina e malus, 🩺 Fisico e infortuni, 🧭 Contesto e trend, 📝 Note e mercato) → Titolarità → Valutazioni sulla squadra → Previsioni, note e meta.
(NON ripristinare la struttura originaria più granulare senza chiedere.)
Fasce giocatori (unificate col kit v4)
Le fasce NON sono più per-ruolo. Ora sono 5 fasce UGUALI per tutti i ruoli (P, D, C, A):
Top, Semitop, Medio, Regolarista, Scommessa.
Definite in FASCE_PER_RUOLO (che ora mappa ogni ruolo alle stesse 5 fasce). Il campo fascia del giocatore usa queste fasce.
Fasce modificatore difesa (8 scaglioni — REGOLE REALI DELLA LEGA)
Il modificatore difesa usa 8 scaglioni basati sulla media voto della difesa:
Media difesa
	
Bonus
< 6
	
0
≥ 6 e < 6.25
	
+1
≥ 6.25 e < 6.5
	
+2
≥ 6.5 e < 6.75
	
+3
≥ 6.75 e < 7
	
+4
≥ 7 e < 7.25
	
+5
≥ 7.25 e < 7.5
	
+5
≥ 7.5
	
+6
Definite in DF_MOD_DIFESA_FASCE nel codice (kit v15). Queste sono le regole REALI della lega dell'utente — NON cambiarle senza conferma esplicita.
Priorità (separata dalla fascia, kit v4)
priorita è un campo SEPARATO dalla fascia: è un select 0-5 con stelle (da "— nessuna —" a ★★★★★). Prima la priorità era DERIVATA dalla fascia (5 stelle = fascia Top), ora è un campo indipendente che l'utente imposta manualmente. Le stelle in alto a destra sulla card mostrano la priorita. La fascia è invece mostrata come badge/pill sulla card.
Tab "Rosa"

    Ricerca full-text su tutti i campi testuali + tag + campi personalizzati + contenuto del riassunto AI.
    Filtro per ruolo (P/D/C/A), Fascia, Ruolo reale, completezza scouting (✅ Completo / ⚠️ Incompleto, soglia 60% su 10 campi SCOUTING_FIELDS).
    Barra tag cliccabili (con conteggio) per filtrare per tag.
    ORDINAMENTO: select "Ordina per" con opzioni: Priorità, Fascia, Gol previsti, xG scorso, Gol scorso, Presenze, FM scorso, Nome, + 🔮 Media prevista e 🔮 Miglioramento atteso (kit v15/v16). Accanto, iconcina freccia ↑/↓ per direzione crescente/decrescente.
    Ogni card mostra: badge ruolo, nome, link alla squadra reale, stelle priorità, badge fascia, badge completezza scouting, statistiche chiave, tag, badge asta, badge "🌍 Fuori Serie A", chi/quando ha aggiornato.
    Badge proiezione 🔮 (kit v15/v16): su ogni card appare un chip colorato con la FM prevista e una freccia (▲▲/▲/＝/▼/▼▼) che indica la direzione. Cliccandolo si apre il modale proiezione.
    Badge Piano 🎯 (kit v17/v20): se il giocatore corrisponde a uno slot del piano attivo (per fascia o perché è nei candidati di uno slot), appare un badge 🎯 con riferimento reparto/slot/budget. La card ha anche un bordo evidenziato (piano-match).
    CARD FIELDS CUSTOMIZZABILI: pulsante 🎛️ per scegliere quali campi mostrare sulle card (salvati in localStorage).
    CARD DENSE (solo su PC/desktop): card più compatte in griglia a più colonne.
    Azioni per card: Apri/modifica, +Confronta, 🏷️ Assegna (solo se Modalità Asta ON), Elimina.

Tab "Squadre" (dossier tattici squadre reali)

    Pulsante dedicato "+ Nuova squadra" in cima.
    Card con stile di gioco + conteggio giocatori collegati (cliccabile, filtra la Rosa).
    Campi squadra reale: nome, baricentro, offensivita, esterniAlti, incentrataPunta, pressing, pericolosita (per calendario portieri), fragilitaDifensiva (per abbinamenti attaccanti), noteLibere, tag.

Tab "Confronto"

    Selezione fino a 3 giocatori (pillole).
    Tabella con righe = campi, colonne = giocatori, raggruppata in sezioni collassabili.
    Sezione dedicata "Riassunto AI": mostra il riassunto per default, con link "mostra note originali" per il testo grezzo.

Tab "Asta"

    Toggle "Modalità Asta" ON/OFF (condiviso tra utenti). Quando OFF nasconde: pulsante ⚡ fluttuante, pallino stato budget, pulsanti "Assegna giocatore"/"Modalità rapida", bottone "Assegna" sulle card (a meno che già assegnato).
    ⚙️ Impostazioni asta: budget di default, slot per reparto, gestione squadre della lega (aggiungi/elimina, marca "è la mia").
    Panoramica squadre: card con budget speso/rimasto (barra colorata) e slot riempiti per reparto.
    Tap su una squadra → dettaglio roster slot per slot per reparto.
    SIDEBAR ASTA (solo desktop, visibile quando Modalità Asta ON): pannello laterale con budget e slot di tutte le squadre.
    DRAG & DROP ASSEGNA (solo durante l'asta): trascinare una card giocatore su una squadra per assegnarla.
    Modalità Rapida (⚡): pannello fluttuante globale accessibile da qualunque schermata. Contiene: pillole squadre (con scorciatoia numerica), campo prezzo, ricerca giocatore con assegnazione istantanea al tap. Scorciatoie da tastiera: Alt+1..9 cambia squadra, frecce ↑↓ navigano, Invio assegna, Esc pulisce, Ctrl/Cmd+Z annulla ultima assegnazione.

Tab "War Room" (kit v13 + v14)
La War Room è un quartier generale per l'asta, accessibile dalla tab dedicata 🎯. Contiene quattro sotto-sezioni:
📊 Plancia

    Gauge circolare animato del budget della propria squadra (crediti rimasti/spesi).
    Statistiche: crediti spesi, giocatori presi, % rosa completa.
    Barre avanzamento reparti (P/D/C/A) con slot riempiti e spesa per reparto.
    Tavolo di guerra: classifica squadre della lega con budget rimasto e slot.
    Temperatura mercato: griglia 4 reparti × 5 fasce con indicatore 🔴 caldo / 🟡 normale / 🟢 freddo / ⚪ n/d.

🛒 Acquisti

    Lista dei giocatori acquistati dalla propria squadra, raggruppati per reparto.
    Statistiche: spesi/budget, rimasti, numero giocatori.
    Pulsante "⚡ Componi formazione dai migliori" per auto-riempire la formazione.
    Ogni acquisto mostra FM anno scorso → FM proiettata.

🧠 Formazione

    Lavagnetta tattica con campo da calcio e moduli selezionabili (4-3-3, 4-4-2, 3-5-2, 4-2-3-1, 4-3-1-2, 3-4-3, 5-3-2, 4-1-4-1).
    Token cliccabili per aggiungere/rimuovere giocatori dalla formazione.
    Panchina: giocatori oltre gli slot del modulo.
    Simulatore con: media squadra, modificatore, punti giornata, punti stagione.
    Media per reparto (P/D/C/A).
    Modificatore difesa con roadmap: mostra la fascia attuale e quanto manca per le fasce superiori, con suggerimento su quale difensore sostituire.
    Impostazioni: partite stagione, voto d'ufficio, fasce modificatore (8 scaglioni reali della lega).

📋 Piano (kit v17 + v18 + v20)

    Multi-piano: select per scegliere il piano attivo, pulsante "+ Nuovo piano", eliminazione. I piani sono salvati su Supabase (tabella roster_plans) e sincronizzati in tempo reale.
    Budget tracking: barra con budget allocato vs budget totale dell'asta, con percentuale.
    Slot per reparto: per ogni reparto (P/D/C/A) vengono mostrati tanti slot quanti configurati nelle impostazioni asta. Ogni slot ha:
        Fascia: select con le 5 fasce unificate.
        Archetipo: campo testo libero per descrivere il profilo cercato. Se il testo corrisponde al nome di un giocatore in rosa, appare una chip cliccabile ⚡ che apre la scheda del giocatore (kit v18/v20). Il campo ha anche un menu a tendina cliccabile (kit v20) che mostra giocatori matching durante la digitazione.
        Budget: input numerico per il budget massimo allocato.
        Note: textarea per dettagli, alternative, criteri di scelta.
        🎯 Candidati (kit v20): campo con menu a tendina cliccabile per aggiungere giocatori come candidati. Ogni candidato diventa una chip ⚡ cliccabile (apre la scheda) con ✕ per rimuoverlo. I candidati sono salvati come ID nel piano.
        🔍 Ricerca (kit v20 Ricerca per slot): pulsantino che apre un builder per impostare criteri di ricerca (Ruolo reale multi-select + Fascia multi-select). Mostra un conteggio live dei papabili. Una volta salvata, appare una chip blu cliccabile con il riepilogo della ricerca e il numero di papabili. Cliccandola si apre la lista dei papabili (righe cliccabili per aprire la scheda, bottone "+ candidato" per aggiungerli ai candidati dello slot). La ricerca è salvata in slot.ricerca.
    Evidenziazione nella Rosa: i giocatori che corrispondono a uno slot del piano attivo (per fascia match o perché sono nei candidati) vengono evidenziati nella tab Rosa con bordo ambra e badge 🎯. Questo è implementato wrappando checkPianoMatch.

Oracolo — Proiezioni giocatori (kit v15 + v16)
Come funziona
Per ogni giocatore con FM anno scorso, viene calcolata una proiezione della FM per la prossima stagione.
Euristica automatica (solo come fallback/suggerimento): analizza forma recente, rendimento vs xG, curva età, titolarità, fragilità, gol previsti vs scorsi, contesto offensivo squadra. Produce un delta e una FM prevista.
Giudizio umano (PRIORITARIO, kit v16): se l'utente ha impostato variazionePrevista (numero) o trendPrevisto (select), questi hanno priorità assoluta sull'euristica. Il modale proiezione mostra chiaramente la fonte: "✍️ la tua valutazione" vs "🤖 ipotesi automatica".
Modale proiezione (clic sul badge 🔮 della card)

    Mostra: FM anno scorso → delta → FM prevista, con verdetto (▲▲/▲/＝/▼/▼▼).
    Se fonte automatica: breakdown dei fattori con barre colorate.
    Se fonte umana: messaggio "Basata sulla tua valutazione".
    Sezione "✍️ La tua valutazione": select trend previsto + input variazione FM + textarea osservazioni. Tutto salvato su Supabase e condiviso col compagno.

Pulsante header "🔮 Proiezioni"
Apre una overview con Top 10 in crescita e Top 10 in calo.
Fasce modificatore difesa reali
DF_MOD_DIFESA_FASCE contiene gli 8 scaglioni reali della lega (vedi sezione dedicata sopra).
Window Manager (desktop)
Su schermi larghi (≥1024px) l'app usa un "window manager" invece dei modali: ogni editor si apre come finestra mobile, trascinabile, ridimensionabile, minimizzabile. Taskbar in basso. Snap ai bordi. Alt+W cicla tra le finestre. Su mobile (<1024px) si usano i modal classici.
Abbinamenti portieri (🧤)
Pulsante 🧤 in alto. Calcola le migliori coppie di portieri da alternare. Per ogni squadra viene preso SOLO il portiere TITOLARE presunto. Usa la pericolosita delle squadre avversarie dal calendario.
Abbinamenti attaccanti (⚔️)
Pulsante ⚔️ in alto. Calcola le migliori coppie di attaccanti complementari. Usa la fragilitaDifensiva delle squadre avversarie dal calendario. Per ogni squadra viene preso l'attaccante più rilevante (gol previsti, poi titolarità, poi gol anno scorso).
Riassunti AI per giocatore
Tre modalità (⚙️ AI, impostazioni locali al dispositivo, mai sincronizzate):

    OpenRouter (cloud): chiave API + modello.
    LM Studio (locale): URL default http://localhost:1234/v1, CORS abilitato.
    Ollama (locale/cloud): URL default http://localhost:11434/v1.

Tre azioni: ✨ Genera ora, 🕒 Richiedi async (solo LM Studio), 🚨 Emergenza OpenRouter.
Prompt di sistema in AI_SYSTEM_PROMPT (index.html) e replicato in lmstudio_worker.py.
Arricchimento automatico dei dati
Tentativo 1 (fallito): API-Football gratuito — bloccato strutturalmente (solo stagioni 2022-2024). File daily_enrichment.py + workflow GitHub Actions deprecati.
Soluzione adottata: ibrida, locale, gratuita, con ricerca web reale.

    L'utente ha GTX 3050 4GB + 16GB RAM, LM Studio con Beledarian's LM Studio Toolbox, modello Gemma 4.
    Flusso A — arricchimento campi mancanti: export_missing_fields.py → players_todo.json → prompt prompt_arricchimento.txt in LM Studio → players_result.json → import ⬆️ nell'app.
    Flusso B — sincronizzazione rosa completa: export_full_roster_context.py → current_roster.json → prompt prompt_sincronizzazione_rosa.txt → roster_sync_result.json → apply_roster_sync.py.

Regola di sicurezza: mai sovrascrivere campi già compilati. ECCEZIONE per squadra se scritta dall'automatismo (updatedBy contiene "auto-enrichment").
Fuori Serie A (🌍)
Il campo custom.fuoriSerieA segnala un giocatore non più in Serie A. Gestito come campo personalizzato RIMOVIBILE. Pulsante 🌍 in alto apre la lista con checkbox e avviso se ha già note. Eliminazione sempre manuale con conferma.
Elenco completo dei file
File
	
Cosa fa
index.html (deploy)
	
L'app intera. Da caricare su Netlify con manifest.json e icone.
manifest.json, icon-192.png, icon-512.png
	
PWA — rendono l'app installabile.
import_giocatori_listone_2026.json
	
Import iniziale one-off del listone (663 giocatori). Riferimento storico.
lmstudio_worker.py
	
Worker coda riassunti AI async. Da lanciare a mano.
daily_enrichment.py
	
Deprecato: API-Football bloccato dal piano gratuito.
.github/workflows/daily-enrichment.yml
	
Deprecato: collegato a daily_enrichment.py.
export_missing_fields.py
	
Flusso A, step 1: esporta giocatori con buchi.
prompt_arricchimento.txt
	
Flusso A, step 2: prompt per LM Studio.
export_full_roster_context.py
	
Flusso B, step 1: esporta rosa attuale.
prompt_sincronizzazione_rosa.txt
	
Flusso B, step 2: prompt per nuovi giocatori/fuori Serie A.
apply_roster_sync.py
	
Flusso B, step 3: applica risultati in scrittura sicura.
Recap.md
	
Questo file.
Kit di aggiornamento (file HTML patch, applicati in ordine)
Il progetto è stato aggiornato tramite "kit" — file HTML che, aperti nel browser, caricano index.html e applicano modifiche automatiche (find/replace). Ogni kit ha un numero di versione.
Kit applicati (in ordine cronologico):
Kit
	
Descrizione
v1/v2
	
posReale autocomplete
v3
	
sorting/filtering migliorato, campi card customizzabili, fix AI summaries (Ollama), abbinamenti portieri per squadra
v4
	
fix card fields, split Priorità/Fasce, fasce unificate a 5
v5
	
direzione ordinamento (freccia ↑/↓)
v6
	
riordino menù filtri
v6b/v7
	
Fuori Serie A come campo personalizzato rimovibile
v8
	
upgrade grafico + multitasking (window snapping, drag & drop, Alt+W)
v9
	
drag & drop solo durante l'asta, sidebar asta, card dense PC
v10
	
Dossier Design System (font, sfondo, restyling completo)
v11
	
upgrade menu statistiche (sotto-sezioni con emoji)
v12
	
Simulatore punteggio + formazioni salvate
v13
	
War Room Dashboard (plancia con gauge, reparti, tavolo guerra, temperatura mercato, ticker, top valore)
v14
	
War Room 2.0 Quartier Generale (sotto-sezioni Plancia/Acquisti/Formazione, lavagnetta tattica, simulatore con modificatore e roadmap, fusione tab Asta+War Room)
v15
	
Oracolo (proiezioni giocatori con euristica automatica, badge 🔮 sulle card, modale proiezione, ordinamenti per proiezione, fasce modificatore difesa reali a 8 scaglioni)
v16
	
Oracolo v2 (giudizio umano prioritario sull'euristica: trendPrevisto + variazionePrevista, fonte "✍️ la tua valutazione" vs "🤖 ipotesi automatica")
v17
	
Piano Rosa (nuova sotto-sezione 📋 Piano nella War Room: multi-piano su Supabase, slot per reparto con fascia/archetipo/budget/note, budget tracking, evidenziazione 🎯 nella Rosa, realtime sync su roster_plans)
v18
	
Chip giocatore nel Piano (l'archetipo, se corrisponde a un giocatore in rosa, diventa chip ⚡ cliccabile che apre la scheda; datalist autocomplete; wrap di bindPianoEvents)
v19
	
Candidati multi-chip (sostituito/assorbito dal v20) — sistema tag-like per aggiungere più giocatori per slot come chip cliccabili, con ✕ per rimuovere, evidenziazione nella Rosa via wrap di checkPianoMatch
v20a
	
Menu cliccabile + Candidati (sostituisce il datalist nativo con un menu a tendina custom cliccabile su Candidati e Archetipo; sync con setInterval 600ms; wrap di wrRenderPiano e checkPianoMatch; chip ⚡ con ✕ per i candidati)
v20b
	
Ricerca per slot (pulsantino 🔍 accanto all'archetipo: builder con Ruolo reale multi + Fascia multi, conteggio live papabili, chip blu cliccabile con riepilogo, modale risultati con righe cliccabili e "+ candidato"; salvataggio in slot.ricerca; wrap di bindPianoEvents)
v21
	
Fix conflitto __v20done tra v20a e v20b — tentativo fallito: il kit non ha trovato i pattern nel file perché l'utente aveva già modificato il codice a mano. Il conflitto va gestito manualmente o con un nuovo kit basato sul file attuale.
Problemi noti e conflitti tra kit
Conflitto __v20done (v20a vs v20b)
I due kit v20 usano entrambi il flag slotEl.__v20done per marcare gli slot già potenziati. Quando il kit v20b (Ricerca per slot) gira per primo, imposta __v20done=true e il kit v20a (Candidati con menu cliccabile) salta l'iniezione perché vede il flag già impostato. Risultato: le chip dei candidati non appaiono e il menu cliccabile non viene iniettato.
Stato attuale: l'utente ha fatto fix manuali. Il problema potrebbe essere parzialmente risolto nel file attuale (index(16).txt). Da verificare.
Bug segnalato: "il piano si chiude cliccando i filtri"
L'utente ha riportato che cliccando i toggle nel builder della Ricerca per slot, il piano si chiude e le chip dei candidati non riappaiono. Causa probabile: il v20Refresh() nel salvataggio della ricerca fa un re-render completo del piano, e durante il re-render il conflitto __v20done impedisce la re-iniezione delle UI dei candidati. Da verificare se il fix manuale dell'utente ha risolto.
Decisioni di design da NON invertire senza che l'utente lo chieda esplicitamente

    Niente cancellazioni automatiche di giocatori, mai — solo flag + conferma manuale.
    La chiave OpenRouter/impostazioni AI sono personali per dispositivo, mai sincronizzate su Supabase condiviso.
    Il campo squadra del giocatore va lasciato inserire all'utente / agli script di arricchimento.
    Sezioni del form giocatore: già consolidate, non extra-frammentare.
    Pulsante creazione singolo giocatore: volutamente nascosto dentro il modale di importazione.
    "Modalità Asta" nasconde gli strumenti di assegnazione quando OFF — stato condiviso tra i due utenti.
    Import in blocco fa upsert che sovrascrive l'intero data per l'id dato — mai usarlo per aggiornamenti parziali/flag.
    Fasce giocatori: unificate a 5 per tutti i ruoli. NON tornare alle fasce per-ruolo.
    Priorità: campo manuale SEPARATO dalla fascia. NON derivarla dalla fascia.
    posReale: autocomplete con datalist. NON è un campo select fisso.
    Tema visivo: Dossier Design System. NON tornare al tema piatto precedente.
    Fasce modificatore difesa: 8 scaglioni reali della lega (bonus 0/1/2/3/4/5/5/6). NON cambiarle senza conferma.
    Oracolo: il giudizio umano (trendPrevisto/variazionePrevista) ha PRIORITÀ sull'euristica automatica. NON invertire questa priorità.
    Piano Rosa: il budget è FLESSIBILE (si può sforare). NON renderlo rigido.
    Piano Rosa: multi-piano supportato. NON limitare a un solo piano.
    Piano Rosa: niente stelle di priorità sugli slot (l'utente ha detto esplicitamente di no).
    Piano Rosa: è dentro la War Room come sotto-sezione, NON è una tab separata.
    Ricerca per slot: i candidati sono salvati come ID giocatore, NON come nomi.

# Recap DossierFanta

## Cos'è

Web-app per la preparazione dell'asta del fantacalcio, condivisa in tempo reale tra due persone (l'utente e il suo compagno di lega). Gira come sito statico (pensato per hosting su Netlify), con Supabase come backend condiviso. Nessun account/login: la condivisione avviene tramite lo stesso URL/file e le stesse credenziali Supabase incorporate nel codice.

Nome interno: **DossierFanta**.

---

## Stack tecnico

- **Frontend**: un unico file HTML (`index.html`) — vanilla JS, nessun framework, CSS scritto a mano.
- **Tema visivo**: "Dossier Design System" (introdotto col kit v10) — scuro verde-campo/ambra, font Archivo (display) + JetBrains Mono (dati/numeri), sfondo ambientale con luci radiali e linee orizzontali, micro-interazioni (hover lift, sync pulse, sheen sulle barre budget), rispetto di `prefers-reduced-motion`.
- **Backend dati**: Supabase (Postgres + REST + Realtime).
  - URL progetto: `https://ubiilhfedzodyyxrwbdq.supabase.co`
  - Chiave client (anon/publishable key, pensata per stare nel codice pubblico): `sb_publishable_rMIEJrNJ9rwBNn0T650WBQ_Q45iRMRg`
  - Tutte le tabelle hanno RLS abilitato con policy "public access" (lettura e scrittura aperte a chiunque abbia la chiave) — va bene per uso privato tra due persone, da rivedere se l'app viene condivisa più ampiamente.
  - Client JS caricato da CDN: `@supabase/supabase-js@2` (jsDelivr).
- **Sync in tempo reale**: Supabase Realtime (`postgres_changes`) su tutte le tabelle: se una persona modifica qualcosa, l'altra lo vede aggiornarsi da solo, senza refresh.
- **Autosave**: nei form di modifica, niente pulsante "salva" — autosave con debounce ~1.2s dopo l'ultima modifica.
- **PWA**: installabile come app (manifest.json + icone), utile per tenerla aperta in una finestra separata durante l'asta.

---

## Schema Supabase

```sql
create table players (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table teams (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table league_teams (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table creator_opinions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table player_videos (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table calendario_serie_a (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
create table roster_plans (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);

alter table players enable row level security;
alter table teams enable row level security;
alter table league_teams enable row level security;
alter table creator_opinions enable row level security;
alter table player_videos enable row level security;
alter table calendario_serie_a enable row level security;
alter table roster_plans enable row level security;

create policy "public access" on players for all using (true) with check (true);
create policy "public access" on teams for all using (true) with check (true);
create policy "public access" on league_teams for all using (true) with check (true);
create policy "public access" on creator_opinions for all using (true) with check (true);
create policy "public access" on player_videos for all using (true) with check (true);
create policy "public access" on calendario_serie_a for all using (true) with check (true);
create policy "public access" on roster_plans for all using (true) with check (true);

alter publication supabase_realtime add table players, teams, league_teams,
  creator_opinions, player_videos, calendario_serie_a, roster_plans;
Stato attuale e prossimi passi
Stato attuale

    L'app ha le tab: Rosa, Squadre, Confronto, Asta, War Room (con sotto-sezioni Plancia/Acquisti/Formazione/Piano).
    I kit v12-v17 e v20a/v20b sono applicati nel file index.html attuale.
    Il kit v19 è stato assorbito/sostituito dal v20.
    L'Oracolo (v15/v16) è funzionante: badge 🔮 sulle card, modale proiezione, giudizio umano prioritario.
    Le fasce del modificatore difesa sono quelle reali della lega (8 scaglioni).
    Il Piano Rosa (v17) è funzionante: multi-piano, slot con fascia/archetipo/budget/note, budget tracking, evidenziazione nella Rosa.
    I Candidati con menu cliccabile (v20a) sono applicati ma hanno un conflitto noto col v20b sul flag __v20done.
    La Ricerca per slot (v20b) è applicata ma ha il bug del "piano si chiude" quando si salvano i criteri di ricerca.
    L'utente ha fatto fix manuali al file. Lo stato esatto va verificato sul file attuale.

Prossimi passi aperti / idee non ancora implementate

    Verificare/risolvere il conflitto __v20done tra kit v20a e v20b: il kit v21 ha fallito perché il file era già stato modificato a mano. Serve un nuovo approccio basato sul file attuale, oppure una riscrittura pulita della sezione Piano che unifichi candidati e ricerca senza conflitti di flag.
    Verificare il bug "il piano si chiude" quando si salvano i criteri di ricerca nel builder. Probabilmente legato al re-render completo + conflitto flag.
    Migliorare l'Oracolo: l'utente ha segnalato che la stima automatica è "piuttosto sbagliata". Il kit v16 ha dato priorità al giudizio umano, ma l'euristica automatica potrebbe essere ulteriormente migliorata o resa più trasparente.
    Temperature di mercato più accurate: l'utente ha espresso interesse a rendere la temperatura di mercato più accurata. Non ancora implementato.
    Possibile idea futura: unire i due flussi di arricchimento (A e B) in un unico prompt — l'utente ha detto di preferirli separati per ora.
    Nota sui kit: il sistema di kit find/replace è diventato fragile con l'accumularsi di patch che wrappano le stesse funzioni (bindPianoEvents, wrRenderPiano, checkPianoMatch). Se si continua ad aggiungere funzionalità al Piano, è consigliabile riscrivere l'intera sezione Piano come blocco unico pulito invece di continuare con kit incrementali.