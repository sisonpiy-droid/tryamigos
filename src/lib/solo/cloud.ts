"use client";

import { parseState, type SoloState } from "./store";
import { mergeStates } from "./sync";

/* Signed in, the /solo state is also kept on the server so another phone or
 * computer can pick it up.
 *
 * It is the same three-way merge the tabs of one browser already use, with the
 * server standing in for "the other tab": against the last state this device
 * synced (the base), our changes and theirs are folded together, and the result
 * is written back only if the server has not moved since (a revision check, 409
 * otherwise, then go round again).
 *
 * Not synced: photos, voice notes and videos, which stay on the device that
 * made them (a message that points at one shows a placeholder elsewhere), and
 * memory embeddings, which are rebuilt on the other side.
 */

/** JSON with sorted keys, so two devices holding the same thing compare equal. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x
  );
}

/** What is sent: the state without its local revision or memory embeddings. */
export function wire(s: SoloState): string {
  return canon({ ...s, rev: undefined, corrupt: undefined, memories: s.memories.map((m) => ({ ...m, embedding: undefined })) });
}

export type Head = { status: "ok"; rev: number; email: string } | { status: "signed-out" } | { status: "offline" };
export type Pushed = { ok: true; rev: number } | { ok: false; reason: "conflict" | "too-big" | "offline" | "signed-out" };

export interface CloudIo {
  /** Who is signed in and the server's revision (cheap). */
  head(): Promise<Head>;
  /** The whole stored copy; null when it could not be fetched. */
  pull(): Promise<{ rev: number; data: string | null } | null>;
  push(data: string, baseRev: number): Promise<Pushed>;
  /** The last state this device synced, and the revision it was at. */
  loadBase(): Promise<{ json: string; rev: number } | null>;
  saveBase(json: string, rev: number): Promise<void>;
}

export type Synced =
  | { status: "ok"; merged: SoloState; email: string; changed: boolean }
  | { status: "signed-out" | "offline" | "too-big" };

/* One round: fold the server's copy and ours together, and write the result
   back if it differs from what the server holds. `current` is what is on screen. */
export async function syncOnce(current: SoloState, io: CloudIo): Promise<Synced> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await io.head();
    if (head.status !== "ok") return { status: head.status };
    const saved = await io.loadBase();
    const here = wire(current);

    let merged = current;
    let serverJson: string | null = saved?.json ?? null;
    let adopted = false;
    if (!saved || saved.rev !== head.rev) {
      const full = await io.pull();
      if (!full) return { status: "offline" };
      serverJson = full.data;
      const theirs = full.data ? parseState(full.data) : null;
      if (theirs && !theirs.corrupt) {
        /* Nothing of ours to add: unchanged since the last sync, or a device that
           has never held anything. */
        const unchanged = saved !== null ? here === saved.json : blank(current);
        /* Nothing of ours to add: take theirs exactly, so two idle devices never
           rewrite each other's copy just because they ordered something differently. */
        adopted = unchanged;
        merged = unchanged ? theirs : mergeStates(saved ? parseState(saved.json) : parseState(null), theirs, current);
      }
    }

    const out = wire(merged);
    if (adopted || (serverJson !== null && out === canonOf(serverJson))) {
      await io.saveBase(out, head.rev);
      return { status: "ok", merged, email: head.email, changed: merged !== current };
    }
    const res = await io.push(out, head.rev);
    if (res.ok) {
      await io.saveBase(out, res.rev);
      return { status: "ok", merged, email: head.email, changed: merged !== current };
    }
    if (res.reason === "conflict") continue;
    return { status: res.reason };
  }
  return { status: "offline" };
}

/** A device that has never held a person, a conversation or a memory. */
const blank = (s: SoloState) => !s.muses.length && !Object.keys(s.conversations).length && !s.memories.length;

/* What the server holds, in the form `wire` makes, so the two can be compared. */
function canonOf(json: string): string {
  try { return canon(JSON.parse(json)); } catch { return json; }
}

/* ------------------------------------------------------------ the real thing */

const INFO = "muse-cloud";

/** Remembered on this device so the app knows to sync without asking the server first. */
export function signedInEmail(): string | null {
  try { return localStorage.getItem(INFO); } catch { return null; }
}
export function rememberSignIn(email: string | null) {
  try {
    if (email) localStorage.setItem(INFO, email);
    else localStorage.removeItem(INFO);
  } catch { /* the app finds out from the server instead */ }
}

/* The base lives next to the app's own state, in the same IndexedDB. */
function withState<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open("muse");
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("state")) { db.close(); resolve(undefined); return; }
        const tx = db.transaction("state", mode);
        const req = f(tx.objectStore("state"));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); resolve(undefined); };
      };
    } catch { resolve(undefined); }
  });
}

export const browserIo: CloudIo = {
  async head() {
    try {
      const res = await fetch("/api/solo/sync?peek=1", { cache: "no-store" });
      if (res.status === 401) return { status: "signed-out" };
      if (!res.ok) return { status: "offline" };
      const d = await res.json();
      return { status: "ok", rev: d.rev ?? 0, email: d.email ?? "" };
    } catch { return { status: "offline" }; }
  },
  async pull() {
    try {
      const res = await fetch("/api/solo/sync", { cache: "no-store" });
      if (!res.ok) return null;
      const d = await res.json();
      return { rev: d.rev ?? 0, data: d.data ?? null };
    } catch { return null; }
  },
  async push(data, baseRev) {
    try {
      const res = await fetch("/api/solo/sync", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, baseRev }),
      });
      if (res.ok) return { ok: true, rev: (await res.json()).rev };
      if (res.status === 409) return { ok: false, reason: "conflict" };
      if (res.status === 413) return { ok: false, reason: "too-big" };
      if (res.status === 401) return { ok: false, reason: "signed-out" };
      return { ok: false, reason: "offline" };
    } catch { return { ok: false, reason: "offline" }; }
  },
  async loadBase() {
    const raw = await withState<string>("readonly", (s) => s.get("cloud-base") as IDBRequest<string>);
    if (!raw) return null;
    try { const v = JSON.parse(raw); return typeof v.json === "string" ? { json: v.json, rev: v.rev ?? 0 } : null; } catch { return null; }
  },
  async saveBase(json, rev) {
    await withState("readwrite", (s) => s.put(JSON.stringify({ json, rev }), "cloud-base"));
  },
};

/** Forget what was synced here (on sign out), so a different account starts clean. */
export async function forgetBase() {
  await withState("readwrite", (s) => s.delete("cloud-base"));
}
