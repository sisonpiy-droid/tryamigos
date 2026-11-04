"use client";

import { useEffect, useState } from "react";

import { photoUrl } from "@/lib/solo/photos";

/* §48: every Muse needs to feel visually distinct, and MVP may use generated
   avatars. The hue is derived from the name, so a Muse looks the same
   everywhere without storing an image or calling anything. With a picture,
   the picture; the initial stays underneath until it loads, and if it never
   does. */

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name, large = false, small = false, ring = false, image }: {
  name: string; large?: boolean; small?: boolean; image?: string | null;
  /** Something unread: a ring around the picture. */
  ring?: boolean;
}) {
  const hue = hueOf(name);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (image) void photoUrl(image).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [image]);
  return (
    <div
      className={`avatar${large ? " avatar-lg" : ""}${small ? " avatar-sm" : ""}${ring ? " avatar-ring" : ""}`}
      style={{
        background: `linear-gradient(140deg, hsl(${hue} 62% 74%), hsl(${(hue + 48) % 360} 58% 62%))`,
      }}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase()}
      {/* A local file from IndexedDB (an object URL): nothing for next/image to optimise. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {image && url && <img src={url} alt="" className="avatar-img" />}
    </div>
  );
}
