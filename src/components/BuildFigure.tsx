"use client";

import { useState } from "react";

import { parseTranscript, sampleWindows, styleOf } from "@/lib/chat-import";
import type { PersonaDraft } from "@/lib/presence/persona";

/* Building someone from public life.
 *
 * Type a name and that is enough. The build looks them up first -- a live web
 * search, via /api/persona/research -- and writes the voice profile from what
 * it found: how they talk in interviews, what they joke about, what they keep
 * coming back to. It used to run on whatever the model remembered, and asked
 * for a known-for, an era, a role and a pasted interview before it would
 * start. Those are all still here, as refinements after the fact rather than
 * homework before it.
 *
 * `samples` and `metrics` are what make a built character sound like the
 * person rather than like an assistant wearing their name, and for a famous
 * person there is nothing to measure. Two answers, in order of honesty:
 *
 *   1. A pasted interview, parsed and measured exactly like an export.
 *   2. Failing that, lines written in their register by the build, labelled as
 *      reconstruction everywhere they appear and never presented as quotation.
 *
 * The limits are not in this file. They are in MODES.figure: a portrayal that
 * deflects a question about someone's marriage the way a media-trained person
 * deflects it, and that is never a romance -- a real person can object to that
 * and cannot be asked.
 *
 * The same screen takes a character from a story. The lookup says which it
 * found, and a character is saved under MODES.fictional instead, carrying
 * whether they are a child in their story. A name that is several people comes
 * back as a list to pick from rather than a guess.
 */

type Step = "who" | "working" | "review" | "material";

const ROLES = [
  { key: "friend", label: "A friend", rel: "a friend", arch: "friend" },
  { key: "mentor", label: "A mentor", rel: "someone who mentors me", arch: "other" },
  { key: "teacher", label: "A teacher", rel: "someone teaching me their craft", arch: "other" },
  { key: "peer", label: "A colleague", rel: "a colleague in my field", arch: "other" },
  { key: "admire", label: "Someone I admire", rel: "someone I admire", arch: "other" },
];

const STANCES = [
  { key: "warm", label: "Someone they've taken to", texture: "close", note: "off duty, franker, willing to think out loud" },
  { key: "press", label: "Like you're press", texture: "distant", note: "polished, on duty, giving you the version they give everyone" },
];

type Source = { title: string; url: string };
type Candidate = { name: string; knownFor: string };

