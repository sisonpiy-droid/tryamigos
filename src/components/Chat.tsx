"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Avatar } from "./Avatar";
import { ExportMenu } from "./ExportMenu";

/* §8 — the most important screen in the product.
 *
 * Closer to a premium messaging app than an AI assistant: no model names, no
 * token counts, no prompt internals (§8 forbids all three). Streaming rather
 * than a spinner (§45).
 */

export interface ChatMessage {
  id: string;
  senderType: "USER" | "MUSE";
  content: string;
  createdAt: string;
}

export interface ChatMuse {
  id: string;
  name: string;
  relationshipType: string;
  description: string;
}

export function Chat({
  conversationId,
  muse,
  initialMessages,
}: {
  conversationId: string;
  muse: ChatMuse;
  initialMessages: ChatMessage[];
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(null);

  const foot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    foot.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  function grow() {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;

    setBusy(true);
    setError(null);
    setDraft("");
    setLastSent(content);
    if (box.current) box.current.style.height = "auto";

    // Shown immediately; the server has the real row. If the request fails the
    // words are still on screen and still in the database.
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      senderType: "USER",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);

    let acc = "";
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.error ?? "Something went wrong. Try again.", retryable: true });
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt: { type?: string; text?: string; message?: string; retryable?: boolean; messageId?: string };
          try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

          if (evt.type === "delta" && evt.text) {
            acc += evt.text;
            setStreaming(acc);
          } else if (evt.type === "error") {
            setError({ message: evt.message ?? "Something went wrong.", retryable: evt.retryable ?? true });
          } else if (evt.type === "done" && evt.messageId) {
            /* Read acc into a value BEFORE clearing it. setMessages takes an
               updater that React invokes later, and a closure over `acc` would
               see the reset -- which appended an empty message while the text
               had streamed correctly on screen a moment earlier. */
            const finalText = acc.trim();
            const doneId = evt.messageId;
            setMessages((m) => [
              ...m,
              { id: doneId, senderType: "MUSE", content: finalText, createdAt: new Date().toISOString() },
            ]);
            acc = "";
            setStreaming("");
          }
        }
      }

      // The stream ended without a done frame — keep whatever arrived.
      const trailing = acc.trim();
      if (trailing) {
        setMessages((m) => [
          ...m,
          { id: `partial-${Date.now()}`, senderType: "MUSE", content: trailing, createdAt: new Date().toISOString() },
        ]);
      }
    } catch {
      setError({ message: "You're offline.", retryable: true });
    } finally {
      setStreaming("");
      setBusy(false);
    }
  }

  return (
    <>
      <header className="chat-head">
        <Link href="/" className="link-btn" aria-label="Back to home" style={{ textDecoration: "none" }}>←</Link>
        <Avatar name={muse.name} />
        <div style={{ minWidth: 0 }}>
          <h1>{muse.name}</h1>
          <div className="rel">{muse.relationshipType}</div>
        </div>
        <ExportMenu conversationId={conversationId} museId={muse.id} museName={muse.name} />
      </header>

      <div className="thread" role="log" aria-live="polite" aria-label={`Conversation with ${muse.name}`}>
        {messages.length === 0 && !streaming && (
          <div className="empty" style={{ marginTop: "2rem" }}>
            <p style={{ fontFamily: "var(--serif)", fontSize: "1.1rem" }}>{muse.description}</p>
            <p className="fine">Say anything. {muse.name} will remember it next time.</p>
          </div>
        )}

        {messages.map((m) =>
          m.senderType === "USER" ? (
            <div key={m.id} className="turn turn-user">{m.content}</div>
          ) : (
            <div key={m.id} className="turn turn-muse">{m.content}</div>
          )
        )}

        {streaming && <div className="turn turn-muse">{streaming}</div>}

        {busy && !streaming && (
          <p className="typing">{muse.name} is typing<i>.</i><i>.</i><i>.</i></p>
        )}

        {error && (
          <div style={{ marginTop: "1rem" }}>
            <p className="error" role="alert">{error.message}</p>
            {error.retryable && lastSent && (
              <button className="link-btn" onClick={() => send(lastSent)}>Try again</button>
            )}
          </div>
        )}

        <div ref={foot} />
      </div>

      <div className="composer">
        <label className="sr-only" htmlFor="composer">Write to {muse.name}</label>
        <textarea
          id="composer"
          ref={box}
          rows={1}
          value={draft}
          placeholder={`Write to ${muse.name}`}
          onChange={(e) => { setDraft(e.target.value); grow(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <button className="send" onClick={() => send(draft)} disabled={busy || !draft.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
