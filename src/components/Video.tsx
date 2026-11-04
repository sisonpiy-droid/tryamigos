"use client";

import { useEffect, useState } from "react";

import { clipLength } from "@/lib/solo/attach";
import { photoUrl } from "@/lib/solo/photos";

/* A video in the thread, played from this device. Sized from its own shape
   before it loads, like a photo, so the conversation does not jump. */
export function Video({ id, w, h, seconds }: { id: string; w: number; h: number; seconds: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void photoUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);
  return (
    <div className="photo video" style={{ aspectRatio: `${w} / ${h}` }} onClick={(e) => e.stopPropagation()}>
      {url
        ? <video src={url} controls playsInline preload="metadata" />
        : <span className="photo-missing">video · {clipLength(seconds)}</span>}
    </div>
  );
}
