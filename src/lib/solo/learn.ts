"use client";

import { addMemories, attachEmbeddings, findMuse, type SoloMessage, type SoloState } from "./store";

/* Turning conversation into memory, for one-to-one chats and circles alike.
 *
 * Three things are kept apart on purpose:
 *
 *   - a conversation's history: the messages of one thread, a 1:1 chat or a
 *     circle, which is only ever sent back to that same thread;
 *   - memory: short facts about the user, owned by each character, which go
 *     wherever that character goes -- into later chats and into groups;
 *   - where a memory was learned: a fact from a 1:1 chat travels into a group
 *     marked private, so the character can use it without repeating it there.
 *
 * The 1:1 transcript is never sent to a group; only what was distilled from it.
 * Circles used to learn nothing at all, so anything said in a group was gone the
 * moment it scrolled out of the window -- even for the person it was said to.
 */

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/** Vectors for some text, or null when there is no embedding model configured
 *  or the call fails. Never throws: worse recall for one turn is not worth
 *  failing a message over. */
export async function embedTexts(texts: string[]): Promise<(number[] | null)[] | null> {
  if (!texts.length) return null;
  try {
    const res = await fetch("/api/solo/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts }),
    });
    if (!res.ok) return null;
    const { vectors } = await res.json();
    return Array.isArray(vectors) ? vectors : null;
  } catch {
    return null;
  }
}

/* Memory extraction over a window of a thread, for everyone who heard it.
 *
 * Never blocks anything and never surfaces an error -- a missed memory is not
 * worth a banner. `known` is captured once and reused for the write-back,
 * because `replaces` comes back as indexes into exactly this list; recomputing
 * it after the round trip would renumber it and delete the wrong memory. */
export async function learnFrom(opts: {
  /** Who heard it: one character in a 1:1 chat, everyone present in a circle. */
  museIds: string[];
  window: SoloMessage[];
  state: SoloState;
  update: Update;
  /** Set for a circle: what is learned is marked as said in this room. */
  circleId?: string;
  /** In a circle, who said each line, so the extractor can tell people apart. */
  nameOf?: (m: SoloMessage) => string;
}): Promise<void> {
  const { museIds, window, state, update, circleId, nameOf } = opts;
  if (!museIds.length || !window.length) return;
  const ids = new Set(museIds);
  const known = [
    ...new Set(state.memories.filter((m) => ids.has(m.museId)).map((m) => m.content)),
  ].slice(-80);
  try {
    const r = await fetch("/api/solo/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: window.map((m) => ({
          role: m.from === "user" ? "user" : "assistant",
          content: m.from === "muse" && nameOf ? `${nameOf(m)}: ${m.content}` : m.content,
          at: m.at,
        })),
        known,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
    const { memories: found } = await r.json();
    if (!Array.isArray(found) || !found.length) return;
    /* Read at commit time, not from the snapshot this started with: anything
       that happened during the round trip has to survive the write. */
    update((cur) => museIds.reduce((s, id) => addMemories(s, id, found, known, { circleId }), cur));

    /* Embedded straight away so the next turn can recall them by meaning.
       Separate from the write so a slow or failed embedding never delays the
       memory itself landing. */
    const texts: string[] = found.map((f: { content: string }) => f.content);
    const vecs = await embedTexts(texts);
    if (!vecs) return;
    update((cur) => {
      const byContent = new Map(texts.map((t, i) => [t, vecs[i]]));
      const patch: Record<string, number[] | null> = {};
      for (const m of cur.memories) {
        if (!ids.has(m.museId) || m.embedding?.length) continue;
        const v = byContent.get(m.content);
        if (v) patch[m.id] = v;
      }
      return attachEmbeddings(cur, patch);
    });
  } catch { /* a missed memory is not worth an error banner */ }
}

/* ------------------------------------------------- the one-to-one, digested */

/* How much of a one-to-one chat goes into a group word for word; everything
   before it goes as the digest. Keep in step with recentOneToOne. */
export const EXCERPT_MESSAGES = 30;
/** How many new older messages make the digest worth redoing. */
const DIGEST_EVERY = 30;
const digesting = new Set<string>();

/* Brings each member's digest of their one-to-one with the user up to date,
   in the background, when a group is opened. Quiet on failure: the group
   still has the recent stretch and the memories. */
export async function refreshDigests(state: SoloState, museIds: string[], update: Update): Promise<void> {
  await Promise.all(museIds.map(async (id) => {
    const thread = state.conversations[id] ?? [];
    const older = thread.slice(0, -EXCERPT_MESSAGES);
    if (older.length < 10 || digesting.has(id)) return;
    const had = state.digests?.[id];
    const covered = had ? older.findIndex((m) => m.id === had.upTo) : -1;
    const fresh = older.slice(covered + 1);
    if (had && fresh.length < DIGEST_EVERY) return;
    const name = findMuse(state, id)?.name;
    if (!name) return;
    digesting.add(id);
    try {
      const res = await fetch("/api/solo/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, you: state.userName ?? "them", previous: had?.text ?? "",
          messages: fresh.slice(-150).map((m) => ({ from: m.from, content: m.content.slice(0, 600), at: m.at })),
        }),
      });
      const { digest } = await res.json();
      if (typeof digest !== "string" || !digest.trim()) return;
      const upTo = older.at(-1)!.id;
      update((cur) => ({ ...cur, digests: { ...(cur.digests ?? {}), [id]: { text: digest, upTo, at: new Date().toISOString() } } }));
    } catch { /* the group goes on without it */ } finally {
      digesting.delete(id);
    }
  }));
}
