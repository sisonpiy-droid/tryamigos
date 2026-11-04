"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { blobBase64, shrink } from "@/lib/solo/photos";
import type { SoloMuse } from "@/lib/solo/store";

/* Photos of someone, read once for how they look and the vibe they give off.
 *
 * Between one and five. They are shrunk here, sent for a description and then
 * dropped: only the words are kept, on this device, and the character talks
 * from that feeling. The words can be edited before they are saved. */

export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 5;
const SIDE = 800;

export function Look({
  muse,
  onSave,
  onBack,
}: {
  muse: SoloMuse;
  /** The description to keep; null to remove it. */
  onSave: (look: string | null) => void;
  onBack: () => void;
}) {
  const saved = muse.persona?.look?.trim() ?? "";
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(files);
  useEffect(() => { live.current = files; });
  useEffect(() => () => live.current.forEach((f) => URL.revokeObjectURL(f.url)), []);

  function add(list: FileList | null) {
    const picked = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!picked.length) return;
    setError(null);
    setDraft(null);
    setFiles((cur) => {
      const room = MAX_PHOTOS - cur.length;
      if (picked.length > room) setError(`Up to ${MAX_PHOTOS} photos. The rest were left out.`);
      return [...cur, ...picked.slice(0, Math.max(0, room)).map((file) => ({ file, url: URL.createObjectURL(file) }))];
    });
    if (input.current) input.current.value = "";
  }

  function drop(i: number) {
    setFiles((cur) => {
      URL.revokeObjectURL(cur[i].url);
      return cur.filter((_, j) => j !== i);
    });
    setDraft(null);
  }

  async function read() {
    setBusy(true);
    setError(null);
    try {
      const small = await Promise.all(files.map((f) => shrink(f.file, SIDE)));
      if (small.some((s) => !s)) throw new Error("open");
      const photos = await Promise.all(small.map((s) => blobBase64(s!.blob)));
      const res = await fetch("/api/solo/look", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: muse.name, mode: muse.persona?.mode, photos }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.look) throw new Error(data.error ?? "Couldn't read those photos. Try again.");
      setDraft(data.look);
    } catch (e) {
      setError(e instanceof Error && e.message !== "open" ? e.message : "Couldn't open one of those photos. Try a different one.");
    } finally {
      setBusy(false);
    }
  }

  const count = files.length;
  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Look &amp; vibe</p>
        <button className="link-btn" onClick={onBack}>Back</button>
      </header>

      <div className="row" style={{ gap: "0.75rem", marginTop: "1.5rem", alignItems: "center" }}>
        <Avatar name={muse.name} image={muse.avatar?.id} />
        <div style={{ minWidth: 0 }}>
          <h1 className="display" style={{ fontSize: "1.6rem", margin: 0 }}>Photos of {muse.name}</h1>
          <p className="fine" style={{ margin: 0 }}>
            Add {MIN_PHOTOS} to {MAX_PHOTOS} photos. {muse.name} will pick up how they look and the vibe, and the chat will feel like that.
          </p>
        </div>
      </div>

      {saved && !draft && (
        <div className="look-card">
          <p className="fine" style={{ margin: 0 }}>What {muse.name} goes by now</p>
          <p style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0 0" }}>{saved}</p>
          <button className="link-btn" onClick={() => { if (confirm("Remove this look? The chat goes back to how it was.")) onSave(null); }}>
            Remove
          </button>
        </div>
      )}

      <div className="look-grid">
        {files.map((f, i) => (
          <div key={f.url} className="look-thumb">
            {/* A local file the user just chose: nothing for next/image to optimise. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={f.url} alt={`Photo ${i + 1}`} />
            <button type="button" aria-label={`Remove photo ${i + 1}`} onClick={() => drop(i)}>×</button>
          </div>
        ))}
        {count < MAX_PHOTOS && (
          <button type="button" className="look-add" onClick={() => input.current?.click()}>
            + Add photo
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => add(e.target.files)} />
      <p className="fine">{count} of {MAX_PHOTOS} · photos are only looked at once and are not kept.</p>

      {error && <p className="look-error" role="alert">{error}</p>}

      {!draft ? (
        <button className="btn" disabled={busy || count < MIN_PHOTOS} onClick={() => void read()}>
          {busy ? "Looking…" : count < MIN_PHOTOS ? `Add at least ${MIN_PHOTOS}` : saved ? "Read these instead" : "Read the vibe"}
        </button>
      ) : (
        <>
          <label className="field" style={{ marginTop: "1rem" }}>
            <span>This is what {muse.name} will go by. Change anything you like.</span>
            <textarea className="input" rows={7} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <div className="row" style={{ gap: "0.75rem" }}>
            <button className="btn" disabled={!draft.trim()} onClick={() => { onSave(draft.trim()); onBack(); }}>Save</button>
            <button className="link-btn" onClick={() => setDraft(null)}>Discard</button>
          </div>
        </>
      )}
    </main>
  );
}
