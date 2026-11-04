"use client";

import { useState } from "react";

/* Traits as chips: tap one to take it off, type or tap a suggestion to add one.
 *
 * Controlled, so the caller decides where they are saved -- a person's own
 * profile, or a circle's idea of what the group is like. */

export const TRAIT_MAX = 8;

export function TraitEditor({
  traits,
  onChange,
  suggestions = [],
  label = "Add a trait",
}: {
  traits: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  label?: string;
}) {
  const [draft, setDraft] = useState("");
  const full = traits.length >= TRAIT_MAX;

  const add = (raw: string) => {
    const t = raw.trim().toLowerCase().slice(0, 30);
    if (!t || traits.includes(t) || full) return;
    onChange([...traits, t]);
  };

  const ideas = suggestions.filter((s) => !traits.includes(s)).slice(0, 6);

  return (
    <div className="trait-editor">
      <div className="tags">
        {traits.map((t) => (
          <button
            key={t}
            type="button"
            className="tag tag-on"
            onClick={() => onChange(traits.filter((x) => x !== t))}
            aria-label={`Remove ${t}`}
          >
            {t} ×
          </button>
        ))}
        {!full &&
          ideas.map((s) => (
            <button key={s} type="button" className="tag tag-idea" onClick={() => add(s)}>
              + {s}
            </button>
          ))}
      </div>
      <div className="row trait-add">
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
              setDraft("");
            }
          }}
          placeholder={full ? "That is plenty" : label}
          maxLength={30}
          disabled={full}
          aria-label={label}
        />
        <button
          className="btn-ghost"
          type="button"
          disabled={!draft.trim() || full}
          onClick={() => {
            add(draft);
            setDraft("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
