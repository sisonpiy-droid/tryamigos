"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar } from "@/components/Avatar";

/* §Screen 5 — Create a Muse.
 *
 * Four steps, not seven. §Principle 4 puts creation at one to three minutes and
 * asks for progressive disclosure, so communication style sits behind a
 * disclosure rather than owning a screen of its own, and behaviour keeps its
 * safe defaults (proactive off, §61) instead of asking someone to configure
 * quiet hours before they have said a word to this person.
 *
 * Voice (§Step 6) is skipped: there is no speech feature in this build.
 */

const RELATIONSHIPS = ["friend", "mentor", "coach", "partner", "teacher", "character", "family", "other"];

const TRAITS = [
  "funny", "calm", "ambitious", "sarcastic", "caring", "direct",
  "curious", "optimistic", "serious", "playful", "blunt", "gentle",
];

const TONES = ["warm", "dry", "bright", "steady", "intense", "soft"];
const LENGTHS = ["short", "medium", "long"];
const LANGUAGES = ["English", "Hindi", "Hinglish", "Spanish", "French", "German", "Portuguese"];

type Step = 0 | 1 | 2 | 3;

export default function CreateWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nudge, setNudge] = useState("");
  const [showStyle, setShowStyle] = useState(false);

  const [name, setName] = useState("");
  const [relationshipType, setRelationshipType] = useState("friend");
  const [description, setDescription] = useState("");
  const [traits, setTraits] = useState<string[]>([]);
  const [customInstructions, setCustomInstructions] = useState("");
  const [tone, setTone] = useState("");
  const [sentenceLength, setSentenceLength] = useState("");
  const [languages, setLanguages] = useState<string[]>(["English"]);
  const [memoryText, setMemoryText] = useState("");

  /* Functional update, not a read of the current render's array. React batches
     state, so two taps in the same tick would both see the old list and the
     second would overwrite the first -- selecting three traits quickly kept
     only the last one. */
  const toggle = (
    set: React.Dispatch<React.SetStateAction<string[]>>,
    value: string,
    max = 99
  ) => {
    set((list) => {
      if (list.includes(value)) return list.filter((v) => v !== value);
      return list.length < max ? [...list, value] : list;
    });
  };

  function next() {
    if (step === 0) {
      if (!name.trim()) return setNudge("They need a name.");
      if (!description.trim()) return setNudge("One line about who they are.");
    }
    if (step === 1 && traits.length === 0) return setNudge("Pick at least one.");
    setNudge("");
    setStep((step + 1) as Step);
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);

    const seedMemories = memoryText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 10);

    try {
      const res = await fetch("/api/muses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          relationshipType,
          languages,
          traits,
          customInstructions: customInstructions.trim() || undefined,
          tone: tone || undefined,
          sentenceLength: sentenceLength || undefined,
          seedMemories,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't create them.");
        setBusy(false);
        return;
      }

      // Straight into the conversation. §2's loop is create → talk, and a
      // "success" screen in between is a step that exists for nobody.
      const convo = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ museId: data.muse.id }),
      });
      if (convo.ok) {
        const { conversation } = await convo.json();
        router.push(`/muses/${conversation.id}`);
        return;
      }
      router.push("/");
    } catch {
      setError("Couldn't reach the server.");
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">New Amigo</p>
        <Link href="/" className="link-btn" style={{ textDecoration: "none" }}>Cancel</Link>
      </header>

      <div
        className="progress"
        role="progressbar"
        aria-valuenow={step + 1}
        aria-valuemin={1}
        aria-valuemax={4}
        aria-label="Creation progress"
        style={{ height: 2, background: "var(--edge)", borderRadius: 999, margin: "1.5rem 0 2rem", overflow: "hidden" }}
      >
        <i style={{ display: "block", height: "100%", width: `${((step + 1) / 4) * 100}%`, background: "var(--accent)", transition: "width 320ms var(--ease)" }} />
      </div>

      {step === 0 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>Who are they?</h1>
          <p className="lede">A name, and one line you&apos;d use to describe them to a friend.</p>

          <label className="field">
            <span>Their name</span>
            <input className="input" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Maya" />
          </label>

          <label className="field">
            <span>In one line</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="My brutally honest best friend who never lets me off the hook."
            />
          </label>

          <div className="field">
            <span style={{ display: "block", fontSize: "0.75rem", color: "var(--faint)", marginBottom: "0.35rem" }}>
              They&apos;re your
            </span>
            <div className="tags">
              {RELATIONSHIPS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="tag"
                  aria-pressed={relationshipType === r}
                  onClick={() => setRelationshipType(r)}
                  style={relationshipType === r ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>What are they like?</h1>
          <p className="lede">Pick a few. This changes how they talk to you more than anything else here.</p>

          <div className="tags" style={{ marginBottom: "1.5rem" }}>
            {TRAITS.map((t) => (
              <button
                key={t}
                type="button"
                className="tag"
                aria-pressed={traits.includes(t)}
                onClick={() => toggle(setTraits, t, 6)}
                style={traits.includes(t) ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
              >
                {t}
              </button>
            ))}
          </div>

          <label className="field">
            <span>Anything they should always do?</span>
            <textarea
              className="input"
              rows={3}
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="Challenge me when I'm making excuses."
            />
          </label>

          <button type="button" className="link-btn" onClick={() => setShowStyle(!showStyle)}>
            {showStyle ? "Hide" : "How they speak"}
          </button>

          {showStyle && (
            <div style={{ marginTop: "1rem" }}>
              <div className="field">
                <span style={{ display: "block", fontSize: "0.75rem", color: "var(--faint)", marginBottom: "0.35rem" }}>Tone</span>
                <div className="tags">
                  {TONES.map((t) => (
                    <button key={t} type="button" className="tag" aria-pressed={tone === t}
                      onClick={() => setTone(tone === t ? "" : t)}
                      style={tone === t ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>{t}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span style={{ display: "block", fontSize: "0.75rem", color: "var(--faint)", marginBottom: "0.35rem" }}>Message length</span>
                <div className="tags">
                  {LENGTHS.map((l) => (
                    <button key={l} type="button" className="tag" aria-pressed={sentenceLength === l}
                      onClick={() => setSentenceLength(sentenceLength === l ? "" : l)}
                      style={sentenceLength === l ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span style={{ display: "block", fontSize: "0.75rem", color: "var(--faint)", marginBottom: "0.35rem" }}>Languages</span>
                <div className="tags">
                  {LANGUAGES.map((l) => (
                    <button key={l} type="button" className="tag" aria-pressed={languages.includes(l)}
                      onClick={() => toggle(setLanguages, l, 3)}
                      style={languages.includes(l) ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>{l}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>What should they know?</h1>
          <p className="lede">
            A few things about you they&apos;d already know. One per line. They&apos;ll learn the rest as you talk.
          </p>
          <label className="field">
            <span className="sr-only">Things they should know about you</span>
            <textarea
              className="input"
              rows={5}
              value={memoryText}
              onChange={(e) => setMemoryText(e.target.value)}
              placeholder={"I'm preparing for an MBA interview\nI have a dog called Bruno\nI work better in the mornings"}
            />
          </label>
          <p className="fine">You can add, edit or delete anything they know, any time.</p>
        </>
      )}

      {step === 3 && (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem" }}>This is {name || "them"}.</h1>
          <div className="muse-card" style={{ cursor: "default", marginTop: "1rem" }}>
            <Avatar name={name || "?"} large />
            <div style={{ minWidth: 0 }}>
              <h3 style={{ fontSize: "1.1rem" }}>{name}</h3>
              <span className="rel">{relationshipType}</span>
              <p>{description}</p>
              {traits.length > 0 && (
                <div className="tags">
                  {traits.map((t) => <span className="tag" key={t}>{t}</span>)}
                </div>
              )}
            </div>
          </div>

          {customInstructions.trim() && (
            <p className="fine" style={{ marginTop: "1rem" }}>
              They&apos;ll always: {customInstructions.trim()}
            </p>
          )}

          <p className="fine" style={{ marginTop: "1.5rem" }}>
            Only you can see or talk to them. They won&apos;t message you first unless you turn that on.
          </p>

          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}

      <div className="row" style={{ marginTop: "2rem" }}>
        {step < 3 ? (
          <button className="btn" onClick={next}>Next</button>
        ) : (
          <button className="btn" onClick={create} disabled={busy}>
            {busy ? "Creating…" : `Start talking to ${name || "them"}`}
          </button>
        )}
        {step > 0 && (
          <button className="link-btn" onClick={() => { setNudge(""); setStep((step - 1) as Step); }}>
            Back
          </button>
        )}
        {nudge && <span className="error" style={{ margin: 0 }}>{nudge}</span>}
      </div>
    </main>
  );
}
