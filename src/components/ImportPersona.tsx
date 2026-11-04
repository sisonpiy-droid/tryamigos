"use client";

import { useEffect, useRef, useState } from "react";

import {
  UnreadableExport, parseText, readExportFile, sampleWindows, styleOf,
  type ParsedChat,
} from "@/lib/chat-import";
import { ARCHETYPES, MODES, PROMPTS, TEXTURES, detectArch, type PersonaDraft } from "@/lib/presence/persona";

/* Building someone, exactly as Presence did it.
 *
 * Four steps and a refusal screen, in Presence's order and with its questions:
 *
 *   0  the two of you        names, what they were, what they called you
 *   1  what kind it was      archetype, texture, mode, and consent if living
 *   9  the refusal           a living person who has not agreed
 *   2  how they wrote        a chat export, pasted messages, and what they were like
 *   3  five things           the specific prompts that make a voice
 *
 * The five prompts on the last step do more work than anything else here. "How
 * did they greet you?" answered with "there she is — every single time" gives a
 * model something to actually do; three paragraphs of adjectives do not.
 *
 * The whole export is parsed and measured in this browser. Only a sampled
 * excerpt and the statistics are sent on.
 */

type Step = 0 | 1 | 2 | 3 | 9 | 10 | 11; // 10 = building, 11 = review

/* Which participant is the one being built.
 *
 * This used to be `participants.find(p => p.name !== draft.you)`, against a
 * list sorted by message count. Export labels are profile push-names, address
 * book entries or bare phone numbers, so they are almost never character-equal
 * to the first name someone types into a free-text box -- which meant the test
 * failed, the fallback took participants[0], and in a couple's export that is
 * whichever of the two sent more messages. Roughly half the time that is the
 * user, and the result is a character called Aditi measured from, and told to
 * copy the texture of, the user's own writing. It is invisible afterwards: the
 * brief reads plausibly because it describes a real person.
 *
 * It is also permanent. `metrics` is injected into every system prompt as
 * "these are counts, not impressions. Match them", and nothing in the edit
 * screen exposes it, so the only repair is deleting the character and losing
 * everything they remember.
 *
 * So: match on who we are looking FOR, not who we are ruling out, and return
 * null rather than guessing when no label looks like either name.
 */
export const nameKey = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

export function guessParticipant(
  participants: { name: string; count: number }[],
  them: string,
  you: string
): string | null {
  if (!participants.length) return null;
  const theirs = nameKey(them);
  const yours = nameKey(you);
  const shares = (label: string, tokens: string[]) => {
    const l = nameKey(label);
    return tokens.some((t) => t.length > 1 && l.some((x) => x === t || x.startsWith(t) || t.startsWith(x)));
  };

  // Someone whose label looks like the name we were given.
  const byName = participants.find((p) => shares(p.name, theirs));
  if (byName) return byName.name;

  /* Nobody matches. If exactly one participant is clearly NOT the user, it is
     them by elimination -- the usual two-person export. */
  const notYou = participants.filter((p) => !shares(p.name, yours));
  if (notYou.length === 1) return notYou[0].name;

  /* Otherwise this is a guess, and a wrong guess here is baked in forever.
     Better to ask. */
  return null;
}

/* The same caps /api/persona/build enforces.
 *
 * They lived only on the server, so the samples box -- a plain textarea people
 * paste into -- accepted a whole export and then failed validation at the very
 * end, after every other step had been filled in, with a message that named no
 * field. The limit belongs where the typing happens. */
const MAX_SAMPLES = 14000;
const MAX_EXTRA = 4000;
const MAX_PROMPT = 400;

/* The wizard's own state, kept across a reload.
 *
 * Everything typed across four steps -- and the generated brief, which costs
 * fifteen seconds and a model call -- lived only in React state. A refresh, an
 * accidental back gesture or a phone dropping the tab lost all of it with no
 * warning, and the only way forward was to start again from the first screen.
 *
 * sessionStorage rather than localStorage on purpose: this is scratch work for
 * one sitting, not something to find waiting weeks later. The parsed export is
 * deliberately not kept -- it is large, and the file is still on the device. */
const DRAFT_KEY = "muse.import-draft/1";

