"use client";

import { KEY, STORAGE_BUDGET, parseState, serialiseState, type SaveResult, type SoloState } from "./store";
import { mergeSet } from "./chatlist";
import { chooseBackend, localBackend, storageUse, type Backend } from "./backend";

/* Keeping one browser's copy of everything consistent when more than one copy
 * of the app is running.
 *
 * Everything lives in one localStorage key and every save wrote the whole of
 * it. That is fine for one tab and quietly destructive for two: a second tab,
 * an installed home-screen copy next to a browser tab, or a phone tab that sat
 * in the background for a day all hold the state as it was when they last
 * loaded. The moment one of them saved anything -- a memory landing from an
 * earlier turn, a vibe chip, a reply -- it wrote that old copy over the new
 * one, and the next open showed the conversation as it was twenty or thirty
 * messages ago. Nothing looked wrong until then, because each tab's screen
 * showed its own state.
 *
 * Now every write carries a revision. A save that finds a newer revision on
 * disk than the one it started from does a three-way merge -- against the last
 * state this tab read or wrote -- instead of overwriting, and a tab that hears
 * another one write (or comes back to the foreground) folds those changes in.
 * The app also saves on the way into the background, which is the last moment
 * a phone guarantees any code runs at all.
 */

type Keyed = { id: string };

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One side's value, given the common ancestor. Undefined means absent. */
function pick<T>(base: T | undefined, theirs: T | undefined, ours: T | undefined): T | undefined {
  if (base === undefined) return ours ?? theirs; // added on one side (or both)
  if (theirs === undefined || ours === undefined) {
    /* Deleted on one side. The deletion stands unless the other side changed
       the thing after it was deleted, which is the rarer and more deliberate act. */
    const kept = theirs ?? ours;
    return kept === undefined || same(kept, base) ? undefined : kept;
  }
  return same(ours, base) ? theirs : ours;
}

/* A list of things with ids, in order. Ours sets the order; anything only the
   other side has goes in after whatever came before it over there, so a reply
   lands next to the message it answered. */
export function mergeList<T extends Keyed>(base: T[] = [], theirs: T[] = [], ours: T[] = []): T[] {
  const B = new Map(base.map((x) => [x.id, x]));
  const Th = new Map(theirs.map((x) => [x.id, x]));
  const O = new Map(ours.map((x) => [x.id, x]));
  const out: T[] = [];
  const placed = new Set<string>();

  for (const o of ours) {
    const v = pick(B.get(o.id), Th.get(o.id), o);
    if (v) { out.push(v); placed.add(o.id); }
  }
  theirs.forEach((t, i) => {
    if (placed.has(t.id)) return;
    const v = pick(B.get(t.id), t, O.get(t.id));
    if (!v) return;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) at = out.findIndex((x) => x.id === theirs[j].id);
    out.splice(at + 1, 0, v);
    placed.add(t.id);
  });
  return out;
}

