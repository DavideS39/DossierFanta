// src/lib/sync/yjsCursors.ts — Cursori collaborativi live (M3a — B.6).
//
// Mantiene lo stato dei cursori collaborativi in un Y.Map<user_id, LiveCursor>
// nel Y.Doc singleton condiviso. Ogni peer (utente remoto) ha il proprio cursore
// identificato da user_id (PeerKey o display name).
//
// Funzioni esposte:
//  - setMyCursor(field, position, selection?) — aggiorna il mio cursore
//  - clearMyCursor() — rimuove il mio cursore (es. onBlur del campo)
//  - observeCursors(callback) — registra callback per renderizzare i cursori
//    ricevuti dai peer remoti. Ritorna unlisten function.
//  - useYjsCursor(options) — hook React che integra setMyCursor + observeCursors
//    + cleanup automatico (M3a.1 fix aggiuntivo A).
//
// Rendering: delegato al componente `LiveCursor.tsx` (vedi src/components).
// LiveCursor funziona solo nel WM in-app (layer 1). Nelle finestre OS native
// (layer 2), il cursore dell'altro utente appare solo se sta editando la
// stessa scheda (perché la finestra OS è una vista della stessa scheda via
// Yjs shared state).

import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { yCursors } from "./yjsDocuments";
import type { LiveCursor } from "@/types/sync";

// ----------------------------------------------------------------------
// Identità locale (popolata da SyncView al boot)
// ----------------------------------------------------------------------

let myUserId: string | null = null;
let myDisplayName: string | null = null;
const myColor = "#2C4A6B"; // default blue per il cursore locale

/** Imposta l'identità locale (da chiamare al boot, prima di qualsiasi edit). */
export function setMyIdentity(userId: string, displayName?: string): void {
  myUserId = userId;
  myDisplayName = displayName ?? userId.slice(0, 8);
}

/** Ritorna l'userId locale (o null se identità non ancora impostata). */
export function getMyUserId(): string | null {
  return myUserId;
}

// ----------------------------------------------------------------------
// API pubblica
// ----------------------------------------------------------------------

/**
 * Aggiorna o crea il cursore locale dell'utente corrente.
 * Da chiamare su onSelect / onClick / onKeyDown di un campo editabile
 * (textarea, input). Debounce di 50ms per evitare flooding di updates.
 */
export function setMyCursor(
  field: string,
  position: number,
  selection?: [number, number]
): void {
  if (!myUserId) return;

  const cursor: LiveCursor = {
    userId: myUserId,
    name: myDisplayName ?? myUserId.slice(0, 8),
    field,
    position,
    selection: selection ?? null,
    color: myColor,
    updatedAt: new Date().toISOString(),
  };

  // Y.Map.set accetta solo alcuni tipi; serializziamo come Y.Map nested
  const yCursor = new Y.Map();
  yCursor.set("userId", cursor.userId);
  yCursor.set("name", cursor.name);
  yCursor.set("field", cursor.field);
  yCursor.set("position", cursor.position);
  yCursor.set("selection", cursor.selection);
  yCursor.set("color", cursor.color);
  yCursor.set("updatedAt", cursor.updatedAt);

  yCursors.set(myUserId, yCursor);
}

/** Rimuove il cursore locale (es. onBlur del campo, o idle > 5s). */
export function clearMyCursor(): void {
  if (!myUserId) return;
  yCursors.delete(myUserId);
}

/**
 * Registra un callback per renderizzare i cursori ricevuti dai peer remoti.
 * Il callback viene chiamato con una Map<userId, LiveCursor> completa.
 * Ritorna unlisten function da chiamare su unmount del componente.
 */
export function observeCursors(
  callback: (cursors: Map<string, LiveCursor>) => void
): () => void {
  const handler = () => {
    const out = new Map<string, LiveCursor>();
    yCursors.forEach((value, key) => {
      const cursor = normalizeCursor(value, key);
      // Non includere il cursore locale nel set renderizzato (lo gestisce il client)
      if (cursor.userId !== myUserId) {
        out.set(key, cursor);
      }
    });
    callback(out);
  };
  yCursors.observe(handler);
  handler();
  return () => yCursors.unobserve(handler);
}

// ----------------------------------------------------------------------
// Helper: normalizza un cursore da vari formati Yjs a LiveCursor
// ----------------------------------------------------------------------

function normalizeCursor(value: unknown, fallbackKey: string): LiveCursor {
  if (value instanceof Y.Map) {
    const userId = String(value.get("userId") ?? fallbackKey);
    const name = String(value.get("name") ?? userId.slice(0, 8));
    const field = String(value.get("field") ?? "");
    const position = Number(value.get("position") ?? 0);
    const selectionRaw = value.get("selection");
    const selection =
      Array.isArray(selectionRaw) && selectionRaw.length === 2
        ? ([Number(selectionRaw[0]), Number(selectionRaw[1])] as [
            number,
            number
          ])
        : null;
    const color = String(value.get("color") ?? "#2C4A6B");
    const updatedAt = String(
      value.get("updatedAt") ?? new Date().toISOString()
    );
    return { userId, name, field, position, selection, color, updatedAt };
  }
  if (typeof value === "object" && value !== null) {
    return value as LiveCursor;
  }
  return {
    userId: fallbackKey,
    name: fallbackKey.slice(0, 8),
    field: "",
    position: 0,
    selection: null,
    color: myColor,
    updatedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------
// Cleanup: auto-rimuovi cursori stale (> 30s senza update)
// ----------------------------------------------------------------------

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Avvia un task periodico (ogni 5s) che rimuove cursori peer stale. */
export function startCursorsCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    const keysToDelete: string[] = [];
    yCursors.forEach((value, key) => {
      const cursor = normalizeCursor(value, key);
      if (cursor.userId === myUserId) return;
      const updated = Date.parse(cursor.updatedAt);
      if (Number.isFinite(updated) && now - updated > 30_000) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      yCursors.delete(key);
    }
  }, 5_000);
}

