"use client";

import { useState } from "react";

import { speaker } from "@/lib/voice/speaker";
import { VOICES, voiceById } from "@/lib/voice/voices";

/* Which voice someone speaks in on a call.
 *
 * "Chosen for them" is the default: on their first call a voice is picked from
 * their profile and saved, and it shows here once it has been. Each option can
 * be heard before choosing -- a voice described in words is still a guess. */

export function VoicePicker({
  name,
  value,
  onChange,
}: {
  name: string;
  /** A voice id, or "" for chosen automatically. */
  value: string;
  onChange: (id: string) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function preview(id: string) {
    speaker.unlock();
    speaker.stop();
    setFailed(false);
    setPlaying(id);
    try {
      const res = await fetch("/api/solo/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `Hey, it's ${name || "me"}. Sounds like this, na?`, voice: id }),
      });
      if (!res.ok || !res.body) throw new Error("speak");
      await speaker.enqueue(res.body, Number(res.headers.get("x-sample-rate")) || 24000);
      await speaker.whenIdle();
    } catch {
      setFailed(true);
    } finally {
      setPlaying((cur) => (cur === id ? null : cur));
    }
  }

  const groups: { title: string; range: "higher" | "lower" }[] = [
    { title: "Higher", range: "higher" },
    { title: "Lower", range: "lower" },
  ];

  return (
    <div className="field voice-picker">
      <span className="voice-picker-label">Their voice on a call</span>
      <p className="fine" style={{ margin: "0 0 0.6rem" }}>
        {value ? `${voiceById(value).label} — ${voiceById(value).note}.` : "Chosen to fit them on their first call. Pick one to change it."}
      </p>
      {groups.map((g) => (
        <div key={g.range} className="voice-group">
          <span className="voice-group-title">{g.title}</span>
          <div className="tags">
            {VOICES.filter((v) => v.range === g.range).map((v) => (
              <span key={v.id} className="voice-chip">
                <button
                  type="button"
                  className="tag"
                  aria-pressed={value === v.id}
                  title={v.note}
                  onClick={() => onChange(value === v.id ? "" : v.id)}
                  style={value === v.id ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                >
                  {v.label}
                </button>
                <button
                  type="button"
                  className="voice-play"
                  aria-label={`Hear the ${v.label} voice`}
                  onClick={() => void preview(v.id)}
                  disabled={playing !== null && playing !== v.id}
                >
                  {playing === v.id ? "…" : "▶"}
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
      {failed && <p className="error" role="alert">I couldn&apos;t play that voice. Try again.</p>}
    </div>
  );
}
