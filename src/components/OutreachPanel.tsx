"use client";

import { useState } from "react";

import {
  cancel, notificationsAllowed, pushSupport, saveDevice, settingsOf, subscribePush,
} from "@/lib/proactive/client";
import { allMuses, type OutreachSettings, type SoloState } from "@/lib/solo/store";

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/* Letting them text first.
 *
 * Off until switched on, and described by what it actually does: they text
 * when there is a reason -- something tomorrow, something you asked to be
 * reminded of, something you said you would tell them about -- and never just
 * to say hi. Who may, how often, and when they must not, are all here, and so
 * is everything currently waiting to be sent, so nothing happens behind the
 * user's back.
 */

export async function applyOutreach(
  state: SoloState,
  update: Update,
  patch: Partial<OutreachSettings>,
  /** From a tap: also ask for notification permission and subscribe. */
  askPush = false
): Promise<{ ok: boolean; push?: string }> {
  const next: OutreachSettings = { ...settingsOf(state), ...patch };
  let push: PushSubscriptionJSON | null | undefined;
  let pushNote: string | undefined;
  if (askPush && next.proactiveEnabled) {
    const r = await subscribePush();
    if ("sub" in r) push = r.sub;
    else pushNote = r.error;
  }
  const saved = await saveDevice(next, push);
  if (!saved.ok) return { ok: false };
  update((cur) => ({ ...cur, outreach: { ...(cur.outreach ?? {}), settings: next } }));
  return { ok: true, push: pushNote };
}

const FREQ: { key: OutreachSettings["initiationFrequency"]; label: string; note: string }[] = [
  { key: "RARELY", label: "Rarely", note: "only for something coming up, or a reminder you asked for — a few days apart" },
  { key: "SOMETIMES", label: "Sometimes", note: "also to ask how something went, and now and then about a goal" },
  { key: "OFTEN", label: "Often", note: "every good reason, at most every half a day" },
];

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const toMinutes = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

