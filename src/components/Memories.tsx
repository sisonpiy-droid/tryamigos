"use client";

import { useState } from "react";

import { Avatar } from "@/components/Avatar";
import { mentions, type SoloMemory, type SoloMuse } from "@/lib/solo/store";

/* Everything a character knows about you, and the ability to be wrong about it.
 *
 * Until now this was a number on a card. "remembers 12" — twelve what? A
 * character who had misheard a sister's name, or held onto a job the user left
 * two years ago, went on quietly shaping every reply with it, and the only cure
 * was deleting the character and losing the other eleven along with it.
 *
 * For something whose entire promise is that it remembers you, not being able
 * to look at that is the gap that matters most. It is also the one place where
 * being able to say "no, that's wrong" costs nothing and buys a great deal of
 * trust.
 *
 * What is shown is deliberately less than what is stored. `confidence` is a
 * ranking weight and means nothing to a reader; `type` is worth a glance
 * because it explains why something is still around; `importance` is worth
 * editing because it is how a character decides what to bring up. So: the
 * sentence, a quiet line of context, and two ways to change it.
 */

const WHEN = (iso: string): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months <= 1 ? "last month" : `${months} months ago`;
  }
  return "over a year ago";
};

/* The stored types, in the words someone reading them would use. */
const KIND: Record<string, string> = {
  PERMANENT: "about you",
  PREFERENCE: "what you like",
  GOAL: "working towards",
  RELATIONSHIP: "people",
  EVENT: "something that happened",
  SHARED: "between you two",
  PROMISE: "said they'd tell you",
};

function Row({
  memory,
  onEdit,
  onDelete,
}: {
  memory: SoloMemory;
  onEdit: (patch: { content?: string; importance?: number }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const [importance, setImportance] = useState(memory.importance);

  if (editing) {
    return (
      <li className="memory memory-editing">
        <textarea
          className="input"
          rows={2}
          value={text}
          autoFocus
          maxLength={400}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setEditing(false); setText(memory.content); }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (text.trim()) onEdit({ content: text.trim(), importance });
              setEditing(false);
            }
          }}
        />
        <div className="row" style={{ gap: "0.6rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          <label className="fine" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            How much it matters
            <select
              className="input"
              style={{ width: "auto", padding: "0.25rem 0.4rem" }}
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
            >
              <option value={1}>barely</option>
              <option value={2}>a little</option>
              <option value={3}>normal</option>
              <option value={4}>a lot</option>
              <option value={5}>never forget</option>
            </select>
          </label>
          <button
            className="link-btn"
            onClick={() => {
              if (text.trim()) onEdit({ content: text.trim(), importance });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="link-btn" onClick={() => { setEditing(false); setText(memory.content); }}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="memory">
      <p>{memory.content}</p>
      <div className="memory-meta">
        <span>{KIND[memory.type] ?? "about you"}</span>
        <span>·</span>
        <span>learned {WHEN(memory.createdAt)}</span>
        {memory.importance >= 4 && <><span>·</span><span>brings this up</span></>}
        <button onClick={() => { setText(memory.content); setEditing(true); }}>correct</button>
        <button
          onClick={() => {
            if (confirm(`Forget this?\n\n"${memory.content}"\n\nIt will not come back, even if you talk about it again.`)) {
              onDelete();
            }
          }}
        >
          forget
        </button>
      </div>
    </li>
  );
}

export function Memories({
  muse,
  memories,
  onEdit,
  onDelete,
  onForgetAll,
  onBack,
}: {
  muse: SoloMuse;
  memories: SoloMemory[];
  onEdit: (id: string, patch: { content?: string; importance?: number }) => void;
  onDelete: (id: string) => void;
  onForgetAll: () => void;
  onBack: () => void;
}) {
  /* "Forget about Goa": every memory that mentions it, in one go. */
  const [about, setAbout] = useState("");
  const matching = about.trim() ? memories.filter((m) => mentions(m.content, about)) : [];
  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Memory</p>
        <button className="link-btn" onClick={onBack}>Back</button>
      </header>

      <div className="row" style={{ gap: "0.75rem", marginTop: "1.5rem", alignItems: "center" }}>
        <Avatar name={muse.name} image={muse.avatar?.id} />
        <div style={{ minWidth: 0 }}>
          <h1 className="display" style={{ fontSize: "1.6rem", margin: 0 }}>
            What {muse.name} knows
          </h1>
          <p className="fine" style={{ margin: 0 }}>
            {memories.length === 0
              ? "Nothing yet."
              : `${memories.length} ${memories.length === 1 ? "thing" : "things"}, picked up from talking to you.`}
          </p>
        </div>
      </div>

      {memories.length === 0 ? (
        <div className="empty" style={{ marginTop: "2.5rem" }}>
          <p style={{ fontFamily: "var(--serif)", fontSize: "1.05rem" }}>
            {muse.name} hasn&apos;t learned anything about you yet.
          </p>
          <p className="fine">
            Things you mention in conversation end up here on their own — a name, a job, something
            you&apos;re dreading. You can correct any of it, or throw it away.
          </p>
        </div>
      ) : (
        <>
          <form
            className="row forget-about"
            onSubmit={(e) => {
              e.preventDefault();
              if (!matching.length) return;
              if (confirm(`Make ${muse.name} forget ${matching.length} ${matching.length === 1 ? "thing" : "things"} about "${about.trim()}"? It will not come back.`)) {
                matching.forEach((m) => onDelete(m.id));
                setAbout("");
              }
            }}
          >
            <input
              className="input"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Forget about… (e.g. Goa)"
              aria-label={`Make ${muse.name} forget everything about`}
            />
            <button className="btn" disabled={!matching.length}>
              {about.trim() ? `Forget ${matching.length}` : "Forget"}
            </button>
          </form>

          <ul className="memories">
            {(matching.length ? matching : memories).map((m) => (
              <Row
                key={m.id}
                memory={m}
                onEdit={(patch) => onEdit(m.id, patch)}
                onDelete={() => onDelete(m.id)}
              />
            ))}
          </ul>

          <div className="row" style={{ marginTop: "2rem", gap: "0.75rem" }}>
            <button
              className="link-btn"
              onClick={() => {
                if (confirm(
                  `Make ${muse.name} forget all ${memories.length} of these?\n\nYour conversation is kept — only what they learned from it goes. It will not come back.`
                )) {
                  onForgetAll();
                }
              }}
            >
              Forget everything
            </button>
          </div>
        </>
      )}

      <p className="fine" style={{ marginTop: "2.5rem" }}>
        Corrections take effect from your next message. Anything you forget stays forgotten —
        {" "}{muse.name} will not pick it up again from an older part of the conversation.
      </p>
    </main>
  );
}
