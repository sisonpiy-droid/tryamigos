"use client";

import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

/* §Screen 1 / §56. One form for both signup and login, because asking someone
   to pick which door they want before they have anything to sign into is
   friction for nothing (§Principle 4).

   Rendered only when a database is configured — see login/page.tsx. */

export default function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      if (mode === "signup") {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            name: name.trim() || undefined,
            // So "it's 2am" reads as 2am for them, not for the server (§Principle 2).
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Couldn't create the account.");
          setBusy(false);
          return;
        }
      }

      const result = await signIn("credentials", { email, password, redirect: false });
      if (result?.error) {
        setError(
          mode === "login"
            ? "That email and password don't match."
            : "Account created, but signing in failed. Try logging in."
        );
        setBusy(false);
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server.");
      setBusy(false);
    }
  }

  return (
    <main className="shell" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <p className="mark">Try Amigos</p>
      <h1 className="display">
        {mode === "signup" ? <>Who do you want<br />to talk to?</> : <>Welcome back.</>}
      </h1>
      <p className="lede">
        {mode === "signup"
          ? "Create people worth talking to, or find someone already here. They remember you between conversations."
          : "Your Amigos are where you left them."}
      </p>

      <form onSubmit={submit} style={{ maxWidth: "22rem" }}>
        {mode === "signup" && (
          <label className="field">
            <span>Your name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="given-name"
              placeholder="What should they call you?"
            />
          </label>
        )}

        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            aria-describedby={mode === "signup" ? "pw-hint" : undefined}
          />
        </label>
        {mode === "signup" && (
          <p className="fine" id="pw-hint" style={{ marginTop: "-0.4rem" }}>
            At least 8 characters.
          </p>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <div className="row" style={{ marginTop: "1.25rem" }}>
          <button className="btn" type="submit" disabled={busy || !email || password.length < 8}>
            {busy ? "One moment…" : mode === "signup" ? "Create account" : "Log in"}
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(null); }}
          >
            {mode === "signup" ? "I already have an account" : "Create one instead"}
          </button>
        </div>
      </form>

      <p className="fine" style={{ marginTop: "2.5rem", maxWidth: "34rem" }}>
        Every Amigo is an AI. They can be warm and know you well, and they will tell you
        plainly that they are not a person if you ask.
      </p>
    </main>
  );
}
