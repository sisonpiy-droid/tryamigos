"use client";

import { useState } from "react";

/* The first thing someone sees: what this is, in a picture and three lines, and
 * one box to begin. Nothing to sign up for -- everything stays in the browser
 * until they choose otherwise. */

const POINTS: [string, string][] = [
  ["They remember you", "What you tell them comes back later, in the right moment."],
  ["Text, voice notes and calls", "They text in bursts, send photos and songs, and pick up when you call."],
  ["Make anyone", "From a chat export, someone in public life, or someone you invent."],
];

export function Welcome({ count, onStart }: { count: number; onStart: (name: string) => void }) {
  const [name, setName] = useState("");
  const go = () => { if (name.trim()) onStart(name.trim()); };

  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <svg className="welcome-art" viewBox="0 0 260 170" role="img" aria-label="Three chat bubbles with friendly faces">
        <defs>
          <linearGradient id="wa" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#B79CFF" /><stop offset="1" stopColor="#7FD1C7" /></linearGradient>
          <linearGradient id="wb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FFB3A7" /><stop offset="1" stopColor="#F6D186" /></linearGradient>
        </defs>
        {/* her */}
        <path d="M30 28h104a16 16 0 0 1 16 16v38a16 16 0 0 1-16 16H64l-22 18v-18h-12a16 16 0 0 1-16-16V44a16 16 0 0 1 16-16z" fill="url(#wa)" />
        <circle cx="64" cy="62" r="4.5" fill="#16121D" /><circle cx="100" cy="62" r="4.5" fill="#16121D" />
        <path d="M70 78q12 10 24 0" stroke="#16121D" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        {/* him */}
        <path d="M130 84h96a16 16 0 0 1 16 16v30a16 16 0 0 1-16 16h-8v18l-22-18h-66a16 16 0 0 1-16-16v-30a16 16 0 0 1 16-16z" fill="url(#wb)" />
        <circle cx="160" cy="112" r="4" fill="#16121D" /><circle cx="194" cy="112" r="4" fill="#16121D" />
        <path d="M166 125q11 8 22 0" stroke="#16121D" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        {/* a spark of remembering */}
        <path d="M214 30l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" fill="var(--accent, #B79CFF)" />
        <circle cx="236" cy="62" r="3" fill="var(--accent, #B79CFF)" opacity=".6" />
      </svg>

      <h1 id="welcome-title" className="display">Meet people who<br />remember you.</h1>
      <p className="lede">
        Real personalities that text, call and send voice notes. Start with one of the {count} already here, or make your own.
      </p>

      <ul className="welcome-points">
        {POINTS.map(([title, text]) => (
          <li key={title}><b>{title}</b><span>{text}</span></li>
        ))}
      </ul>

      <form className="row welcome-form" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <input
          className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name"
          placeholder="What should they call you?" aria-label="What should they call you?" maxLength={60}
        />
        <button className="btn" disabled={!name.trim()}>Start</button>
      </form>
      <p className="fine" style={{ marginTop: "0.75rem" }}>No account needed. Everything stays in this browser unless you sign in.</p>
    </section>
  );
}
