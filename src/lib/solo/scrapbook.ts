import { deleteImages, getImage, putImage } from "./backend";
import { isMediaCaption, type Kept, type SoloMessage, type SoloState } from "./store";

/* A scrapbook with each character: what you chose to keep, and what is worth
 * looking back on.
 *
 * Kept things are copies, made when you tap "keep", so clearing the chat does
 * not take them with it; a photo is copied under its own id for the same reason.
 * Clearing the chat *and memories* forgets the scrapbook too. Beside what you
 * kept, the page gathers what is already there: inside jokes, photos and songs
 * she sent, and her secret once she has told it.
 */

const KEPT_MAX = 200;

export const keptOf = (s: SoloState, museId: string): Kept[] => s.scrapbook?.[museId] ?? [];
export const isKept = (s: SoloState, museId: string, messageId: string) => keptOf(s, museId).some((k) => k.id === `kept-${messageId}`);

/** A copy of a message, with its photo copied too. Null if the photo cannot be kept. */
export async function copyForKeeping(m: SoloMessage, now = Date.now()): Promise<Kept | null> {
  let image: Kept["image"];
  if (m.image) {
    const blob = await getImage(m.image.id);
    const id = `kept-img-${m.id}`;
    if (!blob || !(await putImage(id, blob))) return null;
    image = { id, w: m.image.w, h: m.image.h };
  }
  return {
    id: `kept-${m.id}`,
    from: m.from === "user" ? "user" : "muse",
    text: image && isMediaCaption(m.content) ? "" : m.content.slice(0, 1000),
    at: m.at,
    keptAt: new Date(now).toISOString(),
    ...(image ? { image } : {}),
    ...(m.song ? { song: { title: m.song.title, artist: m.song.artist } } : {}),
  };
}

export function addKept(s: SoloState, museId: string, k: Kept): SoloState {
  const have = keptOf(s, museId);
  if (have.some((x) => x.id === k.id)) return s;
  return { ...s, scrapbook: { ...(s.scrapbook ?? {}), [museId]: [...have, k].slice(-KEPT_MAX) } };
}

/** Takes something out of the scrapbook, and its photo with it. */
export function removeKept(s: SoloState, museId: string, id: string): SoloState {
  const gone = keptOf(s, museId).find((k) => k.id === id);
  if (!gone) return s;
  if (gone.image) void deleteImages([gone.image.id]);
  return { ...s, scrapbook: { ...(s.scrapbook ?? {}), [museId]: keptOf(s, museId).filter((k) => k.id !== id) } };
}

/** What is already in the chat and worth looking back on, newest first. */
export function lookBack(s: SoloState, museId: string) {
  const log = (s.conversations[museId] ?? []).filter((m) => !m.showAt || Date.parse(m.showAt) <= Date.now());
  return {
    jokes: s.memories.filter((m) => m.museId === museId && m.type === "SHARED").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    photos: log.filter((m) => m.from === "muse" && m.image && !m.veiled).reverse().slice(0, 24),
    songs: log.filter((m) => m.from === "muse" && m.song).reverse().slice(0, 24),
  };
}