function loadDraft(): PersonaDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as PersonaDraft) : null;
  } catch {
    return null;
  }
}

export function ImportPersona({
  onCreate,
  onCancel,
  /* Pre-set when the user came through a door that already answered the
     question. Inventing someone lived behind "From a chat export" -> step 1 ->
     "Someone I made up", which is an odd place to look for it and meant the
     wizard opened by asking for a file that does not exist. */
  startMode,
}: {
  onCreate: (draft: PersonaDraft) => void;
  onCancel: () => void;
  startMode?: string;
}) {
  const [step, setStep] = useState<Step>(0);
  const [draft, setDraft] = useState<PersonaDraft>(() => loadDraft() ?? {
    them: "", you: "", relationship: "", callsYou: "",
    arch: "other", texture: "close", mode: startMode ?? "", consent: null,
    samples: "", extra: "", metrics: "", prompts: {},
  });
  const [parsed, setParsed] = useState<ParsedChat | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [nudge, setNudge] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  /* Reading, parsing and measuring a real export all run on the main thread, so
     a large one froze the tab with nothing on screen to say why. */
  const [reading, setReading] = useState(false);
  /* Whether the samples box holds something the user typed. Picking a
     participant fills it from the export, and used to do so unconditionally --
     silently throwing away anything written by hand first. */
  const [samplesTouched, setSamplesTouched] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState("");
  const filePick = useRef<HTMLInputElement>(null);

  /* Written on every change rather than at step boundaries -- a reload does not
     wait for one. Failures are ignored: not being able to keep scratch work is
     not worth an error in front of someone mid-setup. */
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* not worth reporting */ }
  }, [draft]);

  /* Cleared once the wizard is done with, either way. Leaving it behind would
     mean the next person built starts pre-filled with the last one's answers. */
  const forgetDraft = () => {
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nothing to do */ }
  };

  const D = (k: keyof PersonaDraft, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const P = (k: string, v: string) => setDraft((d) => ({ ...d, prompts: { ...d.prompts, [k]: v } }));

  function readFailure(e: unknown) {
    if (e instanceof UnreadableExport) {
      setError(e.message);
      setHint(e.sampleLine ? `The first line looks like:  ${e.sampleLine}` : null);
    } else {
      setError(e instanceof Error ? e.message : "Couldn't read that.");
      setHint(null);
    }
  }

  /* WhatsApp exports are text; anything this size is a mistake, and trying to
     parse it locks the tab for long enough to look like a crash. */
  const MAX_EXPORT_BYTES = 40 * 1024 * 1024;

  async function onFile(file: File) {
    setError(null); setHint(null);
    if (file.size > MAX_EXPORT_BYTES) {
      setError(
        `That file is ${Math.round(file.size / 1_048_576)}MB, which is too big to read in the browser. Export a shorter date range, or choose "without media" when WhatsApp asks.`
      );
      return;
    }
    setReading(true);
    /* Yield a frame so the busy state paints before the main thread is taken. */
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = await readExportFile(file);
      setParsed(result);
      const guess = guessParticipant(result.participants, draft.them, draft.you);
      if (guess) choosePerson(result, guess);
    } catch (e) { readFailure(e); }
    finally { setReading(false); }
  }

  function onPasteExport() {
    setError(null); setHint(null);
    try {
      const result = parseText(pasted);
      setParsed(result);
      const guess = guessParticipant(result.participants, draft.them, draft.you);
      if (guess) choosePerson(result, guess);
      setPasteMode(false);
    } catch (e) { readFailure(e); }
  }

  /* Measuring happens here. Only the report and the sampled excerpt go on. */
  function choosePerson(result: ParsedChat, name: string) {
    setPicked(name);
    const style = styleOf(result.messages, name);
    setDraft((d) => ({
      ...d,
      /* Anything typed by hand outperforms a sample, and replacing it without
         asking loses work the user cannot get back. */
      samples: samplesTouched ? d.samples : sampleWindows(result.messages, name),
      metrics: style.text,
      them: d.them?.trim() ? d.them : name,
    }));
  }

  async function build() {
    setStep(10);
    setError(null);
    try {
      const res = await fetch("/api/persona/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          them: draft.them, you: draft.you, relationship: draft.relationship,
          callsYou: draft.callsYou || undefined,
          arch: draft.arch, texture: draft.texture, mode: draft.mode, consent: draft.consent,
          samples: draft.samples || undefined,
          extra: draft.extra || undefined,
          metrics: draft.metrics || undefined,
          prompts: draft.prompts,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Couldn't build the profile."); setStep(3); return; }
      setBrief(data.brief);
      setStep(11);
    } catch {
      setError("Couldn't reach the server. Nothing you wrote was lost.");
      setStep(3);
    }
  }

  const chip = (on: boolean) =>
    on ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined;

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Presence</p>
        <button
          className="link-btn"
          onClick={() => {
            const started = draft.them.trim() || draft.samples?.trim() || brief.trim();
            if (started && !confirm("Leave this? What you have filled in will be lost.")) return;
            forgetDraft();
            onCancel();
          }}
        >
          Cancel
        </button>
      </header>

      {step < 4 && (
        <div style={{ height: 2, background: "var(--edge)", borderRadius: 999, margin: "1.5rem 0 2.5rem", overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${((step + 1) / 4) * 100}%`, background: "var(--accent)", transition: "width 320ms var(--ease)" }} />
        </div>
      )}

      {/* ---------------------------------------------------------- step 0 */}
      {step === 0 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>The two of you</h1>
          <p className="lede">Their name is what they&apos;ll answer to. Yours is what they&apos;ll call you. Gender is optional; it just gets the pronouns and the Hindi grammar right.</p>

          <div className="pair">
            <label className="field">
              <span>Their name</span>
              <input className="input" autoFocus value={draft.them} placeholder="John" maxLength={60}
                onChange={(e) => D("them", e.target.value)} />
            </label>
            <label className="field">
              <span>Your name</span>
              <input className="input" value={draft.you} placeholder="Sam" maxLength={60}
                onChange={(e) => D("you", e.target.value)} />
            </label>
          </div>

          <div className="pair">
            {([["gender", "Their gender"], ["youGender", "Your gender"]] as const).map(([k, label]) => (
              <div className="field" key={k}>
                <span>{label}</span>
                <div className="tags" role="group" aria-label={label}>
                  {([["male", "Male"], ["female", "Female"], ["nonbinary", "Non-binary"]] as const).map(([v, text]) => (
                    <button key={v} type="button" className="tag" aria-pressed={draft[k] === v}
                      onClick={() => D(k, draft[k] === v ? undefined : v)} style={chip(draft[k] === v)}>{text}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="pair">
            <label className="field">
              <span>They were</span>
              <input className="input" value={draft.relationship} placeholder="my father" maxLength={120}
                onChange={(e) => setDraft((d) => ({ ...d, relationship: e.target.value, arch: detectArch(e.target.value) }))} />
            </label>
            <label className="field">
              <span>They called you</span>
              <input className="input" value={draft.callsYou ?? ""} placeholder="kiddo" maxLength={60}
                onChange={(e) => D("callsYou", e.target.value)} />
            </label>
          </div>

          <div className="row" style={{ marginTop: "1rem" }}>
            <button className="btn" onClick={() => {
              if (!draft.them.trim() || !draft.you.trim()) {
                setNudge(!draft.them.trim() && !draft.you.trim() ? "Both names first."
                  : !draft.them.trim() ? "Their name first." : "Your name first.");
                return;
              }
              setNudge("");
              /* Step 1 asks who this is and whether they consented. Someone who
                 came through the "make someone up" door has answered both, so
                 asking again is a screen that only has one possible answer. */
              setStep(startMode ? 2 : 1);
            }}>Next</button>
            {nudge && <span className="error" style={{ margin: 0 }}>{nudge}</span>}
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- step 1 */}
      {step === 1 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>
            What kind of {draft.relationship?.trim() ? "relationship" : "person"} was it?
          </h1>
          <p className="lede">Three taps. This changes how they talk to you more than anything else here.</p>

          <div className="field">
            <span>{draft.them || "They"} was your</span>
            <div className="tags">
              {Object.entries(ARCHETYPES).map(([k, v]) => (
                <button key={k} type="button" className="tag" aria-pressed={draft.arch === k}
                  onClick={() => D("arch", k)} style={chip(draft.arch === k)}>{v.label}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>And honestly, between you</span>
            <div className="tags">
              {Object.entries(TEXTURES).map(([k, v]) => (
                <button key={k} type="button" className="tag" aria-pressed={draft.texture === k}
                  onClick={() => D("texture", k)} style={chip(draft.texture === k)}>{v.label}</button>
              ))}
            </div>
            <p className="fine" style={{ marginTop: "0.8rem" }}>
              Answer this one truthfully. If it was difficult, saying so gets you a truer version of
              them than picking the kind answer does.
            </p>
          </div>

          <div className="field">
            <span>Who is {draft.them || "this"}?</span>
            <div className="tags">
              {Object.entries(MODES).filter(([k]) => k !== "fictional").map(([k, v]) => (
                <button key={k} type="button" className="tag" aria-pressed={draft.mode === k}
                  onClick={() => setDraft((d) => ({ ...d, mode: k, consent: null }))}
                  style={chip(draft.mode === k)}>{v.label}</button>
              ))}
            </div>
          </div>

          {draft.mode === "living" && (
            <div className="field">
              <span>Does {draft.them || "they"} know you&apos;re building this?</span>
              <div className="tags">
                <button type="button" className="tag" aria-pressed={draft.consent === true}
                  onClick={() => D("consent", true)} style={chip(draft.consent === true)}>
                  They know and they&apos;re fine with it
                </button>
                <button type="button" className="tag" aria-pressed={draft.consent === false}
                  onClick={() => D("consent", false)}
                  style={draft.consent === false ? { borderColor: "var(--danger)", color: "var(--danger)" } : undefined}>
                  They don&apos;t know
                </button>
              </div>
              <p className="fine" style={{ marginTop: "0.8rem" }}>
                A living person can object to a version of themselves. Asking them first is the whole
                difference.
              </p>
            </div>
          )}

          <div className="row" style={{ marginTop: "1rem" }}>
            <button className="btn" onClick={() => {
              if (!draft.mode) { setNudge("Pick who this is, first."); return; }
              if (draft.mode === "living" && draft.consent === null) { setNudge("Answer the question above."); return; }
              setNudge("");
              setStep(draft.mode === "living" && !draft.consent ? 9 : 2);
            }}>Next</button>
            <button className="link-btn" onClick={() => { setNudge(""); setStep(0); }}>Back</button>
            {nudge && <span className="error" style={{ margin: 0 }}>{nudge}</span>}
          </div>
        </>
      )}

      {/* ------------------------------------------------- step 9: refusal */}
      {step === 9 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Then not this one.</h1>
          <p className="lede">
            Someone still living can object to a version of themselves, and this one would be built
            entirely out of things they said to you privately. Ask them. If they say yes, come back
            and it&apos;s yours.
          </p>
          <p className="lede">
            If asking isn&apos;t possible because of how things ended, that&apos;s worth sitting with. A
            version of someone who has moved on, kept available to you at 2am, tends to hold a thing
            open rather than close it.
          </p>
          <div className="row" style={{ marginTop: "2rem" }}>
            <button className="btn-ghost" onClick={() => setStep(1)}>Go back</button>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- step 2 */}
      {step === 2 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>How did {draft.them || "they"} write?</h1>
          <p className="lede">
            {draft.mode === "character"
              ? "Nothing to import for someone invented — write a few lines the way you imagine they'd text, and skip on."
              : "Upload a WhatsApp export and this reads how they actually wrote — message length, punctuation, whether they sent four in a row instead of one. Things nobody can describe about someone."}
          </p>

          {draft.mode !== "character" && (
            <>
              <input ref={filePick} id="chat-file" type="file" accept=".txt,.zip" className="sr-only"
                onChange={(e) => {
                const f = e.target.files?.[0];
                /* Cleared so picking the same file again still fires a change
                   event. Without it a failed read could not be retried with the
                   same export at all -- the control simply did nothing. */
                e.target.value = "";
                if (f) onFile(f);
              }} />
              <div className="row">
                <button className="btn-ghost" onClick={() => filePick.current?.click()} disabled={reading}>
                  {reading ? "Reading…" : "Choose the export"}
                </button>
                <button className="link-btn" onClick={() => { setPasteMode(!pasteMode); setError(null); }}>
                  {pasteMode ? "Hide" : "Paste the text instead"}
                </button>
              </div>
              <p className="fine" style={{ marginTop: "0.7rem" }}>
                In WhatsApp: open the chat, tap the name, Export chat, Without media. The .zip or .txt
                goes straight in, and never leaves this device.
              </p>

              {pasteMode && (
                <div style={{ marginTop: "1rem" }}>
                  <textarea className="input" rows={8} value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    placeholder={"03/02/2023, 08:12 - Dad: morning love"}
                    style={{ fontFamily: "monospace", fontSize: "0.8rem" }} />
                  <button className="btn-ghost" style={{ marginTop: "0.6rem" }}
                    onClick={onPasteExport} disabled={pasted.trim().length < 20}>Read it</button>
                </div>
              )}

              {error && (
                <div style={{ marginTop: "1rem" }}>
                  <p className="error" role="alert">{error}</p>
                  {hint && <p className="fine" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{hint}</p>}
                  <p className="fine">Exports differ between phones and languages. Pasting works when the file doesn&apos;t.</p>
                </div>
              )}

              {parsed && (
                <div style={{ marginTop: "1.25rem" }}>
                  <p
                    className="fine"
                    style={!picked ? { marginBottom: "0.5rem", color: "var(--accent)" } : { marginBottom: "0.5rem" }}
                  >
                    {parsed.messages.length.toLocaleString()} messages read.{" "}
                    {picked
                      ? `Which one is ${draft.them || "them"}?`
                      : `Which of these is ${draft.them || "them"}? Pick one — this decides whose writing gets copied.`}
                  </p>
                  <div className="tags">
                    {(showAll ? parsed.participants : parsed.participants.slice(0, 8)).map((p) => (
                      <button key={p.name} type="button" className="tag" aria-pressed={picked === p.name}
                        onClick={() => choosePerson(parsed, p.name)} style={chip(picked === p.name)}>
                        {p.name} · {p.count.toLocaleString()}
                      </button>
                    ))}
                  </div>

                  {/* A group export can have thirty people in it, and the one
                      you came for is not always among the eight loudest. */}
                  {!showAll && parsed.participants.length > 8 && (
                    <button
                      className="link-btn"
                      style={{ marginTop: "0.5rem" }}
                      onClick={() => setShowAll(true)}
                    >
                      Show all {parsed.participants.length}
                    </button>
                  )}

                  {/* Lines that looked like messages and could not be read.
                      They are skipped rather than folded into the message above,
                      and saying so beats letting a half-understood export pass
                      as a whole one. */}
                  {parsed.unreadable > 0 && (
                    <p className="fine" style={{ marginTop: "0.6rem" }}>
                      {parsed.unreadable.toLocaleString()}{" "}
                      {parsed.unreadable === 1 ? "line" : "lines"} couldn&apos;t be read and{" "}
                      {parsed.unreadable === 1 ? "was" : "were"} skipped
                      {parsed.unreadable > parsed.messages.length / 10
                        ? " — that is a lot, so this export may be in a format this doesn't fully understand yet."
                        : "."}
                    </p>
                  )}

                  {picked && draft.metrics && (
                    <>
                      <p className="fine" style={{ marginTop: "0.8rem", color: "var(--accent)" }}>
                        Read how {picked} writes. {draft.metrics.split("\n")[1] ?? ""}
                      </p>
                      {/* The wrong pick here is unrecoverable -- the measured
                          statistics go into every future prompt and no screen
                          can edit them -- so a mismatch is worth saying out
                          loud rather than leaving in a small grey line. */}
                      {!nameKey(picked).some((t) =>
                        nameKey(draft.them).some((x) => x === t || x.startsWith(t) || t.startsWith(x))
                      ) && (
                        <p className="error" style={{ marginTop: "0.4rem" }}>
                          That doesn&apos;t look like {draft.them || "them"}. Check you haven&apos;t picked
                          yourself — whoever is selected here is who {draft.them || "they"} will write like,
                          and it can&apos;t be changed later.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          <div className="field" style={{ marginTop: "2rem" }}>
            <span>Or paste some of their messages</span>
            <textarea className="input" rows={6} value={draft.samples ?? ""}
              placeholder={"are you up\ni've got the crossword out\n7 down is beating me\nDAD"}
              maxLength={MAX_SAMPLES}
              onChange={(e) => { setSamplesTouched(true); D("samples", e.target.value); }} />
            <p className="fine" style={{ marginTop: "0.7rem" }}>
              This teaches them how to write. Optional.
              {(draft.samples?.length ?? 0) > MAX_SAMPLES * 0.9 && (
                <>
                  {" "}
                  <strong style={{ color: "var(--accent)" }}>
                    {draft.samples?.length}/{MAX_SAMPLES} characters
                  </strong>{" "}
                  — a spread of their messages teaches more than one long stretch does.
                </>
              )}
            </p>
          </div>

          <div className="field">
            <span>What was {draft.them || "they"} like?</span>
            <textarea className="input" rows={7} value={draft.extra ?? ""} maxLength={MAX_EXTRA}
              placeholder={"stubborn about being right. hated being fussed over. suspicious of anyone too cheerful. never asked a direct question when a sideways one would do. could talk about football for hours."}
              onChange={(e) => D("extra", e.target.value)} />
            <p className="fine" style={{ marginTop: "0.7rem" }}>
              This teaches them who to be, and it matters more than the messages do. Write behaviour
              rather than adjectives — &quot;hated being fussed over&quot; gives them something to do,
              &quot;kind&quot; does not. Name what they could talk about for hours and they will bring it
              up themselves.
            </p>
          </div>

          <div className="row" style={{ marginTop: "1.5rem" }}>
            {/* An export that was read but whose speaker was never chosen would
                otherwise go on to build a character with no samples and no
                measurements at all, which succeeds and produces a generic
                person wearing the right name. */}
            <button
              className="btn"
              onClick={() => {
                if (parsed && !picked) { setNudge(`Pick which one is ${draft.them || "them"} first.`); return; }
                setNudge(""); setStep(3);
              }}
            >
              Next
            </button>
            <button className="link-btn" onClick={() => { setNudge(""); setStep(startMode ? 0 : 1); }}>Back</button>
            {nudge && <span className="error" style={{ margin: 0 }}>{nudge}</span>}
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- step 3 */}
      {step === 3 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Five things, if you know them</h1>
          <p className="lede">Skip any of these. Half-answered is fine.</p>

          {PROMPTS.map((pr) => (
            <label key={pr.k} className="field">
              <span>{pr.q}</span>
              <textarea id={`q-${pr.k}`} className="input" rows={1} value={draft.prompts?.[pr.k] ?? ""}
                maxLength={MAX_PROMPT}
                placeholder={pr.h} onChange={(e) => P(pr.k, e.target.value)} />
            </label>
          ))}

          {error && <p className="error" role="alert">{error}</p>}

          <div className="row" style={{ marginTop: "2rem" }}>
            <button className="btn" onClick={build}>Build {draft.them || "them"}</button>
            <button className="link-btn" onClick={() => setStep(2)}>Back</button>
          </div>
        </>
      )}

      {step === 10 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Reading how {draft.them} wrote…</h1>
          <p className="lede">This takes a few seconds.</p>
          <p className="typing">working<i>.</i><i>.</i><i>.</i></p>
        </>
      )}

      {/* --------------------------------------------------------- review */}
      {step === 11 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Is this {draft.them}?</h1>
          <p className="lede">Fix anything that&apos;s off. This is what they&apos;ll act from, and you know them.</p>
          <textarea className="input" rows={16} value={brief}
            onChange={(e) => setBrief(e.target.value)}
            style={{ fontFamily: "var(--serif)", lineHeight: 1.6, fontSize: "1rem" }} />
          <div className="row" style={{ marginTop: "1.25rem" }}>
            <button className="btn" disabled={!brief.trim()}
              onClick={() => { forgetDraft(); onCreate({ ...draft, brief }); }}>Talk to {draft.them}</button>
            <button className="link-btn" onClick={() => setStep(2)}>Add more material</button>
          </div>
        </>
      )}
    </main>
  );
}
