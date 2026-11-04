"use client";

import { signIn, signOut } from "next-auth/react";
import { useState } from "react";

import { forgetBase, rememberSignIn } from "@/lib/solo/cloud";
import { findPlace, type Place } from "@/lib/solo/world";

/* Sign in to keep your chats on every device.
 *
 * Without an account everything lives in this browser, so a phone and a laptop
 * (or an iPhone and an Android) each hold their own people, chats and closeness.
 * Signed in, a copy is kept on the server and each device picks it up.
 *
 * Signing in is optional: "Continue without an account" leaves everything in
 * this browser, as it always was.
 *
 * Email and password, on the account system that was already here. There is no
 * email service, so a forgotten password is reset with a recovery code, shown
 * once at sign-up (and whenever a new one is made). */

export type CloudStatus = "idle" | "syncing" | "ok" | "offline" | "too-big";

type Mode = "signup" | "login" | "reset";

export function Account({
  email,
  status,
  syncedAt,
  onSignedIn,
  onSignedOut,
  onSync,
  place,
  onPlace,
  onBack,
}: {
  email: string | null;
  status: CloudStatus;
  syncedAt: number | null;
  onSignedIn: (email: string) => void;
  onSignedOut: () => void;
  onSync: () => void;
  /** Where they are, if they said (world.ts), and how to change it. */
  place?: Place;
  onPlace: (place: Place | null) => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<Mode>("signup");
  const [mail, setMail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* A recovery code, shown once: nothing moves on until it has been seen. */
  const [shown, setShown] = useState<{ code: string; then: () => void } | null>(null);
  const [copied, setCopied] = useState(false);
  const [city, setCity] = useState("");
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  async function savePlace() {
    if (!city.trim() || placeBusy) return;
    setPlaceBusy(true);
    setPlaceError(null);
    const found = await findPlace(city);
    setPlaceBusy(false);
    if (!found) { setPlaceError("Couldn't find that place. Try the city name."); return; }
    onPlace(found);
    setCity("");
  }

  /* Where they are, so a character can know their weather. The coordinates stay
     on this device; only the weather, in words, goes to the model. */
  const where = (
    <div style={{ marginTop: "2rem", maxWidth: "26rem" }}>
      <h2 className="section-title">Where you are</h2>
      <p className="fine" style={{ marginTop: 0 }}>
        Optional. So they can notice your weather (&ldquo;pouring there, right?&rdquo;). Only the weather, in words, is shared with the model; your location stays on this device.
      </p>
      {place ? (
        <p>
          {place.name}{" "}
          <button className="link-btn" onClick={() => onPlace(null)}>remove</button>
        </p>
      ) : (
        <div className="row" style={{ gap: "0.5rem" }}>
          <input className="input" value={city} placeholder="Your city" maxLength={60} aria-label="Your city"
            onChange={(e) => setCity(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void savePlace(); }} />
          <button className="btn-ghost" disabled={placeBusy || !city.trim()} onClick={() => void savePlace()}>{placeBusy ? "…" : "Save"}</button>
        </div>
      )}
      {placeError && <p className="look-error" role="alert">{placeError}</p>}
    </div>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let newCode: string | null = null;
      if (mode === "signup" || mode === "reset") {
        const res = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            mode === "signup"
              ? { email: mail, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
              : { email: mail, code, password }
          ),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(d.error ?? (mode === "signup" ? "Couldn't create the account." : "Couldn't reset the password."));
          return;
        }
        newCode = d.recoveryCode ?? null;
      }
      const result = await signIn("credentials", { email: mail, password, redirect: false });
      if (result?.error) {
        setError(mode === "login" ? "That email and password don't match." : "Done, but signing in failed. Try logging in.");
        return;
      }
      const clean = mail.trim().toLowerCase();
      rememberSignIn(clean);
      const finish = () => { onSignedIn(clean); onBack(); };
      if (newCode) setShown({ code: newCode, then: finish });
      else finish();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function newRecoveryCode() {
    const res = await fetch("/api/auth/recovery", { method: "POST" }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : null;
    if (!res?.ok || !d?.recoveryCode) { setError("Couldn't make a new code. Try again."); return; }
    setError(null);
    setCopied(false);
    setShown({ code: d.recoveryCode, then: () => setShown(null) });
  }

  async function leave() {
    await signOut({ redirect: false }).catch(() => {});
    await forgetBase();
    rememberSignIn(null);
    onSignedOut();
  }

  async function remove() {
    if (!confirm("Delete your account and the copy of your chats kept on the server?\n\nThe chats on this device stay. Other devices keep theirs too, but stop syncing. This cannot be undone.")) return;
    const res = await fetch("/api/auth/account", { method: "DELETE" }).catch(() => null);
    if (!res?.ok) { setError("Couldn't delete the account. Try again."); return; }
    await leave();
  }

  const line =
    status === "syncing" ? "Syncing…"
      : status === "offline" ? "Couldn't reach the server. It will try again."
      : status === "too-big" ? "Your chats are too big to sync. Clear out a conversation or two."
      : syncedAt ? "Up to date." : "Not synced yet.";

  if (shown) {
    return (
      <main className="shell">
        <header className="row"><p className="mark">Account</p></header>
        <h1 className="display" style={{ fontSize: "1.9rem", marginTop: "1.5rem" }}>Save your recovery code</h1>
        <p className="lede">
          If you ever forget your password, this code is the only way back in. Screenshot it or write it down now.
          It is shown once and can&apos;t be looked up later.
        </p>
        <p className="recovery-code" aria-label="Recovery code">{shown.code}</p>
        <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            className="btn-ghost"
            onClick={() => { void navigator.clipboard?.writeText(shown.code).then(() => setCopied(true)).catch(() => {}); }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn" onClick={shown.then}>I&apos;ve saved it</button>
        </div>
        <p className="fine" style={{ marginTop: "1rem" }}>
          Using it to reset your password gives you a new code, and the old one stops working.
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Account</p>
        <button className="link-btn" onClick={onBack}>Back</button>
      </header>

      {email ? (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem", marginTop: "1.5rem" }}>You&apos;re signed in</h1>
          <p className="lede">{email}</p>
          <p className="fine">{line}</p>
          <div className="row" style={{ gap: "0.75rem", flexWrap: "wrap", marginTop: "1rem" }}>
            <button className="btn" disabled={status === "syncing"} onClick={onSync}>Sync now</button>
            <button className="btn-ghost" onClick={() => void leave()}>Sign out</button>
          </div>
          <p className="fine" style={{ marginTop: "1.5rem" }}>
            A copy of your people, chats and memories is kept on the server so your other devices can
            pick it up. Photos, voice notes and videos stay on the device that made them. Signing out
            leaves everything on this device.
          </p>
          {error && <p className="look-error" role="alert">{error}</p>}
          <div className="row" style={{ gap: "1.25rem", flexWrap: "wrap", marginTop: "1.5rem" }}>
            <button className="link-btn" onClick={() => void newRecoveryCode()}>Make a new recovery code</button>
            <button className="link-btn" onClick={() => void remove()}>Delete my account</button>
          </div>
          {where}
        </>
      ) : (
        <>
          <h1 className="display" style={{ fontSize: "1.9rem", marginTop: "1.5rem" }}>
            {mode === "signup" ? <>Keep your chats on<br />every device</> : mode === "login" ? "Welcome back" : "Reset your password"}
          </h1>
          <p className="lede">
            {mode === "reset"
              ? "Enter your email, the recovery code you saved when you made the account, and a new password."
              : "Right now everything is stored in this browser only, so your phone and your laptop each have their own. Sign in and your people, chats, memories and closeness are the same everywhere. You don't have to: without an account, everything stays in this browser as before."}
          </p>

          <form onSubmit={submit} style={{ maxWidth: "22rem" }}>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" required value={mail} onChange={(e) => setMail(e.target.value)} autoComplete="email" autoCapitalize="none" />
            </label>
            {mode === "reset" && (
              <label className="field">
                <span>Recovery code</span>
                <input
                  className="input" required value={code} onChange={(e) => setCode(e.target.value)}
                  placeholder="XXXX-XXXX-XXXX" autoCapitalize="characters" autoComplete="off" spellCheck={false}
                />
              </label>
            )}
            <label className="field">
              <span>{mode === "reset" ? "New password" : "Password"}</span>
              <input
                className="input" type="password" required minLength={8} value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </label>
            {mode === "signup" && (
              <p className="fine">At least 8 characters. You&apos;ll be given a recovery code next, to reset it if you forget.</p>
            )}
            {error && <p className="look-error" role="alert">{error}</p>}
            <div className="row" style={{ gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn" disabled={busy}>
                {busy ? "One moment…" : mode === "signup" ? "Create account" : mode === "login" ? "Sign in" : "Reset password"}
              </button>
              <button type="button" className="link-btn" onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(null); }}>
                {mode === "signup" ? "I already have an account" : "Create an account"}
              </button>
              {mode === "login" && (
                <button type="button" className="link-btn" onClick={() => { setMode("reset"); setError(null); }}>Forgot password?</button>
              )}
            </div>
          </form>

          <button className="btn-ghost" style={{ marginTop: "1.25rem" }} onClick={onBack}>Continue without an account</button>

          <p className="fine" style={{ marginTop: "1.5rem", maxWidth: "30rem" }}>
            Signing in means a copy of your chats is stored on the server. Photos, voice notes and videos
            stay on the device that made them, so on another device they show as placeholders.
          </p>
          {where}
        </>
      )}
    </main>
  );
}
