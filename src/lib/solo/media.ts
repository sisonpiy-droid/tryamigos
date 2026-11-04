"use client";

import { isVoice } from "@/lib/voice/voices";
import { canStoreImages, putImage } from "./backend";
import { shrink } from "./photos";
import { editMuse, findMuse, type SoloMuse, type SoloState } from "./store";

/* Making what the Muse sends besides texts: the photo she took, the voice note
 * she recorded. Both are made in the browser's name by the server (the key is
 * there), then kept on this device beside the user's own photos -- nothing is
 * stored anywhere else. Either can fail, and failing is quiet: a photo that
 * could not be made is simply not sent, a voice note becomes the text it would
 * have said.
 */

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/** A photo of what is described, shrunk like any other photo in the thread. */
export async function makePicture(
  description: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; w: number; h: number } | null> {
  try {
    const res = await fetch("/api/solo/picture", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: description.slice(0, 400) }),
    });
    if (!res.ok) return null;
    const { mime, data } = await res.json();
    if (typeof data !== "string") return null;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    /* Generated at about 900x1200 and close to 2MB; the thread keeps 1280px
       JPEGs, the same as a photo the user sends. */
    const small = await shrink(new File([bytes], "photo", { type: mime || "image/png" }));
    return small ? { blob: small.blob, w: small.w, h: small.h } : null;
  } catch {
    return null;
  }
}

/* The voice they speak in, the same one as on a call. A Muse that has never
   been called has none yet, so one is chosen from who they are -- exactly as a
   call would, and saved, so the call and the voice note match afterwards. */
export async function voiceFor(person: SoloMuse, museId: string, update: Update): Promise<string | undefined> {
  if (isVoice(person.voiceId)) return person.voiceId;
  try {
    const p = person.persona;
    const res = await fetch("/api/solo/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: person.name.slice(0, 60),
        relationship: person.relationshipType.slice(0, 120),
        description: person.description.slice(0, 400),
        brief: (p?.brief ?? person.brief ?? "").slice(0, 6000),
        samples: (p?.samples ?? person.samples ?? "").slice(0, 4000),
        gender: p?.gender,
      }),
    });
    const { voiceId } = await res.json();
    if (!isVoice(voiceId)) return undefined;
    update((cur) => (findMuse(cur, museId) ? editMuse(cur, museId, { voiceId }) : cur));
    return voiceId;
  } catch {
    return undefined;
  }
}

/** A voice note: the words spoken, as a WAV file, and how long it lasts. */
export async function recordVoiceNote(
  text: string,
  voice: string | undefined,
  signal?: AbortSignal
): Promise<{ blob: Blob; seconds: number } | null> {
  try {
    const res = await fetch("/api/solo/speak", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 1500), voice }),
    });
    if (!res.ok || !res.body) return null;
    const rate = Number(res.headers.get("x-sample-rate")) || 24000;
    const pcm = new Uint8Array(await res.arrayBuffer());
    if (pcm.length < rate) return null; // under half a second: nothing was said
    return { blob: wav(pcm, rate), seconds: Math.max(1, Math.round(pcm.length / 2 / rate)) };
  } catch {
    return null;
  }
}

/* 16-bit mono PCM with a WAV header, so an ordinary <audio> element can play
   it, seek in it and show how far through it is. */
export function wav(pcm: Uint8Array<ArrayBuffer>, rate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i)); };
  const even = pcm.length - (pcm.length % 2);
  text(0, "RIFF");
  header.setUint32(4, 36 + even, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true); // bytes per second
  header.setUint16(32, 2, true); // bytes per sample
  header.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  header.setUint32(40, even, true);
  return new Blob([header.buffer, pcm.subarray(0, even)], { type: "audio/wav" });
}

/* ------------------------------------------------------- profile pictures */

/* A character's picture, made once and kept like a photo. Which kind (a face,
   or the flower-or-sunset kind) is the server's call: see /api/solo/avatar.
   Asked for the first time their chat is opened, one character at a time. */
const drawing = new Set<string>();

export async function makeAvatar(person: SoloMuse, signal?: AbortSignal): Promise<Blob | null> {
  const p = person.persona;
  const about = [
    person.relationshipType && `They are someone's ${person.relationshipType}.`,
    person.description,
    (p?.brief ?? person.brief ?? "").slice(0, 600),
    (p?.traits ?? person.traits ?? []).length ? `Traits: ${(p?.traits ?? person.traits ?? []).join(", ")}.` : "",
  ].filter(Boolean).join(" ").slice(0, 1200);
  try {
    const res = await fetch("/api/solo/avatar", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: person.name.slice(0, 60), mode: p?.mode ?? "", arch: p?.arch ?? "other", minor: p?.minor, about }),
    });
    if (!res.ok) return null;
    const { mime, data } = await res.json();
    if (typeof data !== "string") return null;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const small = await shrink(new File([bytes], "avatar", { type: mime || "image/png" }));
    return small?.blob ?? null;
  } catch {
    return null;
  }
}

/** Gives a character a picture if they have none and never had one taken away. */
export async function ensureAvatar(state: SoloState, museId: string, update: Update): Promise<void> {
  const person = findMuse(state, museId);
  /* `null` is the user removing it: leave them without. */
  if (!person || person.avatar !== undefined || drawing.has(museId)) return;
  drawing.add(museId);
  try {
    /* Somewhere to keep it first: a picture that cannot be kept is paid for for nothing. */
    if (!(await canStoreImages())) return;
    const blob = await makeAvatar(person);
    if (!blob) return;
    const id = `avatar-${museId}-${Date.now().toString(36)}`;
    if (!(await putImage(id, blob))) return;
    update((cur) => {
      const now = findMuse(cur, museId);
      return now && now.avatar === undefined ? editMuse(cur, museId, { avatar: { id, made: true } }) : cur;
    });
  } finally {
    drawing.delete(museId);
  }
}
