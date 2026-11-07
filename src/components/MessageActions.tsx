"use client";

import { useState } from "react";

import { REACTIONS } from "@/lib/solo/store";

/* Edit and delete, on any message in any thread.
 *
 * Editing a Muse's own line is allowed on purpose. A companion that says one
 * wrong thing poisons everything after it, because the next reply is built on
 * a transcript that now contains the mistake -- fixing the line is more useful
 * than arguing with it. It is also honest about what this is: your copy of a
 * conversation, on your device.
 *
 * "Delete from here" exists because a conversation usually goes wrong at a
 * point rather than in one line, and taking it back to the fork is what people
 * actually want.
 */

/** Flags a line for the founder to read. Asks for an optional reason first. */
async function report(content: string) {
  const reason = window.prompt("Report this message. What is wrong with it? (optional)");
  if (reason === null) return;
  const res = await fetch("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, reason }),
  }).catch(() => null);
  window.alert(res?.ok ? "Thanks. We will take a look." : "Could not send the report. Sign in and try again.");
}

export function MessageActions({
  content,
  onReply,
  onEdit,
  onDelete,
  onDeleteFrom,
  onDone,
  onReact,
  reacted,
}: {
  content: string;
  onReply: () => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  onDeleteFrom: () => void;
  /** Called once an action is taken, so the thread can close the message. */
  onDone?: () => void;
  /** Reacting to the message with one emoji. Absent: no reactions here. */
  onReact?: (emoji: string) => void;
  /** The user's current reaction, to show it chosen. */
  reacted?: string;
}) {
  const done = () => onDone?.();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);

  if (editing) {
    return (
      <div className="msg-edit" onClick={(e) => e.stopPropagation()}>
        <textarea
          className="input"
          rows={3}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setEditing(false); setText(content); done(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              if (text.trim()) onEdit(text.trim());
              setEditing(false);
              done();
            }
          }}
        />
        <div className="row" style={{ gap: "0.5rem", marginTop: "0.4rem" }}>
          <button
            className="link-btn"
            onClick={() => { if (text.trim()) onEdit(text.trim()); setEditing(false); done(); }}
          >
            Save
          </button>
          <button className="link-btn" onClick={() => { setEditing(false); setText(content); done(); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <span className="msg-actions">
      {onReact && (
        <span className="react-row" role="group" aria-label="React">
          {REACTIONS.map((e) => (
            <button key={e} type="button" className="react-pick" aria-pressed={reacted === e} aria-label={`React ${e}`}
              onClick={() => { onReact(e); done(); }}>{e}</button>
          ))}
        </span>
      )}
      <button onClick={() => { onReply(); done(); }} aria-label="Reply to this message">reply</button>
      <button onClick={() => { setText(content); setEditing(true); }} aria-label="Edit message">edit</button>
      <button onClick={() => { onDelete(); done(); }} aria-label="Delete message">delete</button>
      <button onClick={() => { void report(content); done(); }} aria-label="Report this message">report</button>
      <button
        onClick={() => {
          if (confirm("Delete this message and everything after it?")) { onDeleteFrom(); done(); }
        }}
        aria-label="Delete this message and everything after it"
      >
        from here
      </button>
    </span>
  );
}
