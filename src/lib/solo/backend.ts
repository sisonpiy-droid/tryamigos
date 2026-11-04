"use client";

import { KEY } from "./store";

/* Where the browser keeps everything.
 *
 * It was one localStorage key, and localStorage stops at about 5MB per site.
 * Conversations and memories only grow -- and the vectors that let recall work
 * on meaning are most of the bytes -- so a few months of talking to several
 * people ran into the ceiling, and the only remedy was deleting a conversation.
 *
 * IndexedDB is the same browser, the same device, nothing sent anywhere, with
 * room for hundreds of megabytes; and it has transactions, so "write this only
 * if nobody else has written since" is a single atomic step rather than a read
 * followed by a hopeful write. Photos live here too, as files, never inside
 * the state.
 *
 * localStorage stays as the fallback for browsers where IndexedDB will not
 * open (some private modes), with the same rules.
 */

export type WriteOutcome = "ok" | "conflict";

export interface Backend {
  readonly name: "idb" | "local";
  read(): Promise<{ raw: string | null; rev: number }>;
  revision(): Promise<number | null>;
  /** Writes `raw` as revision `rev`, only if what is stored is still `expected`. Throws on quota. */
  write(raw: string, rev: number, expected: number): Promise<WriteOutcome>;
}

const revOf = (raw: string | null) => (raw === null ? null : Number(/^\{"rev":(\d+)/.exec(raw)?.[1] ?? 0));

/* ---------------------------------------------------------- localStorage */

export const localBackend: Backend = {
  name: "local",
  async read() {
    const raw = localStorage.getItem(KEY);
    return { raw, rev: revOf(raw) ?? 0 };
  },
  async revision() {
    try { return revOf(localStorage.getItem(KEY)); } catch { return null; }
  },
  async write(raw, _rev, expected) {
    const current = revOf(localStorage.getItem(KEY)) ?? 0;
    if (current !== expected) return "conflict";
    localStorage.setItem(KEY, raw);
    return "ok";
  },
};

/* ------------------------------------------------------------- IndexedDB */

const DB = "muse";
const VERSION = 1;
let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("no indexedDB")); return; }
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images");
    };
    req.onsuccess = () => {
      const db = req.result;
      /* Another tab upgrading the schema: step aside rather than block it. */
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
  opening.catch(() => { opening = null; });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

function get<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

export const idbBackend: Backend = {
  name: "idb",
  async read() {
    const db = await openDb();
    const tx = db.transaction("state", "readonly");
    const store = tx.objectStore("state");
    const [raw, rev] = await Promise.all([get<string>(store, "raw"), get<number>(store, "rev")]);
    return { raw: raw ?? null, rev: rev ?? 0 };
  },
  async revision() {
    try {
      const db = await openDb();
      const tx = db.transaction("state", "readonly");
      const rev = await get<number>(tx.objectStore("state"), "rev");
      return rev ?? null;
    } catch {
      return null;
    }
  },
  async write(raw, rev, expected) {
    const db = await openDb();
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const current = (await get<number>(store, "rev")) ?? 0;
    if (current !== expected) {
      tx.abort();
      await done(tx).catch(() => {});
      return "conflict";
    }
    store.put(raw, "raw");
    store.put(rev, "rev");
    await done(tx);
    return "ok";
  },
};

/* --------------------------------------------------------------- choosing */

/* IndexedDB if it opens, after moving anything still in localStorage into it.
 *
 * The move is careful: written, read back and compared, and only then is the
 * old copy removed. If anything about that fails, the data stays where it was
 * and this session runs on localStorage as before. */
/* Decided once per page. Two copies opening at the same moment -- React opens
   twice in development, and two tabs can start together -- each racing to move
   the data, and the loser falling back to the now-empty old place, showed an
   empty app over data that was safely in IndexedDB. One decision, shared. */
let chosen: Promise<Backend> | null = null;
/** How two stored copies become one, without losing what either holds. Given by sync.ts. */
type Combine = (a: string, b: string, rev: number) => string;
let combine: Combine = (_a, b) => b;
export function chooseBackend(merge?: Combine): Promise<Backend> {
  if (merge) combine = merge;
  return (chosen ??= decide());
}

async function decide(): Promise<Backend> {
  try {
    await openDb();
  } catch {
    return localBackend;
  }
  try {
    const here = await idbBackend.read();
    let old: string | null = null;
    try { old = localStorage.getItem(KEY); } catch { /* unreadable: nothing to move */ }
    if (old !== null) {
      const oldRev = revOf(old) ?? 0;
      /* Nothing here yet: move it. Something here already and a newer copy in
         the old place (a tab still running the previous version wrote there):
         never replace one with the other -- combine them, keeping everything
         either has. A stale or empty leftover adds nothing to the combination. */
      if (here.raw === null || oldRev > here.rev) {
        const raw = here.raw === null ? old : combine(old, here.raw, Math.max(oldRev, here.rev) + 1);
        const outcome = await idbBackend.write(raw, here.raw === null ? oldRev : Math.max(oldRev, here.rev) + 1, here.rev);
        const check = await idbBackend.read();
        /* A conflict here means another copy got there first -- the data is
           in IndexedDB, which is where this one should be too. */
        if (outcome === "conflict") {
          if (check.raw === null) return localBackend;
        } else if (check.raw !== raw) {
          return localBackend;
        }
      }
      localStorage.removeItem(KEY);
      localStorage.setItem(`${KEY}:moved`, new Date().toISOString());
    }
    /* Ask the browser not to clear this under storage pressure. A companion's
       memory is not a cache. Granted silently on most browsers; harmless if not. */
    void navigator.storage?.persist?.().catch(() => false);
    return idbBackend;
  } catch (err) {
    console.error("moving storage failed; staying on localStorage", err);
    return localBackend;
  }
}

/** How full this site's storage is, 0..1, where the browser will say. */
export async function storageUse(): Promise<number | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota || e.usage === undefined) return null;
    return e.usage / e.quota;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- photos */

export async function putImage(id: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb();
    const tx = db.transaction("images", "readwrite");
    tx.objectStore("images").put(blob, id);
    await done(tx);
    return true;
  } catch {
    return false;
  }
}

export async function getImage(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    const tx = db.transaction("images", "readonly");
    return (await get<Blob>(tx.objectStore("images"), id)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const db = await openDb();
    const tx = db.transaction("images", "readwrite");
    for (const id of ids) tx.objectStore("images").delete(id);
    await done(tx);
  } catch { /* an orphaned photo costs space, not correctness */ }
}

export async function canStoreImages(): Promise<boolean> {
  try { await openDb(); return true; } catch { return false; }
}
