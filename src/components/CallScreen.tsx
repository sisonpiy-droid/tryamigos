"use client";

import { useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import type { SoloMuse, SoloState } from "@/lib/solo/store";
import { CallSession, type CallState, type CallView } from "@/lib/voice/session";

/* The call screen: who, how long, what is happening, mute, end.
 *
 * The state line is the whole interface, so it is a sentence rather than a
 * spinner -- "Listening", "Thinking", the words being said. A call should feel
 * like someone on the line, not a loading screen. Everything that does the work
 * is in lib/voice/session.ts; this only shows it.
 */

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

const LABEL: Record<CallState, string> = {
  connecting: "Calling…",
  listening: "Listening…",
  processing: "Thinking…",
  speaking: "",
  interrupted: "Go ahead…",
  ended: "Call ended",
  error: "Call couldn't connect",
};

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function CallScreen({
  muse,
  getState,
  update,
  onClose,
}: {
  muse: SoloMuse;
  getState: () => SoloState;
  update: Update;
  onClose: () => void;
}) {
  const [view, setView] = useState<CallView | null>(null);
  const [now, setNow] = useState(0);
  const session = useRef<CallSession | null>(null);

  useEffect(() => {
    const s = new CallSession(muse.id, muse, getState, update, setView);
    session.current = s;
    void s.start();
    const onVisibility = () => (document.visibilityState === "hidden" ? s.pause() : s.resume());
    /* Closing or leaving the page ends the call, so it can never keep listening unseen. */
    const onHide = () => s.end();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      s.end();
    };
    // One session per mounted call screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!view?.startedAt || view.state === "ended") return;
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [view?.startedAt, view?.state]);

  const state = view?.state ?? "connecting";
  const live = state !== "ended" && state !== "error";
  const status = view?.muted && live && state !== "speaking" ? "Muted" : LABEL[state];

  return (
    <main className={`call call-${state}`} aria-label={`Call with ${muse.name}`}>
      <div className="call-top">
        <p className="call-duration" aria-live="off">
          {view?.startedAt && state !== "error" ? clock((now || view.startedAt) - view.startedAt) : " "}
        </p>
      </div>

      <div className="call-who">
        <div className="call-ring" aria-hidden>
          <Avatar name={muse.name} image={muse.avatar?.id} />
        </div>
        <h1>{muse.name}</h1>
        <p className="call-state" role="status" aria-live="polite">{status}</p>
        <div className="call-wave" aria-hidden>{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ animationDelay: `${i * 90}ms` }} />)}</div>
      </div>

      <div className="call-words" aria-live="polite">
        {view?.caption && state === "speaking" && <p className="call-caption">{view.caption}</p>}
        {view?.heard && live && <p className="call-heard">{view.heard}</p>}
        {view?.notice && (
          <div className="call-notice" role="alert">
            <p>{view.notice}</p>
            {view.canRetry && <button className="btn-ghost" onClick={() => session.current?.retry()}>Try again</button>}
          </div>
        )}
      </div>

      <div className="call-controls">
        {live ? (
          <>
            <button
              className="call-btn"
              aria-pressed={view?.muted ?? false}
              onClick={() => session.current?.toggleMute()}
            >
              <span aria-hidden>{view?.muted ? <MicOff /> : <Mic />}</span>
              {view?.muted ? "Unmute" : "Mute"}
            </button>
            <button className="call-btn call-end" onClick={() => { session.current?.end(); onClose(); }}>
              <span aria-hidden><Hangup /></span>
              End
            </button>
          </>
        ) : (
          <button className="call-btn call-close" onClick={onClose}>
            Back to chat
          </button>
        )}
      </div>
    </main>
  );
}

const Mic = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const MicOff = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
  </svg>
);
const Hangup = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 9c-2.6 0-5 .6-7.2 1.7-.6.3-.9 1-.8 1.6l.4 2.2c.1.7.8 1.2 1.5 1.1l2.6-.4c.6-.1 1.1-.6 1.2-1.2l.3-1.7c.6-.2 1.3-.3 2-.3s1.4.1 2 .3l.3 1.7c.1.6.6 1.1 1.2 1.2l2.6.4c.7.1 1.4-.4 1.5-1.1l.4-2.2c.1-.6-.2-1.3-.8-1.6C17 9.6 14.6 9 12 9z" />
  </svg>
);
