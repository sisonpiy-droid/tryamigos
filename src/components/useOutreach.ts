"use client";

import { useEffect, useRef, type RefObject } from "react";

import {
  ack, cancel, deviceId, inbox, offer, registerWorker, review, settingsOf, withOutreach, candidates,
} from "@/lib/proactive/client";
import type { SoloState } from "@/lib/solo/store";

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/* Everything outreach needs from the running app, in one place:
 *
 *   - collect what the server sent while the app was closed, into the thread
 *   - land on the right conversation from a notification
 *   - offer new dated or goal memories as possible reasons to text
 *   - call off what the conversation has already covered
 *   - record a reply to something the Muse texted first
 *
 * None of it sends anything: sending is the server's, on its own schedule.
 */
export function useOutreach(
  state: SoloState | null,
  latest: RefObject<SoloState | null>,
  update: Update,
  openChat: (museId: string) => void
): void {
  const ready = state !== null;
  const busy = useRef(false);
  const offering = useRef(false);

  /* -------------------------------------------- collecting, and landing */
  useEffect(() => {
    if (!ready || !deviceId()) return;
    registerWorker();

    const collect = async (open?: { museId: string; interactionId: string }) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const items = await inbox();
        for (const item of items) {
          update((cur) => withOutreach(cur, item));
          ack(item.id, open?.interactionId === item.id ? "opened" : "collected");
        }
        if (open) {
          if (!items.some((i) => i.id === open.interactionId)) ack(open.interactionId, "opened");
          openChat(open.museId);
        }
      } finally {
        busy.current = false;
      }
    };

    const fromUrl = (href: string) => {
      const u = new URL(href, window.location.origin);
      const museId = u.searchParams.get("muse");
      const interactionId = u.searchParams.get("outreach");
      return museId && interactionId ? { museId, interactionId } : undefined;
    };

    /* Opened from a notification: the URL says which conversation. Strip it
       straight away so a reload does not re-open it, keeping the history entry. */
    const landing = fromUrl(window.location.href);
    if (landing) window.history.replaceState(window.history.state, "", "/solo");
    void collect(landing);

    const onVisible = () => { if (document.visibilityState === "visible") void collect(); };
    const onWorker = (e: MessageEvent) => {
      if (e.data?.type === "muse-open" && typeof e.data.url === "string") void collect(fromUrl(e.data.url));
    };
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener("message", onWorker);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener("message", onWorker);
    };
    // Once per app load; the handlers read the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /* ------------------------------------- offering new memories, reviewing */
  const s = state;
  const memorySig = s ? `${s.memories.length}:${s.memories.at(-1)?.id ?? ""}` : "";
  const threadSig = s ? Object.values(s.conversations).reduce((n, t) => n + t.length, 0) : 0;
  const enabled = s ? settingsOf(s).proactiveEnabled : false;

  useEffect(() => {
    if (!ready || !enabled || !deviceId()) return;
    const timer = setTimeout(async () => {
      const cur = latest.current;
      if (!cur || offering.current) return;
      const settings = settingsOf(cur);
      const muses = settings.allowedMuseIds.filter((id) => candidates(cur, id).length);
      if (!muses.length) return;
      offering.current = true;
      try {
        for (const museId of muses) {
          const got = await offer(latest.current ?? cur, museId);
          if (!got) continue;
          update((c) => ({
            ...c,
            outreach: {
              ...(c.outreach ?? {}),
              evaluated: { ...(c.outreach?.evaluated ?? {}), ...Object.fromEntries(got.evaluated.map((id) => [id, true as const])) },
              triggers: [
                ...(c.outreach?.triggers ?? []).filter((t) => !got.created.some((n) => n.id === t.id)),
                ...got.created,
              ].slice(-100),
            },
          }));
        }
      } finally {
        offering.current = false;
      }
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, enabled, memorySig]);

  useEffect(() => {
    const cur = latest.current;
    if (!ready || !cur) return;
    const r = review(cur);
    if (r.state === cur) return;
    update((c) => review(c).state);
    if (r.cancelDiscussed.length) void cancel(r.cancelDiscussed, "already discussed");
    if (r.cancelGone.length) void cancel(r.cancelGone, "memory gone or replaced");
    for (const id of r.responded) ack(id, "responded");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, threadSig, memorySig]);
}
