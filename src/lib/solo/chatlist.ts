import type { SoloState } from "./store";

/* The home screen's list of chats: pinned ones first, the rest by most recent,
 * search over names and last lines, and an archive for chats put away. Pure, so
 * the rules are the same wherever the list is drawn and testable without one.
 *
 * Archived is quiet, not gone: an archived chat that gets something new from
 * them comes back to the main list, the way it does everywhere else. */

export type ChatRowInfo = {
  id: string;
  name: string;
  /** The last line, as shown. */
  preview: string;
  /** When the last thing was said (ms). */
  at: number;
  unread: number;
};

const toggled = (list: string[] | undefined, id: string) => (list?.includes(id) ? list.filter((x) => x !== id) : [...(list ?? []), id]);

export const togglePin = (s: SoloState, id: string): SoloState => ({ ...s, pinned: toggled(s.pinned, id) });

/** Archiving also unpins: a chat cannot be both at the top and put away. */
export const toggleArchive = (s: SoloState, id: string): SoloState => {
  const archiving = !s.archived?.includes(id);
  return { ...s, archived: toggled(s.archived, id), pinned: archiving ? (s.pinned ?? []).filter((x) => x !== id) : s.pinned };
};

/** Two copies of a list of ids with a common ancestor: everything either added, nothing either removed. */
export function mergeSet(base: string[] = [], theirs: string[] = [], ours: string[] = []): string[] {
  const removed = new Set(base.filter((x) => !theirs.includes(x) || !ours.includes(x)));
  return [...new Set([...theirs, ...ours])].filter((x) => !removed.has(x));
}

export function arrange(
  rows: ChatRowInfo[],
  o: { pinned?: string[]; archived?: string[]; query?: string }
): { main: ChatRowInfo[]; archived: ChatRowInfo[] } {
  const q = (o.query ?? "").trim().toLowerCase();
  const hit = (r: ChatRowInfo) => !q || r.name.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q);
  const pinned = new Set(o.pinned ?? []);
  const away = new Set(o.archived ?? []);
  const byRecent = (a: ChatRowInfo, b: ChatRowInfo) => b.at - a.at;
  const found = rows.filter(hit);
  /* Archived stays out of the way unless it has something new in it. */
  const main = found.filter((r) => !away.has(r.id) || r.unread > 0);
  return {
    main: [...main.filter((r) => pinned.has(r.id)).sort(byRecent), ...main.filter((r) => !pinned.has(r.id)).sort(byRecent)],
    archived: found.filter((r) => away.has(r.id) && r.unread === 0).sort(byRecent),
  };
}
