"use client";

import { useEffect, useRef, useState } from "react";

/* Export controls (§37).
 *
 * Downloads go through fetch rather than a plain <a download>: the routes are
 * authenticated, and a bare link gives no way to show an error if the request
 * is rejected -- the browser would just navigate somewhere and show JSON.
 */

export function ExportMenu({
  conversationId,
  museId,
  museName,
}: {
  conversationId: string;
  museId: string;
  museName: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function download(url: string, label: string) {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setError("Couldn't export that.");
        setBusy(null);
        return;
      }

      // Filename comes from the server so it stays consistent with the archive
      // format; falling back keeps the download working if a proxy strips it.
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `${museName}.txt`;

      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: revoking immediately cancels the download in
      // some browsers before it has started reading the blob.
      setTimeout(() => URL.revokeObjectURL(href), 0);

      setOpen(false);
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={wrap} style={{ position: "relative", marginLeft: "auto" }}>
      <button
        className="link-btn"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{ textDecoration: "none", fontSize: "1.1rem", lineHeight: 1 }}
        aria-label="Export"
        title="Export"
      >
        ↓
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", right: 0, top: "100%", marginTop: "0.4rem",
            background: "var(--surface)", border: "1px solid var(--edge)",
            borderRadius: "var(--r-md)", boxShadow: "var(--shadow)",
            padding: "0.35rem", minWidth: "15rem", zIndex: 10,
          }}
        >
          <MenuItem
            onClick={() => download(`/api/conversations/${conversationId}/export?format=md`, "md")}
            busy={busy === "md"}
            label="Conversation as Markdown"
            hint="Readable, with dates"
          />
          <MenuItem
            onClick={() => download(`/api/conversations/${conversationId}/export?format=json`, "json")}
            busy={busy === "json"}
            label="Conversation as JSON"
            hint="Structured"
          />
          <MenuItem
            onClick={() => download(`/api/muses/${museId}/export`, "persona")}
            busy={busy === "persona"}
            label={`${museName} as a persona file`}
            hint="Just who they are — no conversation"
          />
          <div style={{ height: 1, background: "var(--edge)", margin: "0.35rem 0" }} />
          <MenuItem
            onClick={() => download("/api/account/export", "account")}
            busy={busy === "account"}
            label="Everything in your account"
            hint="Every Muse, conversation and memory"
          />
          {error && <p className="error" style={{ margin: "0.5rem 0.6rem 0.3rem" }}>{error}</p>}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick, busy, label, hint,
}: { onClick: () => void; busy: boolean; label: string; hint: string }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={busy}
      style={{
        display: "block", width: "100%", textAlign: "left", font: "inherit",
        background: "none", border: 0, borderRadius: "var(--r-sm)",
        color: "var(--ink)", padding: "0.5rem 0.6rem", cursor: busy ? "wait" : "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
    >
      <span style={{ fontSize: "0.88rem" }}>{busy ? "Preparing…" : label}</span>
      <span style={{ display: "block", fontSize: "0.72rem", color: "var(--faint)" }}>{hint}</span>
    </button>
  );
}
