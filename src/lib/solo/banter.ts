import type { SoloMessage } from "./store";

/* Characters in a group talking to each other when nobody is talking to them.
 *
 * With the group open and quiet for a minute or so, one of them says something
 * to another -- a tease, a disagreement, an opinion on what was said earlier --
 * so a room feels like people who know each other rather than three assistants
 * waiting for a turn. It is meant to be a little, not a stream:
 *
 *   - only while the group is open on screen, never in the background;
 *   - at most two lines in one quiet stretch, then silence until the user
 *     speaks again;
 *   - at most eight an hour, per group, because each line is a model call;
 *   - never while the user is typing or a reply to them is on its way.
 */

export const IDLE_MIN_MS = 40_000;
export const IDLE_SPREAD_MS = 50_000;
export const MAX_PER_STRETCH = 2;
export const MAX_PER_HOUR = 8;
const HOUR = 3_600_000;

/** How long after the last message to wait before speaking up: 40 to 90 seconds. */
export const banterDelay = (rand = Math.random()) => IDLE_MIN_MS + rand * IDLE_SPREAD_MS;

export function banterWanted(
  log: SoloMessage[],
  o: {
    now: number;
    members: number;
    /** Lines of banter since the user last spoke. */
    sinceUser: number;
    /** When this group's banter was last sent (ms), for the hourly cap. */
    recent: number[];
    typing: boolean;
    busy: boolean;
    visible: boolean;
  }
): boolean {
  if (o.members < 2 || o.typing || o.busy || !o.visible) return false;
  const shown = log.filter((m) => !m.showAt || Date.parse(m.showAt) <= o.now);
  const last = shown.at(-1);
  /* A message of the user's gets a reply, not banter; and an empty group has nothing to riff on. */
  if (shown.length < 2 || !last || last.from !== "muse") return false;
  if (o.sinceUser >= MAX_PER_STRETCH) return false;
  if (o.recent.filter((t) => o.now - t < HOUR).length >= MAX_PER_HOUR) return false;
  return o.now - Date.parse(last.showAt ?? last.at) >= IDLE_MIN_MS - 1000;
}

/* Who speaks up: not whoever spoke last, and the one who has been quiet longest. */
export function pickBanterer<T extends { id: string }>(people: T[], log: SoloMessage[], rand = Math.random()): T | null {
  const lastSpeaker = log.findLast((m) => m.from === "muse")?.speakerId;
  const others = people.filter((p) => p.id !== lastSpeaker);
  if (!others.length) return null;
  const quiet = (id: string) => log.findLastIndex((m) => m.speakerId === id);
  const ranked = [...others].sort((a, b) => quiet(a.id) - quiet(b.id));
  /* The two quietest, so it is not always the same person. */
  return ranked[Math.floor(rand * Math.min(2, ranked.length))];
}

/** What the speaker is told in place of a message from the user. */
export function banterNote(you: string, others: string[]): string {
  return `(Nobody has said anything for a minute or so, and ${you} is just reading along. Say something to ONE of the others -- ${others.join(", ")} -- by name: a tease, a reaction to something they said earlier, an opinion that disagrees with theirs, or a new thought of your own. One or two short lines, in your own voice. It is between you and them: do not address ${you} or ask them anything.)`;
}
