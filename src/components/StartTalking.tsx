"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/* Opening a Muse resumes the existing thread rather than starting a new one,
   so the conversation id has to be resolved server-side before navigating.
   That is a POST, which is why this is a button rather than a link. */
export function StartTalking({
  museId,
  className,
  children,
}: {
  museId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function open() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ museId }),
      });
      if (!res.ok) { setBusy(false); return; }
      const { conversation } = await res.json();
      router.push(`/muses/${conversation.id}`);
    } catch {
      setBusy(false);
    }
  }

  return (
    <button className={className} onClick={open} disabled={busy} aria-busy={busy}>
      {children}
    </button>
  );
}
