/**
 * TagInput — M4 (v2.6) — Input per aggiungere/rimuovere tag da un player.
 *
 * Struttura:
 *  - Input text + button "aggiungi"
 *  - Autocomplete: <datalist> popolata con le label già usate (da listAllTagLabels)
 *  - On submit: api.createTag(playerId, label) → refresh
 *  - Mostra i tag esistenti del player come TagStamp con onRemove → deleteTag
 *  - Layout: flex wrap, gap 4px
 *
 * Usato nel PlayerForm quando il form è aperto in modalità edit.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/tauri";
import type { Tag, TagLabelCount } from "@/types/player";
import { TagStamp } from "./TagStamp";

interface TagInputProps {
  playerId: string;
  /** Tag già presenti sul player (passati dal parent per evitare refetch). */
  tags: Tag[];
  /** Tutte le label già usate (per autocomplete). Se omesso, fa fetch interno. */
  allLabels?: TagLabelCount[];
  /** Callback dopo creazione/cancellazione tag (parent refresh). */
  onChanged?: () => void;
}

export function TagInput({ playerId, tags, allLabels, onChanged }: TagInputProps) {
  const [text, setText] = useState("");
  const [labels, setLabels] = useState<TagLabelCount[]>(allLabels ?? []);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useMemo(() => `tag-input-list-${playerId.slice(0, 8)}`, [playerId]);

  // Se allLabels non è passato, fa fetch interno.
  useEffect(() => {
    if (allLabels) {
      setLabels(allLabels);
      return;
    }
    let cancelled = false;
    api.listAllTagLabels()
      .then((rows) => {
        if (!cancelled) setLabels(rows);
      })
      .catch(() => {
        // ignore — anteprima web può fallire
      });
    return () => {
      cancelled = true;
    };
  }, [allLabels]);

  const submit = async () => {
    const label = text.trim();
    if (!label || busy) return;
    setBusy(true);
    try {
      await api.createTag(playerId, label);
      setText("");
      // Refresh label list (la label nuova potrebbe essere inedita).
      try {
        const rows = await api.listAllTagLabels();
        setLabels(rows);
      } catch {
        // ignore
      }
      onChanged?.();
      // Focus di nuovo sull'input per inserimento rapido consecutivo.
      inputRef.current?.focus();
    } catch (e) {
      console.error("[TagInput] createTag failed:", e);
      alert(`Impossibile creare tag: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (tag: Tag) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteTag(tag.id);
      onChanged?.();
    } catch (e) {
      console.error("[TagInput] deleteTag failed:", e);
      alert(`Impossibile eliminare tag: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "," || e.key === "Tab") {
      // Virgola o Tab = submit (stile tag input classico).
      if (text.trim()) {
        e.preventDefault();
        void submit();
      }
    }
  };

  return (
    <div className="tag-input">
      <div className="tag-input__existing">
        {tags.length === 0 ? (
          <span className="tag-input__empty">nessun tag</span>
        ) : (
          tags.map((t) => (
            <TagStamp
              key={t.id}
              tag={t}
              size="sm"
              onRemove={() => handleRemove(t)}
              title={`${t.label} — click ✕ per rimuovere`}
            />
          ))
        )}
      </div>
      <div className="tag-input__row">
        <input
          ref={inputRef}
          type="text"
          className="tacc-input tag-input__field"
          list={listId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Aggiungi tag (es. rigorista, ex-Milan, occhio infortuni)"
          disabled={busy}
          maxLength={60}
          style={{ fontSize: "0.7rem", flex: 1, minWidth: 180 }}
        />
        <datalist id={listId}>
          {labels.map((row) => (
            <option key={row.label} value={row.label}>
              {row.count} giocatori
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className="df-btn tag-input__add"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          title="Aggiungi tag (Enter)"
          style={{ fontSize: "0.7rem", padding: "0.2rem 0.6rem" }}
        >
          + aggiungi
        </button>
      </div>
      <div className="tag-input__hint">
        ↳ testo libero · Enter o virgola per confermare · autocomplete dalle label già usate
      </div>
    </div>
  );
}
