"use client";

import {
  DEFAULT_OUTREACH, feelingsOf, newMessage, promptPersona, findMuse,
  type OutreachSettings, type OutreachTrigger, type SoloMemory, type SoloMessage, type SoloState,
} from "@/lib/solo/store";
import { bondOf, lifeForTurn } from "@/lib/solo/life";
import { hasFeelings } from "@/lib/presence/persona";

/* The app's half of outreach.
 *
 * The server keeps the finished messages and sends them; this side decides
 * which memories to offer, keeps the server's copy of the settings current,
 * subscribes the browser to push, and -- the part only it can do -- puts a sent
 * message into the conversation, and calls a pending one off when the user
 * brings the subject up first. Nothing here runs a timer for sending: the
 * schedule lives on the server, so it holds with the browser closed.
 */

const DEVICE_KEY = "muse.device/1";

/* The device id lives outside the main store on purpose: a backup restored on
   another phone must not make both phones the same device. */
export function deviceId(create = false): string | null {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id && create) {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const settingsOf = (s: SoloState): OutreachSettings => ({ ...DEFAULT_OUTREACH, ...(s.outreach?.settings ?? {}) });

/* -------------------------------------------------------------------- push */

export type PushSupport = "ok" | "needs-install" | "unsupported";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return ios && !standalone ? "needs-install" : "unsupported";
  }
  return "ok";
}

export const notificationsAllowed = () =>
  typeof Notification !== "undefined" && Notification.permission === "granted";

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* Asks for notifications and subscribes. Must start from a tap. Resolves with
   the subscription, or why there is none. */
export async function subscribePush(): Promise<{ sub: PushSubscriptionJSON } | { error: "denied" | "unsupported" | "unconfigured" | "failed" }> {
  if (pushSupport() !== "ok") return { error: "unsupported" };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { error: "denied" };
  try {
    const { publicKey } = await (await fetch("/api/proactive/device")).json();
    if (!publicKey) return { error: "unconfigured" };
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    return { sub: sub.toJSON() };
  } catch (err) {
    console.error("push subscribe failed", err);
    return { error: "failed" };
  }
}

/** Keeps the service worker registered, so a tap on a notification still lands. */
export function registerWorker(): void {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }
}

/* ---------------------------------------------------------------- server */

export async function saveDevice(
  settings: OutreachSettings,
  push?: PushSubscriptionJSON | null
): Promise<{ ok: true; pushing: boolean } | { ok: false }> {
  const id = deviceId(true);
  if (!id) return { ok: false };
  try {
    const res = await fetch("/api/proactive/device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        timezone: timezone(),
        ...settings,
        ...(push === undefined ? {} : { push: push && push.endpoint && push.keys ? { endpoint: push.endpoint, keys: push.keys } : null }),
      }),
    });
    if (!res.ok) return { ok: false };
    const { device } = await res.json();
    return { ok: true, pushing: Boolean(device?.pushing) };
  } catch {
    return { ok: false };
  }
}

/* Which memories could be a reason to text: something dated and near, or a
   goal mentioned recently. Everything else never leaves the device. */
const DAY = 24 * 3600_000;
export function candidates(s: SoloState, museId: string, now = Date.now()): SoloMemory[] {
  const seen = s.outreach?.evaluated ?? {};
  return s.memories
    .filter((m) => m.museId === museId && !seen[m.id])
    /* What she said she would do herself is tracked in the chat, not a reason to text. */
    .filter((m) => !/^The character\b/i.test(m.content))
    .filter((m) => {
      if (m.at) {
        const t = Date.parse(m.at);
        return Number.isFinite(t) && t > now - DAY && t < now + 90 * DAY;
      }
      /* Something she said she would tell them, while it is still owed. */
      if (m.type === "PROMISE") return !m.circleId && now - Date.parse(m.createdAt) < 2 * DAY;
      /* A goal, or an event whose date is only in the words, said recently. */
      return (m.type === "GOAL" || m.type === "EVENT") && now - Date.parse(m.createdAt) < 10 * DAY;
    })
    .slice(-10);
}

export async function offer(s: SoloState, museId: string): Promise<{ created: OutreachTrigger[]; evaluated: string[] } | null> {
  const id = deviceId();
  const muse = findMuse(s, museId);
  const persona = muse ? promptPersona(muse, s.userName) : null;
  if (!id || !muse || !persona) return null;
  const list = candidates(s, museId);
  const thread = s.conversations[museId] ?? [];
  try {
    const res = await fetch("/api/proactive/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: id,
        muse: { id: museId, name: muse.name.slice(0, 60) },
        persona,
        /* The same standing mood and closeness the chat sends, so a text she
           starts is the person from the thread. */
        feelings: hasFeelings(feelingsOf(s, museId)) ? feelingsOf(s, museId) : null,
        bond: bondOf(s, museId)?.level ?? null,
        userName: s.userName,
        candidates: list.map((m) => ({ id: m.id, content: m.content.slice(0, 420), type: m.type, at: m.at ?? null, createdAt: m.createdAt })),
        keep: s.memories.filter((m) => m.museId === museId).map((m) => m.id).slice(-400),
        recent: thread.slice(-6).map((m) => ({ role: m.from === "user" ? "user" : "assistant", content: m.content.slice(0, 2000), at: m.at })),
        /* Her storylines, so a story she promised is told in keeping with them. */
        life: lifeForTurn(s, museId).map((a) => `${a.title}: ${a.beats.join(" Then: ")}`.slice(0, 400)),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const now = new Date().toISOString();
    return {
      evaluated: data.evaluated ?? [],
      created: (data.created ?? []).map((t: Omit<OutreachTrigger, "museId" | "createdAt" | "status">) => ({
        ...t, museId, createdAt: now, status: "PENDING" as const,
      })),
    };
  } catch {
    return null;
  }
}

export async function cancel(triggerIds: string[], reason: string): Promise<void> {
  const id = deviceId();
  if (!id || !triggerIds.length) return;
  await fetch("/api/proactive/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: id, triggerIds, reason }),
  }).catch(() => {});
}