export function BuildFigure({
  userName,
  onCreate,
  onCancel,
}: {
  userName?: string;
  onCreate: (draft: PersonaDraft) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("who");
  const [phase, setPhase] = useState<"search" | "write">("search");
  const [them, setThem] = useState("");
  const [you, setYou] = useState(userName ?? "");
  const [era, setEra] = useState("");
  const [role, setRole] = useState("friend");
  const [stance, setStance] = useState("warm");
  const [quoted, setQuoted] = useState("");
  const [extra, setExtra] = useState("");
  const [knownFor, setKnownFor] = useState("");
  const [research, setResearch] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [fictional, setFictional] = useState(false);
  const [minor, setMinor] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [brief, setBrief] = useState("");
  const [lines, setLines] = useState("");
  const [error, setError] = useState<string | null>(null);

  const chosenRole = ROLES.find((r) => r.key === role) ?? ROLES[0];
  const chosenStance = STANCES.find((s) => s.key === stance) ?? STANCES[0];
  const name = them.trim() || "them";

  /* Measured in the browser, exactly like an export. Nothing pasted here is
     uploaded except the excerpt and the statistics. */
  function measure(): { samples: string; metrics: string } {
    if (!quoted.trim()) return { samples: "", metrics: "" };
    try {
      const parsed = parseTranscript(quoted, them.trim() || "them");
      const speaker = parsed.participants[0]?.name;
      if (!speaker) return { samples: "", metrics: "" };
      const style = styleOf(parsed.messages, speaker);
      return { samples: sampleWindows(parsed.messages, speaker), metrics: style.text };
    } catch {
      return { samples: "", metrics: "" };
    }
  }

  /* Look them up (once -- a rebuild after pasting an interview reuses what
     was found), then write the profile from it. */
  async function build(from: Step, pickedName?: string) {
    setError(null);
    setCandidates([]);
    setStep("working");

    let who = (pickedName ?? them).trim();
    let found = { research, knownFor, sources, fictional };
    if (!research) {
      setPhase("search");
      try {
        const res = await fetch("/api/persona/research", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ them: who, era: era.trim() || undefined }),
        });
        const data = await res.json();
        if (res.status === 422) { setError(data.error); setStep(from); return; }
        /* Several people by that name and no obvious one: ask. */
        if (res.status === 409) {
          setError(data.error);
          setCandidates(data.candidates ?? []);
          setStep(from);
          return;
        }
        /* Any other failure is not fatal: the build still works from what the
           model knows, as it did before search existed. */
        if (res.ok) {
          found = {
            research: data.research ?? "",
            knownFor: data.knownFor ?? "",
            sources: data.sources ?? [],
            fictional: Boolean(data.fictional),
          };
          setResearch(found.research);
          setKnownFor(found.knownFor);
          setSources(found.sources);
          setFictional(found.fictional);
          setMinor(data.minor !== false);
          /* "sharukh khan", or शाहरुख़ खान, becomes the name as it is spelt. */
          if (data.fullName) { who = data.fullName; setThem(data.fullName); }
        }
      } catch { /* fall through to building from memory */ }
    }

    setPhase("write");
    const { samples, metrics } = measure();
    try {
      const res = await fetch("/api/persona/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          them: who,
          you: you.trim(),
          relationship: found.knownFor || chosenRole.rel,
          mode: found.fictional ? "fictional" : "figure",
          arch: chosenRole.arch,
          texture: chosenStance.texture,
          era: era.trim() || undefined,
          research: found.research || undefined,
          quoted: quoted.trim() || undefined,
          extra: extra.trim() || undefined,
          samples: samples || undefined,
          metrics: metrics || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Couldn't build them."); setStep(from); return; }
      setBrief(data.brief);
      setLines(data.lines ?? "");
      setStep("review");
    } catch {
      setError("Couldn't reach the server. Nothing you wrote was lost.");
      setStep(from);
    }
  }

  function finish() {
    const { samples, metrics } = measure();
    onCreate({
      them: them.trim(),
      you: you.trim(),
      relationship: chosenRole.rel,
      arch: chosenRole.arch,
      texture: chosenStance.texture,
      mode: fictional ? "fictional" : "figure",
      ...(fictional ? { minor } : {}),
      brief: brief.trim(),
      /* Real material when there is any, the reconstruction otherwise, and the
         flag says which so the prompt can label it honestly. */
      samples: samples || lines.trim() || undefined,
      metrics: metrics || undefined,
      verbatim: samples ? true : !lines.trim(),
      extra: extra.trim() || undefined,
      interests: knownFor.trim() || undefined,
    });
  }

  const chip = (on: boolean) =>
    on ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined;
  const label = { display: "block", fontSize: "0.72rem", color: "var(--faint)", marginBottom: "0.5rem" } as const;

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">{fictional ? "A character from a story" : "Someone in public life"}</p>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
      </header>

      {step === "who" && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Who?</h1>
          <p className="lede">
            An actor, a singer, a player, a creator, a founder — anyone whose life is public, or a
            character from a film, show, book or game. Type the name and they get looked up: how
            they talk, what they joke about, what they keep coming back to. It is a portrayal, not
            them, and it will say so if you ask.
          </p>

          <div className="pair">
            <label className="field">
              <span>Their name</span>
              <input className="input" autoFocus value={them} maxLength={60}
                onChange={(e) => { setThem(e.target.value); setCandidates([]); }} placeholder="Shah Rukh Khan"
                onKeyDown={(e) => { if (e.key === "Enter" && them.trim() && you.trim()) void build("who"); }} />
            </label>
            <label className="field">
              <span>Your name</span>
              <input className="input" value={you} maxLength={60}
                onChange={(e) => setYou(e.target.value)} placeholder="Piyush" />
            </label>
          </div>

          <label className="field">
            <span>Which version of them? (optional)</span>
            <input className="input" value={era} maxLength={120}
              onChange={(e) => setEra(e.target.value)} placeholder="in interviews, recent years" />
          </label>

          {error && <p className={candidates.length ? "lede" : "error"} role="alert">{error}</p>}

          {candidates.length > 0 && (
            <div className="tags" style={{ marginTop: "0.5rem" }}>
              {candidates.map((c) => (
                <button key={c.name} type="button" className="tag" disabled={!you.trim()}
                  onClick={() => { setThem(c.name); void build("who", c.name); }}>
                  {c.name}{c.knownFor ? <span className="fine"> · {c.knownFor}</span> : null}
                </button>
              ))}
            </div>
          )}

          <div className="row" style={{ marginTop: "1.25rem" }}>
            <button className="btn" disabled={!them.trim() || !you.trim()} onClick={() => build("who")}>
              {them.trim() ? `Build ${them.trim()}` : "Build them"}
            </button>
            {!you.trim() && them.trim() && <span className="fine">And your name — it&apos;s what they&apos;ll call you.</span>}
          </div>
        </>
      )}

      {step === "working" && (
        <div style={{ marginTop: "3rem" }}>
          <h1 className="display" style={{ fontSize: "1.6rem" }}>
            {phase === "search" ? `Looking ${name} up…` : `Writing how ${name} talks…`}
          </h1>
          <p className="lede">
            {phase === "search"
              ? "Searching interviews, appearances and coverage. This takes a few seconds."
              : quoted.trim()
                ? "Measuring what you pasted, then writing the profile."
                : "Turning what was found into how they speak."}
          </p>
        </div>
      )}

      {step === "review" && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Is this {name}?</h1>
          <p className="lede">
            {knownFor ? `${knownFor}. ` : ""}Cut anything that is wrong — you know how they come
            across better than a search does.
          </p>

          <label className="field">
            <span>How they talk</span>
            <textarea className="input" rows={11} value={brief} maxLength={6000}
              onChange={(e) => setBrief(e.target.value)} />
          </label>

          {lines.trim() && (
            <>
              <label className="field" style={{ marginTop: "1.25rem" }}>
                <span>Lines in their register</span>
                <textarea className="input" rows={7} value={lines} maxLength={14000}
                  onChange={(e) => setLines(e.target.value)} />
              </label>
              <p className="fine" style={{ marginTop: "-0.5rem" }}>
                Written to show the rhythm — <strong>these are not quotes</strong>, and {name} will
                not repeat them back as if they were.
              </p>
            </>
          )}

          {sources.length > 0 && (
            <p className="fine" style={{ marginTop: "0.75rem" }}>
              Looked up from{" "}
              {sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && ", "}
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="inline-link">{s.title}</a>
                </span>
              ))}
              .
            </p>
          )}

          <div className="field" style={{ marginTop: "1.5rem" }}>
            <span style={label}>What are they to you?</span>
            <div className="tags">
              {ROLES.map((r) => (
                <button key={r.key} type="button" className="tag" aria-pressed={role === r.key}
                  onClick={() => setRole(r.key)} style={chip(role === r.key)}>{r.label}</button>
              ))}
            </div>
          </div>

          {/* Press or not is a real person's question. A character is just themselves. */}
          {!fictional && <div className="field" style={{ marginTop: "1rem" }}>
            <span style={label}>How open they are with you</span>
            <div className="tags">
              {STANCES.map((st) => (
                <button key={st.key} type="button" className="tag" aria-pressed={stance === st.key}
                  onClick={() => setStance(st.key)} style={chip(stance === st.key)}>{st.label}</button>
              ))}
            </div>
            <p className="fine" style={{ marginTop: "0.6rem" }}>{chosenStance.note}.</p>
          </div>}

          <label className="field" style={{ marginTop: "1rem" }}>
            <span>Anything else about how they come across? (optional)</span>
            <textarea className="input" rows={3} value={extra} maxLength={4000}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="never takes a compliment, turns it into a joke about himself" />
          </label>

          <p className="fine">
            {fictional
              ? minor
                ? `${name} talks from inside their own story. They are a child in it, so this never becomes a romance.`
                : `${name} talks from inside their own story, and knows they are a character if you ask.`
              : "They will talk about their work and how they think, at whatever length you want. They will not invent things about their private life, and this never becomes a romance."}
          </p>

          <div className="row" style={{ marginTop: "1.5rem" }}>
            <button className="btn" disabled={!brief.trim()} onClick={finish}>Talk to {name}</button>
            <button className="link-btn" onClick={() => setStep("material")}>{fictional ? "Add some of their lines" : "Add an interview"}</button>
          </div>
        </>
      )}

      {step === "material" && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Anything they actually said?</h1>
          <p className="lede">
            {fictional
              ? <>A scene, a stretch of script, subtitles off an episode. Paste it and {name} gets measured from how they really talk, on top of what the search found.</>
              : <>An interview transcript, a Q&amp;A, even auto-captions off a video. Paste it and {name} gets measured from how they really talk, on top of what the search found.</>}
          </p>

          <label className="field">
            <span>Something they actually said</span>
            <textarea className="input" rows={9} value={quoted} maxLength={20000}
              onChange={(e) => setQuoted(e.target.value)}
              placeholder={"Interviewer: What did failure teach you?\nSRK: Nobody is coming, yaar. You get up or you don't."} />
          </label>

          {error && <p className="error" role="alert">{error}</p>}

          <div className="row" style={{ marginTop: "1.5rem" }}>
            <button className="btn" disabled={!quoted.trim()} onClick={() => build("material")}>Rebuild {name}</button>
            <button className="link-btn" onClick={() => setStep("review")}>Back</button>
          </div>
        </>
      )}
    </main>
  );
}
