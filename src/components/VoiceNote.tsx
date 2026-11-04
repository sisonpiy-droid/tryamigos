"use client";

import { useEffect, useRef, useState } from "react";

import { photoUrl } from "@/lib/solo/photos";

/* A voice note from them, the way a chat app shows one: play, how far through,
   how long. The words are underneath for anyone who can't listen right now --
   hidden until asked for, because a voice note you read first is a text. */

const length = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* One playing at a time, like any chat app: starting one stops the last. */
let playing: HTMLAudioElement | null = null;

export function VoiceNote({ id, seconds, text }: { id: string; seconds: number; text: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const [words, setWords] = useState(false);

  useEffect(() => {
    let live = true;
    void photoUrl(id).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);

  /* An <audio> taken out of the page keeps playing; leaving the chat stops it. */
  useEffect(() => {
    const a = audio.current;
    return () => a?.pause();
  }, [url]);

  function toggle(e: React.MouseEvent) {
    // A tap here plays it; it should not also open the message's actions.
    e.stopPropagation();
    const a = audio.current;
    if (!a) return;
    if (on) { a.pause(); return; }
    if (playing && playing !== a) playing.pause();
    playing = a;
    void a.play().catch(() => setOn(false));
  }

  const fraction = seconds ? Math.min(1, at / seconds) : 0;
  return (
    <div className="vnote">
      <div className="vnote-row">
        <button type="button" className="vnote-play" onClick={toggle} disabled={!url} aria-label={on ? "Pause voice note" : "Play voice note"}>
          {on ? "❚❚" : "▶"}
        </button>
        <span className="vnote-track" aria-hidden="true"><i style={{ transform: `scaleX(${fraction})` }} /></span>
        <span className="vnote-time">{length(on || at ? at : seconds)}</span>
      </div>
      {url && (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setOn(true)}
          onPause={() => setOn(false)}
          onEnded={() => { setOn(false); setAt(0); }}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
        />
      )}
      {!url && <span className="stamp">voice note not on this device</span>}
      <button type="button" className="vnote-words" onClick={(e) => { e.stopPropagation(); setWords(!words); }}>
        {words ? "Hide text" : "Show text"}
      </button>
      {words && <p className="vnote-text">{text}</p>}
    </div>
  );
}