function mergeRecord<V>(
  base: Record<string, V> = {},
  theirs: Record<string, V> = {},
  ours: Record<string, V> = {},
  both?: (b: V | undefined, t: V, o: V) => V
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
    const b = base[k], t = theirs[k], o = ours[k];
    if (both && t !== undefined && o !== undefined) { out[k] = both(b, t, o); continue; }
    const v = pick(b, t, o);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Both sides' changes since `base`, applied together. */
export function mergeStates(base: SoloState, theirs: SoloState, ours: SoloState): SoloState {
  return {
    ...ours,
    userName: same(ours.userName, base.userName) ? theirs.userName : ours.userName,
    place: same(ours.place, base.place) ? theirs.place : ours.place,
    pinned: mergeSet(base.pinned, theirs.pinned, ours.pinned),
    archived: mergeSet(base.archived, theirs.archived, ours.archived),
    muses: mergeList(base.muses, theirs.muses, ours.muses),
    memories: mergeList(base.memories, theirs.memories, ours.memories),
    circles: mergeList(base.circles ?? [], theirs.circles ?? [], ours.circles ?? []),
    calls: mergeList(base.calls ?? [], theirs.calls ?? [], ours.calls ?? []),
    outreach: {
      ...(theirs.outreach ?? {}),
      ...(ours.outreach ?? {}),
      evaluated: { ...(theirs.outreach?.evaluated ?? {}), ...(ours.outreach?.evaluated ?? {}) },
      triggers: mergeList(base.outreach?.triggers ?? [], theirs.outreach?.triggers ?? [], ours.outreach?.triggers ?? []),
    },
    conversations: mergeRecord(base.conversations, theirs.conversations, ours.conversations,
      (b, t, o) => mergeList(b ?? [], t, o)),
    vibes: mergeRecord(base.vibes, theirs.vibes, ours.vibes),
    lives: mergeRecord(base.lives, theirs.lives, ours.lives),
    scores: mergeRecord(base.scores, theirs.scores, ours.scores),
    /* Points only grow, so the larger of the two is the truth. */
    bank: mergeRecord(base.bank, theirs.bank, ours.bank, (_b, t, o) => Math.max(t ?? 0, o ?? 0)),
    /* Like tombstones, these only grow: unlocked once is unlocked, started once is started. */
    unlocked: mergeRecord(base.unlocked, theirs.unlocked, ours.unlocked,
      (_b, t, o) => [...t, ...o.filter((x) => !t.some((y) => y.key === x.key))]),
    started: { ...(theirs.started ?? {}), ...(ours.started ?? {}) },
    cutoffs: mergeRecord(base.cutoffs, theirs.cutoffs, ours.cutoffs),
    digests: mergeRecord(base.digests, theirs.digests, ours.digests),
    scrapbook: mergeRecord(base.scrapbook, theirs.scrapbook, ours.scrapbook, (b, t, o) => mergeList(b ?? [], t ?? [], o ?? [])),
    edits: mergeRecord(base.edits, theirs.edits, ours.edits),
    feelings: mergeRecord(base.feelings, theirs.feelings, ours.feelings),
    /* Tombstones only ever grow: something forgotten in either copy stays forgotten. */
    forgotten: mergeRecord(base.forgotten, theirs.forgotten, ours.forgotten,
      (_b, t, o) => [...new Set([...t, ...o])]),
  };
}

/* Saving, against whichever backend this browser has (IndexedDB, or
 * localStorage where that will not open).
 *
 * Asynchronous now, so saves are queued: a burst of state changes writes the
 * newest one once the write in progress lands, never several out of order. A
 * write is conditional on the revision this tab last saw; if another copy got
 * there first, the two are merged and the merge is written instead. */
export type Saved = { result: SaveResult; state: SoloState };

export class Persister {
  private backend: Backend = localBackend;
  /** What this tab last read from or wrote to disk: the merge base. */
  private base: SoloState | null = null;
  private rev = 0;
  /** The in-memory object that matches disk, so an unchanged state is never rewritten. */
  persisted: SoloState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(backend?: Backend) {
    if (backend) this.backend = backend;
  }

  get storage(): "idb" | "local" {
    return this.backend.name;
  }

  async open(choose: () => Promise<Backend> = () => chooseBackend(combineRaw)): Promise<SoloState> {
    try {
      this.backend = await choose();
    } catch {
      this.backend = localBackend;
    }
    let s: SoloState;
    try {
      const { raw, rev } = await this.backend.read();
      s = parseState(raw);
      if (!s.corrupt) s.rev = rev || s.rev || 0;
    } catch (err) {
      console.error("solo state could not be read", err);
      s = parseState("{");
    }
    this.base = s;
    this.rev = s.rev ?? 0;
    this.persisted = s;
    return s;
  }

  /* Write `state`, merging with anything another copy wrote first. Resolves
     with what was written -- a new object only when a merge happened. */
  save(state: SoloState): Promise<Saved> {
    const run = this.queue.then(() => this.write(state));
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(state: SoloState): Promise<Saved> {
    if (state.corrupt) return { result: { ok: false, reason: "corrupt", bytes: 0 }, state };
    let next = state;
    for (let attempt = 0; attempt < 4; attempt++) {
      const rev = this.rev + 1;
      let raw: string;
      try {
        raw = serialiseState({ ...next, rev });
      } catch {
        return { result: { ok: false, reason: "unavailable", bytes: 0 }, state: next };
      }
      try {
        const outcome = await this.backend.write(raw, rev, this.rev);
        if (outcome === "ok") {
          this.base = next;
          this.rev = rev;
          this.persisted = next;
          announce(rev);
          return { result: { ok: true, bytes: raw.length, nearlyFull: await nearlyFull(this.backend, raw.length) }, state: next };
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : (err as { name?: string })?.name ?? "";
        const quota = /quota/i.test(name) || name === "NS_ERROR_DOM_QUOTA_REACHED";
        console.error("solo save failed", name);
        /* IndexedDB opened but will not write (some phone browsers with shields on):
           keep the data in localStorage rather than telling them nothing is saved.
           Its rev stays ahead of IndexedDB's, so the next load folds it back in. */
        if (!quota && this.backend !== localBackend) {
          try {
            const there = (await localBackend.revision()) ?? 0;
            if ((await localBackend.write(raw, rev, there)) === "ok") {
              this.base = next;
              this.rev = rev;
              this.persisted = next;
              return { result: { ok: true, bytes: raw.length, nearlyFull: false }, state: next };
            }
          } catch { /* localStorage refuses too: fall through */ }
        }
        return { result: { ok: false, reason: quota ? "quota" : "unavailable", bytes: raw.length }, state: next };
      }
      /* Someone else wrote first: take theirs, put ours on top, try again. */
      const theirs = await this.backend.read().catch(() => null);
      const parsed = theirs ? parseState(theirs.raw) : null;
      if (!theirs || !parsed || parsed.corrupt) return { result: { ok: false, reason: "unavailable", bytes: 0 }, state: next };
      next = this.base ? mergeStates(this.base, parsed, next) : next;
      this.base = parsed;
      this.rev = theirs.rev;
    }
    return { result: { ok: false, reason: "unavailable", bytes: 0 }, state: next };
  }

  /* Another copy wrote. Fold its changes into `current` without writing --
     or, when this tab has nothing unsaved, simply adopt what is on disk, so
     two tabs never take turns rewriting the same thing at each other. Null
     when there is nothing new. */
  async refresh(current: SoloState): Promise<SoloState | null> {
    const onDisk = await this.backend.revision();
    if (onDisk === null || onDisk === this.rev || !this.base) return null;
    const { raw, rev } = await this.backend.read();
    const theirs = parseState(raw);
    if (theirs.corrupt) return null;
    const unsaved = current !== this.persisted;
    const next = unsaved ? mergeStates(this.base, theirs, current) : theirs;
    this.base = theirs;
    this.rev = rev;
    if (!unsaved) this.persisted = theirs;
    return next;
  }
}

/* Two stored copies with no common history, as one: everything either holds.
   With an empty base, every item counts as added on its side, so the result is
   the union -- a leftover empty copy contributes nothing and removes nothing. */
export function combineRaw(a: string, b: string, rev: number): string {
  const one = parseState(a);
  const two = parseState(b);
  if (one.corrupt) return b;
  if (two.corrupt) return a;
  return serialiseState({ ...mergeStates(parseState(null), one, two), rev });
}

/* Telling other tabs a write happened. localStorage did this on its own (the
   storage event); IndexedDB does not, so it is said out loud. */
const CHANNEL = "muse.solo";
let channel: BroadcastChannel | null = null;
function announce(rev: number) {
  try {
    channel ??= new BroadcastChannel(CHANNEL);
    channel.postMessage({ rev });
  } catch { /* single tab, or no BroadcastChannel: nothing to tell */ }
}

export function onOtherTabWrite(f: () => void): () => void {
  try {
    const c = new BroadcastChannel(CHANNEL);
    c.onmessage = () => f();
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) f(); };
    window.addEventListener("storage", onStorage);
    return () => { c.close(); window.removeEventListener("storage", onStorage); };
  } catch {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) f(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }
}

async function nearlyFull(backend: Backend, bytes: number): Promise<boolean> {
  if (backend.name === "local") return bytes > STORAGE_BUDGET;
  const used = await storageUse();
  return used !== null && used > 0.9;
}
