"use client";

import { Avatar } from "@/components/Avatar";
import { Photo } from "@/components/Photo";
import { secretFor } from "@/lib/solo/life";
import { keptOf, lookBack, removeKept } from "@/lib/solo/scrapbook";
import type { SoloMuse, SoloState } from "@/lib/solo/store";

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/* What you have kept with someone, and what is worth looking back on: the lines
   and photos you chose to keep (they stay when the chat is cleared), their inside
   jokes, the photos and songs they sent, and their secret once told. */
export function Scrapbook({
  muse, state, update, onBack,
}: { muse: SoloMuse; state: SoloState; update: Update; onBack: () => void }) {
  const kept = [...keptOf(state, muse.id)].reverse();
  const { jokes, photos, songs } = lookBack(state, muse.id);
  const secret = secretFor(state, muse.id, null);
  const told = secret?.stage === "told" ? secret.text : null;
  const empty = !kept.length && !jokes.length && !photos.length && !songs.length && !told;

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Scrapbook</p>
        <button className="link-btn" onClick={onBack}>Back</button>
      </header>

      <div className="row" style={{ gap: "0.75rem", marginTop: "1.5rem", alignItems: "center" }}>
        <Avatar name={muse.name} image={muse.avatar?.id} />
        <div style={{ minWidth: 0 }}>
          <h1 className="display" style={{ fontSize: "1.6rem", margin: 0 }}>You &amp; {muse.name}</h1>
          <p className="fine" style={{ margin: 0 }}>
            Inside jokes, and the photos and songs {muse.name} shares, gather here.
          </p>
        </div>
      </div>

      {empty && (
        <div className="empty" style={{ marginTop: "2.5rem" }}>
          <p style={{ fontFamily: "var(--serif)", fontSize: "1.05rem" }}>Nothing here yet.</p>
          <p className="fine">Inside jokes and what {muse.name} shares will gather here as you talk.</p>
        </div>
      )}

      {kept.length > 0 && (
        <>
          <h2 className="section-title">Kept</h2>
          <ul className="scrap-list">
            {kept.map((k) => (
              <li key={k.id} className="scrap-item">
                {k.image && <Photo id={k.image.id} w={k.image.w} h={k.image.h} />}
                {k.text && <p className={k.from === "muse" ? "scrap-text muse" : "scrap-text"}>{k.text}</p>}
                {k.song && <p className="scrap-text">🎵 {k.song.title}{k.song.artist ? ` · ${k.song.artist}` : ""}</p>}
                <span className="stamp">
                  {k.from === "user" ? "you" : muse.name} · {when(k.at)}{" · "}
                  <button className="inline-link" onClick={() => update((cur) => removeKept(cur, muse.id, k.id))}>remove</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {told && (
        <>
          <h2 className="section-title">What {muse.name} told you</h2>
          <p className="scrap-text muse">{told}</p>
        </>
      )}

      {jokes.length > 0 && (
        <>
          <h2 className="section-title">Inside jokes</h2>
          <ul className="scrap-list">
            {jokes.map((j) => <li key={j.id} className="scrap-item"><p className="scrap-text">{j.content}</p><span className="stamp">{when(j.createdAt)}</span></li>)}
          </ul>
        </>
      )}

      {photos.length > 0 && (
        <>
          <h2 className="section-title">Photos {muse.name} sent</h2>
          <div className="look-grid">
            {photos.map((m) => <Photo key={m.id} id={m.image!.id} w={m.image!.w} h={m.image!.h} />)}
          </div>
        </>
      )}

      {songs.length > 0 && (
        <>
          <h2 className="section-title">Songs {muse.name} shared</h2>
          <ul className="scrap-list">
            {songs.map((m) => <li key={m.id} className="scrap-item"><p className="scrap-text">🎵 {m.song!.title}{m.song!.artist ? ` · ${m.song!.artist}` : ""}</p><span className="stamp">{when(m.at)}</span></li>)}
          </ul>
        </>
      )}
    </main>
  );
}
