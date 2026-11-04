"use client";

import { useEffect, useRef } from "react";

/* Keeping the newest message in view, without fighting the reader.
 *
 * This used to be one effect: smooth-scroll to the bottom whenever a message
 * arrived *or the reply being typed grew*. A reply streams in a few words at a
 * time, so every few words started a fresh smooth-scroll animation on top of
 * the last one -- on a slow phone with a long thread, a visible judder for the
 * whole of every reply. It also dragged anyone who had scrolled up to read
 * something back to the bottom, mid-sentence, every time.
 *
 * It also scrolled the end of the thread to the bottom of the screen, which is
 * exactly where the composer sits, pinned: the last line of every conversation
 * was under it. The bottom of the page is the right place, with the composer
 * in its own space below the thread.
 *
 * Now:
 *   - opening a conversation jumps straight to the end (no animation across a
 *     thousand messages);
 *   - a new message scrolls smoothly, if you were at the bottom or sent it;
 *   - text growing in the bubble being typed follows instantly, and only while
 *     you are at the bottom;
 *   - scrolled up to read, you are left alone until you send something.
 */

const NEAR_PX = 160;

function toEnd(smooth: boolean) {
  const el = document.scrollingElement ?? document.documentElement;
  /* A long way down is a jump either way; animating it is just a slow jump. */
  const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 1.5;
  window.scrollTo({ top: el.scrollHeight, behavior: smooth && !far ? "smooth" : "auto" });
}

export function useFollow(
  /** Changes when a message is added: the count of messages shown, say. */
  count: number,
  /** Changes as the reply being typed grows. */
  growing: unknown,
  /** The newest message is the user's own: always scroll to it. */
  mine: boolean
) {
  const stuck = useRef(true);
  const first = useRef(true);
  /* Our own smooth scroll passes through positions far from the bottom; those
     are not the reader scrolling away. */
  const quietUntil = useRef(0);
  const mineRef = useRef(mine);
  useEffect(() => { mineRef.current = mine; });

  useEffect(() => {
    const onScroll = () => {
      if (Date.now() < quietUntil.current) return;
      const el = document.scrollingElement ?? document.documentElement;
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_PX;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      toEnd(false);
      return;
    }
    if (!stuck.current && !mineRef.current) return;
    stuck.current = true;
    quietUntil.current = Date.now() + 700;
    toEnd(true);
  }, [count]);

  useEffect(() => {
    if (!growing || !stuck.current) return;
    quietUntil.current = Date.now() + 100;
    toEnd(false);
  }, [growing]);
}
