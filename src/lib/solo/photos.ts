"use client";

import { getImage, putImage } from "./backend";

/* Photos in a conversation.
 *
 * A phone photo is 3-8MB. It is shrunk here, before it is stored or sent: the
 * long side to 1280px, re-encoded as JPEG -- a couple of hundred kilobytes,
 * plenty for a friend to see what is in it, and small enough that the last few
 * can go with every reply. Kept in IndexedDB as a file, never inside the
 * conversation state, so a hundred photos cost nothing until they are looked
 * at. Nothing is uploaded anywhere except to the model, with the reply that
 * needs it.
 */

/** The words a photo-only message carries, so everything downstream that
 *  expects text -- the window, memory, export -- still has some. */
export const PHOTO_ONLY = "(sent a photo)";

const LONG_SIDE = 1280;

export async function shrink(file: File, side = LONG_SIDE): Promise<{ blob: Blob; w: number; h: number; mime: string } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return blob ? { blob, w, h, mime: "image/jpeg" } : null;
  } catch {
    return null;
  }
}

export async function savePhoto(id: string, blob: Blob): Promise<boolean> {
  return putImage(id, blob);
}

export async function blobBase64(blob: Blob): Promise<{ mime: string; data: string }> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: blob.type || "image/jpeg", data: btoa(bin) };
}

export async function photoBase64(id: string): Promise<{ mime: string; data: string } | null> {
  const blob = await getImage(id);
  if (!blob) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: blob.type || "image/jpeg", data: btoa(bin) };
}

/* Object URLs for showing photos, made once per photo per page. */
const urls = new Map<string, Promise<string | null>>();
export function photoUrl(id: string): Promise<string | null> {
  let u = urls.get(id);
  if (!u) {
    u = getImage(id).then((b) => (b ? URL.createObjectURL(b) : null));
    urls.set(id, u);
  }
  return u;
}