export function OutreachPanel({ state, update }: { state: SoloState; update: Update }) {
  const settings = settingsOf(state);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const support = typeof window === "undefined" ? "ok" : pushSupport();
  const people = allMuses(state).filter((m) => (state.conversations[m.id]?.length ?? 0) > 0 || settings.allowedMuseIds.includes(m.id));
  const pending = (state.outreach?.triggers ?? []).filter((t) => t.status === "PENDING");

  async function change(patch: Partial<OutreachSettings>, askPush = false) {
    setBusy(true);
    setNote(null);
    const r = await applyOutreach(state, update, patch, askPush);
    setBusy(false);
    if (!r.ok) setNote("Couldn't save that. Check your connection and try again.");
    else if (r.push === "denied") setNote("Notifications are blocked for this site, so their texts will wait here until you open Try Amigos. You can allow notifications in your browser settings.");
    else if (r.push === "unsupported") setNote(support === "needs-install" ? "On iPhone, add Try Amigos to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications. Until then their texts wait here." : "This browser can't show notifications, so their texts will wait here until you open Try Amigos.");
    else if (r.push) setNote("Notifications couldn't be set up just now. Their texts will still wait here.");
  }

  if (!settings.proactiveEnabled) {
    return (
      <div className="outreach">
        <div>
          <b>Let them text you first</b>
          <span>
            Only when there&apos;s a reason — an interview tomorrow, something you asked them to remind you
            about, something you said you&apos;d tell them. Never just to say hi.
          </span>
        </div>
        <button className="btn-ghost" disabled={busy} onClick={() => { setOpen(true); void change({ proactiveEnabled: true }, true); }}>
          {busy ? "One moment…" : "Turn on"}
        </button>
        {note && <p className="fine" role="status">{note}</p>}
      </div>
    );
  }

  const allowed = new Set(settings.allowedMuseIds);
  const freq = FREQ.find((f) => f.key === settings.initiationFrequency) ?? FREQ[1];

  return (
    <div className="outreach outreach-on">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <b>They can text you first</b>
        <button className="link-btn" onClick={() => setOpen(!open)}>{open ? "Done" : "Settings"}</button>
      </div>
      <span>
        {allowed.size ? `${allowed.size === 1 ? "1 person" : `${allowed.size} people`} can` : "Nobody can yet —"} text you, {freq.label.toLowerCase()},
        never between {hhmm(settings.quietHoursStart)} and {hhmm(settings.quietHoursEnd)}.
        {notificationsAllowed() ? "" : " Notifications are off, so texts wait here."}
      </span>

      {open && (
        <div className="outreach-settings">
          <div className="field">
            <span className="outreach-label">Who can text you first</span>
            <div className="tags">
              {people.length ? people.map((m) => (
                <button key={m.id} type="button" className="tag" aria-pressed={allowed.has(m.id)} disabled={busy}
                  style={allowed.has(m.id) ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  onClick={() => void change({
                    allowedMuseIds: allowed.has(m.id) ? settings.allowedMuseIds.filter((x) => x !== m.id) : [...settings.allowedMuseIds, m.id],
                  })}>
                  {m.name}
                </button>
              )) : <span className="fine">Talk to someone first.</span>}
            </div>
          </div>

          <div className="field">
            <span className="outreach-label">How often</span>
            <div className="tags">
              {FREQ.map((f) => (
                <button key={f.key} type="button" className="tag" aria-pressed={settings.initiationFrequency === f.key} disabled={busy}
                  style={settings.initiationFrequency === f.key ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  onClick={() => void change({ initiationFrequency: f.key })}>
                  {f.label}
                </button>
              ))}
            </div>
            <p className="fine" style={{ margin: "0.4rem 0 0" }}>{freq.note}.</p>
          </div>

          <div className="pair">
            <label className="field">
              <span>Quiet from</span>
              <input className="input" type="time" value={hhmm(settings.quietHoursStart)}
                onChange={(e) => { const m = toMinutes(e.target.value); if (m !== null) void change({ quietHoursStart: m }); }} />
            </label>
            <label className="field">
              <span>until</span>
              <input className="input" type="time" value={hhmm(settings.quietHoursEnd)}
                onChange={(e) => { const m = toMinutes(e.target.value); if (m !== null) void change({ quietHoursEnd: m }); }} />
            </label>
          </div>

          <div className="field">
            <span className="outreach-label">At most, per day</span>
            <div className="tags">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" className="tag" aria-pressed={settings.maxDailyProactive === n} disabled={busy}
                  style={settings.maxDailyProactive === n ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  onClick={() => void change({ maxDailyProactive: n })}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          {!notificationsAllowed() && support !== "unsupported" && (
            <button className="btn-ghost" disabled={busy} onClick={() => void change({}, true)}>Turn on notifications</button>
          )}

          {pending.length > 0 && (
            <div className="field">
              <span className="outreach-label">Waiting to be sent</span>
              <ul className="outreach-pending">
                {pending.map((t) => (
                  <li key={t.id}>
                    <span>
                      {allMuses(state).find((m) => m.id === t.museId)?.name ?? "Someone"} ·{" "}
                      {new Date(t.scheduledFor).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                      {" — "}{t.reason}
                    </span>
                    <button className="link-btn" aria-label="Don't send this" onClick={() => {
                      void cancel([t.id], "cancelled by the user");
                      update((cur) => ({
                        ...cur,
                        outreach: { ...(cur.outreach ?? {}), triggers: (cur.outreach?.triggers ?? []).map((x) => (x.id === t.id ? { ...x, status: "CANCELLED" as const } : x)) },
                      }));
                    }}>don&apos;t send</button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button className="link-btn" disabled={busy} onClick={() => void change({ proactiveEnabled: false })}>Turn off</button>
        </div>
      )}
      {note && <p className="fine" role="status">{note}</p>}
    </div>
  );
}
