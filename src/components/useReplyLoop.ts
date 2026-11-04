"use client";

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/* When a reply gets asked for, so that double-texting works -- and so that a
 * reply, once owed, always comes.
 *
 * Sending waits for a short pause first, and every message sent inside it is
 * answered together, as one turn. Typing holds it too: someone halfway through
 * their second message has not finished talking.
 *
 * A message sent while a reply is already being written is not lost and not
 * interrupted: the reply finishes, and then the loop goes round again for what
 * arrived during it. Only `restart` throws a reply away -- for an edit, where
 * what was being answered no longer exists.
 *
 * Replies used to belong to the chat screen, and die with it. Opening Edit,
 * the memories, a call, or just going back while someone was typing cancelled
 * the reply, and nothing ever asked again: the message sat unanswered until the
 * user edited it to force a new one. Now:
 *
 *   - a reply in progress is tracked per conversation, outside any screen, and
 *     carries on (and is saved) after the screen closes;
 *   - leaving during the pause before a reply sends it then, rather than never;
 *   - opening a conversation, or coming back to the app, answers anything still
 *     unanswered -- after a reload, after the phone killed the tab, after an
 *     error -- unless a reply for it is already on its way.
 */

/** How long after a send before asking for a reply. */
/* Long enough to start a second text, which then holds the reply while it is
   typed; any longer and every single message just waits. */
export const REPLY_PAUSE_MS = 1200;
/** How long a reply waits once someone starts typing again. */
export const TYPING_PAUSE_MS = 3500;
/** Opening a conversation that is owed a reply: a moment to settle, then answer. */
const RESUME_MS = 500;

/* Leaving the page -- another tab, another app on a phone -- makes the browser
   cut a request in flight. That is not "offline", and not an error: the reply
   is still owed, and gets asked for again when they are back. */
let lastHidden = 0;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") lastHidden = Date.now();
  });
}
/** Whether the page was in the background at any point since `since` (ms). */
export const backgroundedSince = (since: number): boolean =>
  typeof document !== "undefined" && (document.visibilityState === "hidden" || lastHidden >= since);

/* Replies in progress, by conversation. Module-level so a screen that closes
   and opens again sees the reply the previous one started. */
const flights = new Map<string, AbortController>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((f) => f());
}

function subscribe(key: string, f: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(f);
  return () => { set!.delete(f); };
}

export function useReplyLoop(
  /** The conversation: a Muse id, or a circle id. */
  key: string,
  run: (signal: AbortSignal) => Promise<void>,
  /** True when the conversation ends with something nobody has answered yet. */
  owed: () => boolean
) {
  const busy = useSyncExternalStore(
    (f) => subscribe(key, f),
    () => flights.has(key),
    () => false
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const again = useRef(false);
  const mounted = useRef(false);

  /* The latest `run` and `owed`, so a timer set several renders ago still
     reads the thread as it is now rather than as it was when it started. */
  const runRef = useRef(run);
  const owedRef = useRef(owed);
  useLayoutEffect(() => {
    runRef.current = run;
    owedRef.current = owed;
  });

  async function fire() {
    timer.current = null;
    if (flights.has(key)) {
      again.current = true;
      return;
    }
    const ctrl = new AbortController();
    const startedAt = Date.now();
    flights.set(key, ctrl);
    notify(key);
    try {
      await runRef.current(ctrl.signal);
    } finally {
      if (flights.get(key) === ctrl) flights.delete(key);
      notify(key);
      /* Cut off by the page going to the background and still unanswered: ask
         again, now if they are already back, or when they come back (above). */
      if (!ctrl.signal.aborted && mounted.current && backgroundedSince(startedAt) && owedRef.current()) {
        if (document.visibilityState === "visible") schedule(RESUME_MS);
      } else if (again.current) {
        again.current = false;
        if (mounted.current) schedule();
        else void fire();
      }
    }
  }

  function schedule(delay = REPLY_PAUSE_MS) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void fire(), delay);
  }

  useEffect(() => {
    mounted.current = true;
    /* Owed a reply and none on its way: answer it. */
    const resume = () => {
      if (!flights.has(key) && !timer.current && owedRef.current()) schedule(RESUME_MS);
    };
    resume();
    const onVisible = () => { if (document.visibilityState === "visible") resume(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      /* Leaving in the pause before a reply: they have finished talking, so
         ask now instead of dropping it. A reply already in flight carries on. */
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void fire();
      }
    };
    // Per conversation; the handlers read the latest callbacks through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /** Someone is typing: push back a reply that has not started yet. */
  function hold() {
    if (timer.current) schedule(TYPING_PAUSE_MS);
  }

  /** Drop whatever is being written and answer the thread as it is now. */
  function restart(delay = 250) {
    flights.get(key)?.abort();
    flights.delete(key);
    notify(key);
    again.current = false;
    schedule(delay);
  }

  return { busy, schedule, hold, restart };
}
