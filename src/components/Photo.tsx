"use client";

import { useEffect, useState } from "react";

import { photoUrl } from "@/lib/solo/photos";

/* A photo in the thread. Sized from its stored dimensions before it loads, so
   the conversation does not jump as pictures arrive; tap to see it full screen. */
/* `veiled`: sent blurred, "tap to see". The first tap only reveals it. */
export function Photo({ id, w, h, veiled, onReveal }: { id: string; w: number; h: number; veiled?: boolean; onReveal?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let live = true;
    void photoUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);

  return (
    <>
      <button
        type="button"
        className={veiled ? "photo veiled" : "photo"}
        style={{ aspectRatio: `${w} / ${h}` }}
        onClick={() => (veiled ? onReveal?.() : url && setBig(true))}
        aria-label={veiled ? "Tap to see the photo" : "Open photo"}
      >
        {/* A local file from IndexedDB (an object URL): nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" /> : <span className="photo-missing">photo</span>}
        {veiled && <span className="veil">Tap to see</span>}
      </button>
      {big && url && (
        <div className="photo-full" role="dialog" aria-label="Photo" onClick={() => setBig(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="" />
        </div>
      )}
    </>
  );
}