export interface InboxItem {
  id: string;
  triggerId: string;
  museId: string;
  museName: string;
  message: string;
  sentAt: string;
}

export async function inbox(): Promise<InboxItem[]> {
  const id = deviceId();
  if (!id) return [];
  try {
    const res = await fetch(`/api/proactive/inbox?device=${encodeURIComponent(id)}`, { cache: "no-store" });
    return res.ok ? (await res.json()).items ?? [] : [];
  } catch {
    return [];
  }
}

export function ack(interactionId: string, event: "collected" | "opened" | "responded" | "dismissed"): void {
  const id = deviceId();
  if (!id) return;
  void fetch("/api/proactive/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: id, interactionId, event }),
    keepalive: true,
  }).catch(() => {});
}

/* ----------------------------------------------------------- the thread */

/* A sent outreach, as messages from that Muse at the end of their ordinary
   thread. A burst ("---") becomes separate texts, the way a reply would. Ids
   come from the interaction, so collecting twice cannot add it twice. */
export function withOutreach(s: SoloState, item: InboxItem): SoloState {
  const thread = s.conversations[item.museId] ?? [];
  if (thread.some((m) => m.proactive?.interactionId === item.id)) return s;
  const parts = item.message.split(/\n?\s*-{3,}\s*\n?/).map((p) => p.trim()).filter(Boolean);
  const at = new Date(item.sentAt);
  const msgs: SoloMessage[] = parts.map((content, i) => ({
    ...newMessage("muse", content),
    id: `p-${item.id}-${i}`,
    at: new Date(at.getTime() + i * 1000).toISOString(),
    proactive: { interactionId: item.id },
  }));
  const triggers = (s.outreach?.triggers ?? []).map((t) => (t.id === item.triggerId ? { ...t, status: "SENT" as const } : t));
  return {
    ...s,
    conversations: { ...s.conversations, [item.museId]: [...thread, ...msgs] },
    outreach: { ...(s.outreach ?? {}), triggers },
  };
}

/* What the conversation itself says about pending outreach:
   - the user already raised the subject, so texting about it would be odd;
   - its memory is gone (deleted, or replaced by how it turned out);
   - they replied to something the Muse texted first.
   Returns what to tell the server, and the state with all of it recorded. */
export function review(s: SoloState): { state: SoloState; cancelDiscussed: string[]; cancelGone: string[]; responded: string[] } {
  const triggers = s.outreach?.triggers ?? [];
  const memoryIds = new Set(s.memories.map((m) => m.id));
  const cancelDiscussed: string[] = [];
  const cancelGone: string[] = [];
  const next = triggers.map((t) => {
    if (t.status !== "PENDING") return t;
    if (!memoryIds.has(t.sourceMemoryId)) { cancelGone.push(t.id); return { ...t, status: "CANCELLED" as const }; }
    const since = Date.parse(t.createdAt);
    const said = (s.conversations[t.museId] ?? [])
      .filter((m) => m.from === "user" && Date.parse(m.at) > since)
      .map((m) => m.content.toLowerCase());
    if (t.keywords.length && said.some((line) => t.keywords.some((k) => line.includes(k)))) {
      cancelDiscussed.push(t.id);
      return { ...t, status: "CANCELLED" as const };
    }
    return t;
  });

  const responded: string[] = [];
  const conversations = { ...s.conversations };
  for (const [museId, thread] of Object.entries(s.conversations)) {
    let changed = false;
    const updated = thread.map((m, i) => {
      if (!m.proactive || m.proactive.responded) return m;
      if (!thread.slice(i + 1).some((x) => x.from === "user")) return m;
      if (!responded.includes(m.proactive.interactionId)) responded.push(m.proactive.interactionId);
      changed = true;
      return { ...m, proactive: { ...m.proactive, responded: true } };
    });
    if (changed) conversations[museId] = updated;
  }

  const touched = cancelDiscussed.length || cancelGone.length || responded.length;
  return {
    state: touched ? { ...s, conversations, outreach: { ...(s.outreach ?? {}), triggers: next } } : s,
    cancelDiscussed,
    cancelGone,
    responded,
  };
}
