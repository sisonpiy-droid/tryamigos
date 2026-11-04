"use client";

import { QUOTE_CHARS } from "@/lib/solo/store";

/* Replying to one message, WhatsApp-style.
 *
 * Two halves of the same thing: the bar above the composer while you are
 * writing the reply, and the quote at the top of the message once it is sent.
 * Tapping a sent quote jumps to what it answers, which matters most in a
 * circle, where the line being answered may be twenty messages up.
 */

const snippet = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat;
};

export function QuoteBubble({ who, text, onJump }: { who: string; text?: string; onJump?: () => void }) {
  if (text === undefined) {
    return <span className="quote quote-gone">Replying to a message that was deleted</span>;
  }
  return (
    <button type="button" className="quote" onClick={onJump} aria-label={`Replying to ${who}: ${snippet(text)}`}>
      <b>{who}</b>
      <span>{snippet(text)}</span>
    </button>
  );
}

export function ReplyBar({ who, text, onCancel }: { who: string; text: string; onCancel: () => void }) {
  return (
    <div className="reply-bar" role="status">
      <div className="quote quote-static">
        <b>Replying to {who}</b>
        <span>{snippet(text)}</span>
      </div>
      <button type="button" className="link-btn" onClick={onCancel} aria-label="Cancel reply">
        ✕
      </button>
    </div>
  );
}

/** Scrolls a message into view and flashes it, so the jump is visible. */
export function jumpTo(messageId: string) {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}
