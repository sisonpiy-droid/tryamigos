"use client";

import { putImage } from "./backend";
import { photoBase64, shrink } from "./photos";
import type { SoloMessage } from "./store";

/* Photos and videos the user sends, in a one-to-one chat or a group.
 *
 * A photo is shrunk and kept, as before. A video is kept whole on this device
 * -- it plays in the thread from there -- and is never uploaded: a request to
 * the server tops out around 4.5MB, and a phone video is ten times that. What
 * the model gets instead is a few frames taken from through it, plus how long
 * it is, which is enough to react to what it shows the way a friend scrolling
 * past would.
 */

/** The words a video-only message carries, like PHOTO_ONLY for a photo. */
export const VIDEO_ONLY = "(sent a video)";
/** Largest video kept. Bigger than this is a film, not a clip, and IndexedDB on a phone has limits. */
export const VIDEO_MAX_BYTES = 80 * 1024 * 1024;
const FRAMES = 4;
const FRAME_SIDE = 640;

export type Draft =
  | { kind: "photo"; blob: Blob; w: number; h: number; url: string }
  | { kind: "video"; blob: Blob; w: number; h: number; url: string; seconds: number; frames: Blob[] };

export async function prepareAttachment(file: File): Promise<Draft | { error: string }> {
  if (file.type.startsWith("video/")) return prepareVideo(file);
  const small = await shrink(file);
  return small ? { kind: "photo", ...small, url: URL.createObjectURL(small.blob) } : { error: "Couldn't open that photo. Try a different one." };
}

async function prepareVideo(file: File): Promise<Draft | { error: string }> {
  if (file.size > VIDEO_MAX_BYTES) return { error: "That video is too big to keep here. Try one under 80MB." };
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await once(video, "loadedmetadata");
    let seconds = video.duration;
    /* A recorded WebM often has no length in its header until something
       seeks past the end -- then the browser works it out. */
    if (!Number.isFinite(seconds)) {
      video.currentTime = 1e7;
      await once(video, "seeked").catch(() => {});
      seconds = Number.isFinite(video.duration) ? video.duration : 0;
    }
    const w = video.videoWidth || 720;
    const h = video.videoHeight || 1280;
    const frames: Blob[] = [];
    /* Spread through it; with no length at all, at least the opening. */
    const at = seconds > 0
      ? Array.from({ length: FRAMES }, (_, i) => Math.min(seconds - 0.05, seconds * ((i + 0.5) / FRAMES)))
      : [0];
    for (const t of at) {
      video.currentTime = Math.max(0, t);
      await once(video, "seeked");
      const f = await grab(video, w, h);
      if (f) frames.push(f);
    }
    return { kind: "video", blob: file, w, h, url, seconds: Math.round(seconds), frames };
  } catch {
    URL.revokeObjectURL(url);
    return { error: "Couldn't open that video. Try a different one." };
  }
}

function once(el: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 15_000);
    el.addEventListener(event, () => { clearTimeout(t); resolve(); }, { once: true });
    el.addEventListener("error", () => { clearTimeout(t); reject(new Error("video")); }, { once: true });
  });
}

async function grab(video: HTMLVideoElement, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, FRAME_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.75));
}

/** Keeps the file (and a video's frames) on this device, and says what to put on the message. */
export async function keepAttachment(draft: Draft, baseId: string): Promise<Pick<SoloMessage, "image" | "video"> | null> {
  if (draft.kind === "photo") {
    const id = `img-${baseId}`;
    return (await putImage(id, draft.blob)) ? { image: { id, w: draft.w, h: draft.h } } : null;
  }
  const id = `vid-${baseId}`;
  if (!(await putImage(id, draft.blob))) return null;
  const frames: string[] = [];
  for (let i = 0; i < draft.frames.length; i++) {
    const fid = `vidf-${baseId}-${i}`;
    if (await putImage(fid, draft.frames[i])) frames.push(fid);
  }
  return { video: { id, w: draft.w, h: draft.h, seconds: draft.seconds, frames } };
}

/** "0:23": how long a video is. */
export const clipLength = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** A video's frames, as the model is sent them. */
export async function framesBase64(m: SoloMessage): Promise<{ mime: string; data: string }[]> {
  const out = await Promise.all((m.video?.frames ?? []).map((id) => photoBase64(id).catch(() => null)));
  return out.filter((x): x is { mime: string; data: string } => !!x);
}

/** Every file a message holds, for deleting it. */
export const filesOf = (m: SoloMessage): string[] =>
  [m.image?.id, m.voiceNote?.id, m.video?.id, ...(m.video?.frames ?? [])].filter((x): x is string => !!x);
