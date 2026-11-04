"use client";

import { useEffect, useRef, useState } from "react";

/* The ⋯ in a chat's header.
 *
 * The header used to hold "edit", "chat ↓" and "persona ↓" as three links,
 * which on a phone wrapped onto two lines and squeezed the name and the
 * "remembers" count into a column. The rarely used things live here instead,
 * together with the deletes that used to sit under every card on the home
 * screen -- one mis-tap away from losing a conversation. */

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean } | "divider";

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button className="menu-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="2" fill="currentColor" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <circle cx="19" cy="12" r="2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it, i) =>
            it === "divider" ? (
              <hr key={`d${i}`} />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                disabled={it.disabled}
                className={it.danger ? "danger" : undefined}
                onClick={() => { setOpen(false); it.onSelect(); }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
