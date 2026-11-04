"use client";

import { useEffect, useRef, useState } from "react";

import { clipLength, prepareAttachment, type Draft } from "@/lib/solo/attach";
import { canStoreImages } from "@/lib/solo/backend";

/* The camera button beside the message box, and the photo or video waiting to
   go with the next message. Shared by one-to-one chats and groups, so both
   send the same way. */
export function useAttach(onError: (message: string) => void) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [can, setCan] = useState(false);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void canStoreImages().then(setCan); }, []);

  const clear = () => setDraft((cur) => { if (cur) URL.revokeObjectURL(cur.url); return null; });
  /** Hands the draft over to be sent; the caller now owns its URL. */
  const take = () => { const d = draft; setDraft(null); return d; };

  const button = can ? (
    <>
      <button type="button" className="attach" aria-label="Send a photo or video" disabled={opening} onClick={() => input.current?.click()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="12" cy="12" r="3.2" /><path d="M8 5l1.5-2h5L16 5" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*,video/*"
        className="sr-only"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setOpening(true);
          try {
            const got = await prepareAttachment(file);
            if ("error" in got) { onError(got.error); return; }
            setDraft((cur) => { if (cur) URL.revokeObjectURL(cur.url); return got; });
          } finally {
            setOpening(false);
          }
        }}
      />
    </>
  ) : null;

  const preview = draft ? (
    <div className="photo-draft">
      {draft.kind === "photo" ? (
        /* A photo still on this device (an object URL): nothing for next/image to optimise. */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={draft.url} alt="Photo to send" />
      ) : (
        <span className="video-draft">
          <video src={draft.url} muted playsInline preload="metadata" />
          <b>▶ {clipLength(draft.seconds)}</b>
        </span>
      )}
      <button type="button" className="link-btn" aria-label={`Remove ${draft.kind}`} onClick={clear}>×</button>
    </div>
  ) : opening ? <p className="fine" role="status">Opening…</p> : null;

  return { draft, button, preview, take, clear };
}
