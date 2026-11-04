"use client";

import { useState } from "react";

import { Avatar } from "@/components/Avatar";
import { readReaction, type SoloMuse, type SoloState } from "@/lib/solo/store";
import { bondOf, momentsOf } from "@/lib/solo/life";
import { storyOf } from "@/lib/solo/story";
import { prepareTurn, streamReply, withAppMessage } from "@/lib/solo/turn";

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/* You and them, so far.
 *
 * How long, how often, the firsts, and the moments they remember -- all from
 * what is already kept -- and, when asked, a few lines from them about how it
 * is going, in their own voice and from their own memory of you. Nothing here
 * is invented to fill the page: a relationship two days old has a short story.
 */

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** "Day 2", "Day 40": counted from the first message, the first day being day 1. */
function dayNumber(fromIso: string, now: number): string {
  const a = new Date(fromIso); const b = new Date(now);
  const start = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const today = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return `Day ${Math.round((today - start) / 864e5) + 1}`;
}

/* Memories are written about "User" and "the Muse", for the model. On this
   page they are about you and them. */
function asYou(text: string, name: string): string {
  const out = text
    .replace(/\bUser's\b/g, "your")
    .replace(/\bUser has\b/g, "you have")
    .replace(/\bUser is\b/g, "you are")
    .replace(/\bUser was\b/g, "you were")
    .replace(/\bUser\b/g, "you")
    .replace(/\b(the )?Muse\b/g, name);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function Story({
  muse, state, update, onBack, onMemories,
}: {
  muse: SoloMuse;
  state: SoloState;
  update: Update;
  onBack: () => void;
  onMemories: () => void;
}) {
  const [now] = useState(() => Date.now());
  const s = storyOf(state, muse.id, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const note = state.stories?.[muse.id];
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = state.memories.filter((m) => m.museId === muse.id).length;
  const moments = momentsOf(state, muse.id, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const score = state.scores?.[muse.id];
  const bond = bondOf(state, muse.id, now, Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function ask() {
    setWriting(true);
    setError(null);
    try {
      const prepared = await prepareTurn(state, muse.id, { register: "single", fallback: muse });
      if (!prepared) throw new Error("prepare");
      withAppMessage(prepared, `(${state.userName ?? "They"} is looking at the page in the app about the two of you, and asked how you would describe how it is going between you so far. Answer in three or four lines, in your own voice, from what you actually remember and how you actually talk. Nothing invented, and no list.)`);
      const out = await streamReply(prepared.body, new AbortController().signal, () => {});
      const text = out.ok ? readReaction(out.text.trim()).rest.replace(/\n?\s*-{3,}\s*\n?/g, "\n").trim() : "";
      if (!text) throw new Error("empty");
      update((cur) => ({ ...cur, stories: { ...(cur.stories ?? {}), [muse.id]: { text, at: new Date().toISOString() } } }));
    } catch {
      setError(`${muse.name} couldn't answer that just now. Try again?`);
    } finally {
      setWriting(false);
    }
  }

  const stats: { n: string; label: string }[] = [
    { n: s.since ? dayNumber(s.since, now) : "—", label: s.since ? `since ${when(s.since)}` : "not yet" },
    { n: String(s.daysTalked), label: s.daysTalked === 1 ? "day talked" : "days talked" },
    { n: s.streak >= 2 ? `${s.streak}` : "—", label: s.streak >= 2 ? "days in a row" : "no streak right now" },
    { n: String(s.messages), label: "messages" },
    { n: String(s.calls), label: s.calls ? `calls · ${s.callMinutes} min` : "calls" },
    { n: String(known), label: "things they remember" },
  ];

  return (
    <main className="shell story">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <button className="link-btn" onClick={onBack} style={{ textDecoration: "none" }}>← Back</button>
      </header>

      <div className="story-head">
        <Avatar name={muse.name} image={muse.avatar?.id} />
        <div>
          <h1 className="display">You &amp; {muse.name}</h1>
          <p className="fine" style={{ margin: 0 }}>{muse.relationshipType}</p>
        </div>
      </div>

      {bond && (
        <div className="bond">
          <div className="bond-row"><b>{bond.label}</b>{bond.next && <span>{bond.next.label} next</span>}</div>
          <div className="bond-bar" role="progressbar" aria-label={`How close you are: ${bond.label}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(bond.progress * 100)}>
            <i style={{ width: `${Math.round(bond.progress * 100)}%` }} />
          </div>
          <span className="fine">
            {bond.next ? "Grows every time you talk, every day you come back, and every call." : `As close as it gets.`}
          </span>
        </div>
      )}

      <div className="story-stats">
        {stats.map((x) => (
          <div key={x.label} className="story-stat">
            <b>{x.n}</b>
            <span>{x.label}</span>
          </div>
        ))}
      </div>

      <h2 className="section-title">How it&apos;s going</h2>
      <div className="story-note">
        {note ? (
          <>
            <p>{note.text}</p>
            <span className="fine">— {muse.name}, {when(note.at)}</span>
          </>
        ) : (
          <p className="fine" style={{ margin: 0 }}>Ask {muse.name} how they&apos;d describe the two of you so far.</p>
        )}
        <button className="btn-ghost" disabled={writing || s.messages < 4} onClick={() => void ask()}>
          {writing ? `${muse.name} is thinking…` : note ? "Ask again" : `Ask ${muse.name}`}
        </button>
        {s.messages < 4 && <p className="fine" style={{ margin: 0 }}>Talk a little first.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {(moments.unlocked.length > 0 || moments.next) && (
        <>
          <h2 className="section-title">Moments</h2>
          <ol className="story-line">
            {moments.unlocked.map((m) => (
              <li key={m.key}><span>{when(m.at)}</span>{m.label}</li>
            ))}
            {moments.next && (
              <li className="story-next"><span>Next</span>{moments.next.label} · {moments.next.toGo}</li>
            )}
          </ol>
        </>
      )}

      {score && score.rounds > 0 && (
        <>
          <h2 className="section-title">How well you know each other</h2>
          <div className="story-score">
            <div><b>{score.user}</b><span>you</span></div>
            <div><b>{score.muse}</b><span>{muse.name}</span></div>
            <p className="fine">{score.rounds} question{score.rounds === 1 ? "" : "s"} · ask {muse.name} for a rematch</p>
          </div>
        </>
      )}

      {s.milestones.length > 0 && (
        <>
          <h2 className="section-title">Firsts</h2>
          <ol className="story-line">
            {s.milestones.map((m) => (
              <li key={m.label}><span>{when(m.at)}</span>{m.label}</li>
            ))}
          </ol>
        </>
      )}

      {s.moments.length > 0 && (
        <>
          <h2 className="section-title">Moments they remember</h2>
          <ol className="story-line">
            {s.moments.map((m) => (
              <li key={m.id}><span>{when(m.at ?? m.createdAt)}</span>{asYou(m.content, muse.name)}</li>
            ))}
          </ol>
        </>
      )}

      <button className="link-btn" style={{ marginTop: "1.5rem" }} onClick={onMemories}>
        Everything {muse.name} remembers →
      </button>
    </main>
  );
}
