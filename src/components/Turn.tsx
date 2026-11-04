"use client";

import { useRef, type ReactNode, type TouchEvent } from "react";

/* One message in a thread, and how you get at it.
 *
 * Every message used to carry "reply edit delete from here" underneath it. On
 * a phone, where there is no hover to hide them behind, that was four links
 * under every line and very nearly doubled the height of a conversation. Now:
 *
 *   - tap a message and its actions open; tap again, or another, and they move
 *   - swipe it right to reply, the way WhatsApp does
 *   - on a desktop they still appear on hover, as before
 *
 * The actions themselves are MessageActions, rendered as a child; the CSS
 * decides when they show (.turn.is-picked).
 */

const SWIPE_AT = 56;

export function Turn({
  id,
  mine,
  picked,
  onPick,
  onReply,
  children,
}: {
  id: string;
  mine: boolean;
  picked: boolean;
  onPick: (id: string | null) => void;
  onReply: () => void;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number; dx: number; locked: boolean } | null>(null);

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, dx: 0, locked: false };
  }

  function onTouchMove(e: TouchEvent<HTMLDivElement>) {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    /* A scroll that wanders sideways is still a scroll. Decide once. */
    if (!s.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { start.current = null; return; }
      if (dx > 10) s.locked = true;
      else return;
    }
    s.dx = Math.max(0, Math.min(dx, SWIPE_AT + 24));
    e.currentTarget.style.transform = `translateX(${s.dx}px)`;
    e.currentTarget.dataset.swiping = s.dx >= SWIPE_AT ? "ready" : "on";
  }

  function onTouchEnd(e: TouchEvent<HTMLDivElement>) {
    const s = start.current;
    start.current = null;
    const el = e.currentTarget;
    el.style.transform = "";
    delete el.dataset.swiping;
    if (s?.locked && s.dx >= SWIPE_AT) {
      navigator.vibrate?.(8);
      onReply();
    }
  }

  return (
    <div
      id={`msg-${id}`}
      className={`turn ${mine ? "turn-user" : "turn-muse"}${picked ? " is-picked" : ""}`}
      onClick={(e) => {
        /* A tap on a control inside the message is that control's. */
        if ((e.target as HTMLElement).closest("button, a, textarea, input")) return;
        if (window.getSelection()?.toString()) return;
        onPick(picked ? null : id);
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {children}
    </div>
  );
}