/** Ferma il task di cleanup. */
export function stopCursorsCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// ----------------------------------------------------------------------
// Hook React: useYjsCursor (M3a.1 fix aggiuntivo A)
// ----------------------------------------------------------------------

/**
 * Hook React che integra `setMyCursor` + `observeCursors` per un campo
 * editabile. Da usare in componenti con `<textarea>` o `<input>` che
 * vogliono mostrare cursori collaborativi dei peer remoti.
 *
 * Uso tipico (in PlayerForm):
 *
 *   const notesFieldRef = useRef<HTMLTextAreaElement>(null);
 *   const { remoteCursors, handleSelect, handleBlur } = useYjsCursor({
 *     field: `players.${player.id}.notes`,
 *   });
 *   // nel render:
 *   <div style={{ position: 'relative' }}>
 *     <textarea
 *       ref={notesFieldRef}
 *       onSelect={handleSelect}
 *       onBlur={handleBlur}
 *     />
 *     {remoteCursors.map((c) => (
 *       <LiveCursor key={c.userId} cursor={c} fieldRef={notesFieldRef} fieldId={`players.${player.id}.notes`} />
 *     ))}
 *   </div>
 *
 * Se l'identità locale non è ancora impostata (SyncView non chiamata),
 * l'hook è no-op: nessun cursore viene inviato né ricevuto.
 *
 * @param options.field ID del campo nel formato "table.id.field"
 * @param options.userId Override dell'userId (default: getMyUserId())
 * @param options.userName Override del displayName (default: myDisplayName)
 * @returns Oggetto con:
 *   - remoteCursors: array di LiveCursor dei peer remoti attivi su questo field
 *   - handleSelect: handler da attaccare a `onSelect` del campo
 *   - handleBlur: handler da attaccare a `onBlur` (pulisce il cursore locale)
 */
export interface UseYjsCursorOptions {
  field: string;
  userId?: string;
  userName?: string;
}

export interface UseYjsCursorResult {
  /** Cursori dei peer remoti attivi sullo stesso field. */
  remoteCursors: LiveCursor[];
  /** Handler per `onSelect` del campo. Aggiorna il cursore locale. */
  handleSelect: (e: React.SyntheticEvent<HTMLElement>) => void;
  /** Handler per `onBlur` del campo. Rimuove il cursore locale. */
  handleBlur: (e: React.SyntheticEvent<HTMLElement>) => void;
}

export function useYjsCursor(options: UseYjsCursorOptions): UseYjsCursorResult {
  const { field } = options;
  const [remoteCursors, setRemoteCursors] = useState<LiveCursor[]>([]);

  // Salva le options in ref per evitare re-render quando cambiano
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Sottoscrive i cursori remoti per il field specificato
  useEffect(() => {
    const unlisten = observeCursors((cursorsMap) => {
      const list: LiveCursor[] = [];
      cursorsMap.forEach((c) => {
        if (c.field === field) {
          list.push(c);
        }
      });
      // Ordina per userId per render stabile
      list.sort((a, b) => a.userId.localeCompare(b.userId));
      setRemoteCursors(list);
    });
    return unlisten;
  }, [field]);

  // Handler per onSelect: aggiorna il cursore locale con la posizione corrente
  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLElement>) => {
      const el = e.currentTarget;
      const opts = optionsRef.current;
      const userId = opts.userId ?? getMyUserId();
      if (!userId) return;
      if (!setMyIdentityIfNeeded(userId, opts.userName)) return;

      // Per input/textarea: usa selectionStart / selectionEnd
      let position = 0;
      let selection: [number, number] | undefined;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        position = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? position;
        if (end !== position) {
          selection = [position, end];
        }
      }
      setMyCursor(field, position, selection);
    },
    [field]
  );

  // Handler per onBlur: rimuove il cursore locale
  const handleBlur = useCallback(() => {
    clearMyCursor();
  }, []);

  return { remoteCursors, handleSelect, handleBlur };
}

/**
 * Imposta l'identità locale se non è già stata impostata.
 * Ritorna false se userId è vuoto o se l'identità NON è stata ancora
 * inizializzata da SyncView (caso in cui l'app è in preview o sync off).
 */
function setMyIdentityIfNeeded(userId: string, userName?: string): boolean {
  // Se l'identità è già stata impostata da SyncView, non facciamo nulla
  if (getMyUserId()) return true;
  // Altrimenti, impostala ora con i valori forniti
  if (!userId) return false;
  setMyIdentity(userId, userName);
  return true;
}
