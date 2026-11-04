"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { Menu } from "@/components/Menu";
import { clockTime, dayLabel, runOf } from "@/lib/solo/layout";
import { QuoteBubble, ReplyBar, jumpTo } from "@/components/Quote";
import { TraitEditor } from "@/components/TraitEditor";
import { useFollow } from "@/components/useFollow";
import { togetherNow } from "@/lib/solo/life";
import { useAttach } from "@/components/Attach";
import { Photo } from "@/components/Photo";
import { Video } from "@/components/Video";
import { VIDEO_ONLY, filesOf, keepAttachment } from "@/lib/solo/attach";
import { deleteImages } from "@/lib/solo/backend";
import { PHOTO_ONLY } from "@/lib/solo/photos";
import { videoNote, withPhotos } from "@/lib/solo/turn";
import { backgroundedSince, useReplyLoop } from "@/components/useReplyLoop";
import { REGISTERS, hasFeelings, splitBurst, storyPitches } from "@/lib/presence/persona";
import type { Update } from "@/app/solo/page";
import {
  QUOTE_CHARS, circleOf, deleteCircle, deleteConversation, deleteFrom, deleteMessage, editCircle, editMessage, editMuse, feelingsOf,
  insertAfter, lastShowAt, membersOf, memoriesForTurn, newMessage, paced, plansForTurn, promptPersona, quoteOf, recentOneToOne, rewindTo, windowOf,
  type SoloCircle, type SoloMessage, type SoloMuse, type SoloState,
} from "@/lib/solo/store";
import { embedTexts, learnFrom, refreshDigests } from "@/lib/solo/learn";
import { banterDelay, banterWanted, pickBanterer } from "@/lib/solo/banter";
import { MessageActions } from "./MessageActions";
import { Turn } from "./Turn";

/* A circle: several people in one conversation.
 *
 * Who speaks is decided here rather than by the model. Asking a model "who
 * should reply?" costs an extra call and it answers "everyone", which is how
 * group chats in these products end up as four assistants taking turns
 * answering the same question.
 *
 * So: one or two people reply to any given message, chosen by who was replied
 * to or addressed by name, then who has been quietest. It is a crude rule and
 * it reads far better than everyone piling in.
 */

/** One-tap ideas for what the room is about and what it is like. */
const TOPIC_IDEAS = ["Planning a trip", "Weekend plans", "Gossip", "Something that happened at work", "Old memories"];
const ROOM_IDEAS = ["chaotic", "roasting each other", "supportive", "nostalgic", "gossipy", "late-night", "competitive"];
const TRAIT_IDEAS = ["funny", "sarcastic", "caring", "blunt", "chill", "dramatic", "nosy", "savage"];

export function CircleChat({
  circle, state, update, onBack, onEdit,
}: {
  circle: SoloCircle;
  state: SoloState;
  update: Update;
  onBack: () => void;
  onEdit: () => void;
}) {
  const members = membersOf(state, circle);
  const log = state.conversations[circle.id] ?? [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /* The text lives in the textarea: setting state per keystroke re-rendered the whole room. */
  const [hasDraft, setHasDraft] = useState(false);
  const [speaking, setSpeaking] = useState<{ name: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A photo or video chosen but not sent yet. */
  const attach = useAttach(setError);
  const [replyTo, setReplyTo] = useState<SoloMessage | null>(null);
  /* The message whose actions are open. One at a time, like any chat app. */
  const [picked, setPicked] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const foot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  /* Read when a turn starts, not when it was scheduled -- see SoloChat. */
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  });

  /* One round of the room, answering everything the user has said since anyone
     last spoke -- one message or several. */
  async function turn(signal: AbortSignal, banter?: boolean) {
    const startedAt = Date.now();
    const s = latest.current;
    const room = circleOf(s, circle.id) ?? circle;
    const people = membersOf(s, room);
    let running = s.conversations[room.id] ?? [];
    const last = running[running.length - 1];
    if (!last || people.length < 2 || (!banter && last.from !== "user")) return;

    setError(null);

    /* Banter answers nobody: one of them says something to another unprompted. */
    const unanswered: SoloMessage[] = [];
    if (!banter) for (let i = running.length - 1; i >= 0 && running[i].from === "user"; i--) unanswered.unshift(running[i]);
    const query = banter ? running.slice(-4).map((x) => x.content).join("\n") : unanswered.map((u) => u.content).join("\n");
    /* Replying to someone's line is addressing them, as surely as naming them. */
    const repliedTo = unanswered
      .map((m) => quoteOf(running, m))
      .filter((q): q is SoloMessage => Boolean(q && q.from === "muse" && q.speakerId))
      .map((q) => q.speakerId as string);
    const speakers = banter
      ? [pickBanterer(people, running)].filter((x): x is SoloMuse => !!x)
      : chooseSpeakers(people, unanswered.map((m) => m.content).join("\n"), running, repliedTo);

    /* The room's recent photos and the latest video's frames, read once for
       the whole round: everyone in the room sees the same pictures. */
    const pictures = new Map((await withPhotos(windowOf(running, 80))).map((x) => [x.m.id, x]));

    /* Recall by meaning, once for the round, as in one-to-one chats: word
       overlap alone missed most of what someone remembered. */
    const [queryVector] = (await embedTexts([query])) ?? [null];

    let anchor = last.id;
    for (const m of speakers) {
      const persona = promptPersona(m, s.userName);
      if (!persona || signal.aborted) continue;
      let acc = "";
      try {
        const res = await fetch("/api/solo/circle", {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            circleName: room.name,
            speaker: { id: m.id, persona },
            /* Capped to what the route accepts. Circles built before the
               limit existed can be larger, and sending the full roster would
               reject every turn forever rather than just crowding the room. */
            others: people
              .filter((o) => o.id !== m.id)
              .slice(0, 7)
              .map((o) => ({
                id: o.id,
                name: o.name,
                relationship: o.relationshipType,
                traits: (o.traits ?? []).slice(0, 8),
              })),
            /* The whole room's transcript, including what anyone said earlier
               in this same turn -- so the second speaker is replying to the
               first rather than to the same message twice. */
            log: windowOf(running, 80).map((x) => {
              const q = quoteOf(running, x);
              const pic = pictures.get(x.id);
              return {
                from: x.from,
                speakerId: x.speakerId,
                content: (x.video ? videoNote(x, !!pic?.frames) : x.content).slice(0, 8000),
                at: x.at,
                ...(pic?.image ? { image: pic.image } : {}),
                ...(pic?.frames ? { frames: pic.frames } : {}),
                ...(q ? { quote: { from: q.from, speakerId: q.speakerId, content: q.content.slice(0, QUOTE_CHARS) } } : {}),
              };
            }),
            names: Object.fromEntries(people.map((o) => [o.id, o.name])),
            userName: s.userName,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            register: "texts",
            /* So nobody in the room asks what you already told them. */
            /* Their own memories, wherever learned. Anything from outside this
               room is marked private; see circleBlock for what that means. */
            ...(banter ? { banter: true } : {}),
            memories: memoriesForTurn(s, m.id, query, queryVector, { room: room.id })
              .map((x) => x.slice(0, 420)),
            /* A plan with the user that is on right now goes as `together`, as in
               their one-to-one: the plan list would call it "passed, outcome unknown". */
            plans: plansForTurn(s, m.id, { room: room.id })
              .filter((p) => p.what.slice(0, 300) !== togetherNow(s, m.id)?.what)
              .map((p) => ({ what: p.what.slice(0, 430), at: p.at })),
            together: togetherNow(s, m.id),
            /* The recent end of their own one-to-one chat with the user, so
               they walk in remembering it -- theirs only, never anyone else's. */
            oneToOne: recentOneToOne(s, m.id),
            /* And everything before that, digested -- see refreshDigests. */
            digest: s.digests?.[m.id]?.text ?? null,
            topic: room.topic?.trim() || undefined,
            roomTraits: room.traits?.length ? room.traits.slice(0, 8) : undefined,
            /* Each speaker brings their own standing state into the room. One
               person can be having a bad month while everyone else is fine,
               which is most group chats. */
            feelings: hasFeelings(feelingsOf(s, m.id)) ? feelingsOf(s, m.id) : null,
          }),
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          setError(data.error ?? "Something went wrong. Try again.");
          break;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let broke = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
            if (!line) continue;
            let evt: { type?: string; text?: string; message?: string };
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (evt.type === "delta" && evt.text) {
              acc += evt.text;
              /* Who is typing, not what: their texts appear one by one once in. */
              setSpeaking({ name: m.name, text: "" });
            } else if (evt.type === "error") {
              broke = true;
              setError(evt.message ?? "Something went wrong.");
            }
          }
        }

        setSpeaking(null);
        if (signal.aborted) return;
        /* Half a line is not a line. The room moves on without it. */
        const said = broke ? "" : acc.trim();
        if (said) {
          /* Paced, and after whatever the last speaker is still "typing". */
          const parts = paced(
            splitBurst(said, REGISTERS.texts.burst).map((c) => newMessage("muse", c, { speakerId: m.id })),
            Math.max(Date.now(), lastShowAt(running) + 600)
          );
          running = [...running, ...parts];
          /* After the line they were answering, not at the end: anything the
             user sent meanwhile stays last and gets its own turn. */
          update((cur) => insertAfter(cur, room.id, anchor, parts));
          anchor = parts[parts.length - 1].id;
        }
      } catch {
        setSpeaking(null);
        if (!signal.aborted && !backgroundedSince(startedAt)) setError("You're offline.");
        break;
      }
    }
    setSpeaking(null);

    /* What the user said in the room becomes memory for everyone in it -- they
       all heard it. Learned here, so marked as known to this room. Not from
       banter: nobody told them anything new. */
    if (!signal.aborted && !banter) {
      const nameById = new Map(people.map((p) => [p.id, p.name]));
      void learnFrom({
        museIds: people.map((p) => p.id),
        window: running.slice(-10),
        state: latest.current,
        update,
        circleId: room.id,
        nameOf: (x) => nameById.get(x.speakerId ?? "") ?? "Someone",
      });
    }
  }

  /* Same rule as one to one: an edit to your latest message redoes the room's
     answer to it, further up it asks first. */

  /* Owed a reply when the room ends on something the user said. */
  const loop = useReplyLoop(circle.id, turn, () => (latest.current.conversations[circle.id] ?? []).at(-1)?.from === "user");

  /* Texts still being "typed" are saved but not shown until their time. */
  const [clock, setClock] = useState(() => Date.now());
  const shown = log.filter((m) => !m.showAt || Date.parse(m.showAt) <= clock);
  const typingNext = shown.length < log.length;
  const nextUp = typingNext ? log.find((m) => m.showAt && Date.parse(m.showAt) > clock) : undefined;
  useEffect(() => {
    const due = log.map((m) => (m.showAt ? Date.parse(m.showAt) : 0)).filter((t) => t > clock);
    if (!due.length) return;
    const t = setTimeout(() => setClock(Date.now()), Math.max(30, Math.min(...due) - Date.now() + 20));
    return () => clearTimeout(t);
    // Reschedules when a message arrives or the clock moves; that is all that changes when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.length, clock]);

  /* Each member's one-to-one, digested, brought up to date as the group opens. */
  useEffect(() => {
    void refreshDigests(latest.current, membersOf(latest.current, circle).map((m) => m.id), update);
    // Once per group opened; reads the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle.id]);

  useFollow(shown.length * 2 + (speaking || typingNext || loop.busy ? 1 : 0), speaking?.text, shown.at(-1)?.from === "user");

  /* Unprompted talk between them, while the group sits open and quiet (see
     lib/solo/banter.ts for the limits). */
  const banterSent = useRef<number[]>([]);
  const sinceUser = useRef(0);
  const banterCtl = useRef<AbortController | null>(null);
  const lastId = shown.at(-1)?.id;
  useEffect(() => {
    const check = () => {
      const s = latest.current;
      const thread = s.conversations[circle.id] ?? [];
      if (banterCtl.current || !banterWanted(thread, {
        now: Date.now(), members: members.length, sinceUser: sinceUser.current, recent: banterSent.current,
        typing: !!box.current?.value.trim(), busy: loop.busy, visible: document.visibilityState === "visible",
      })) return;
      const ctl = new AbortController();
      banterCtl.current = ctl;
      sinceUser.current += 1;
      banterSent.current = [...banterSent.current.filter((t) => Date.now() - t < 3_600_000), Date.now()];
      void turn(ctl.signal, true).finally(() => { if (banterCtl.current === ctl) banterCtl.current = null; });
    };
    const t = setTimeout(check, banterDelay());
    return () => clearTimeout(t);
    // Re-armed each time the room changes, and when a reply finishes or starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId, loop.busy, members.length]);
  /* Whatever was being said to nobody stops the moment the user speaks. */
  useEffect(() => () => banterCtl.current?.abort(), []);

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "Someone";
  const whoSaid = (m: SoloMessage) => (m.from === "user" ? "You" : nameOf(m.speakerId ?? ""));

  async function sendDraft() {
    const content = (box.current?.value ?? "").trim();
    if ((!content && !attach.draft) || members.length < 2) return;
    const file = attach.take();
    let msg = newMessage("user", content || (file?.kind === "video" ? VIDEO_ONLY : PHOTO_ONLY), { replyTo: replyTo?.id });
    if (file) {
      /* The file first, then the message that points at it. */
      const kept = await keepAttachment(file, msg.id);
      URL.revokeObjectURL(file.url);
      if (!kept) { setError(`Couldn't keep that ${file.kind} on this device. Try again.`); return; }
      msg = { ...msg, ...kept };
    }
    update((cur) => ({
      ...cur,
      conversations: { ...cur.conversations, [circle.id]: [...(cur.conversations[circle.id] ?? []), msg] },
    }));
    if (box.current) box.current.value = "";
    setHasDraft(false);
    setReplyTo(null);
    setError(null);
    if (box.current) box.current.style.height = "auto";
    banterCtl.current?.abort();
    banterCtl.current = null;
    sinceUser.current = 0;
    loop.schedule();
  }

  function editLine(m: SoloMessage, text: string) {
    const at = log.findIndex((x) => x.id === m.id);
    const after = log.slice(at + 1);
    const redo =
      m.from === "user" &&
      (!after.some((x) => x.from === "user") ||
        confirm(
          `Redo the conversation from this message?\n\nOK takes the room back to here and they answer the new version. The ${after.length} messages after it are removed.\n\nCancel just changes the text.`
        ));
    if (redo) {
      update((cur) => rewindTo(editMessage(cur, circle.id, m.id, text), circle.id, m.id));
      setError(null);
      loop.restart();
      return;
    }
    update((cur) => editMessage(cur, circle.id, m.id, text));
  }

  const topic = circle.topic?.trim() ?? "";
  const roomTraits = circle.traits ?? [];
  const summary = [topic && `about ${topic}`, roomTraits.length ? roomTraits.join(", ") : ""]
    .filter(Boolean)
    .join(" · ") || "nothing set";

  return (
    <main className="shell" style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <header className="chat-head">
        <button className="link-btn" onClick={onBack} aria-label="Back" style={{ textDecoration: "none" }}>←</button>
        <div className="stack-avatars">
          {members.slice(0, 3).map((m) => <Avatar key={m.id} name={m.name} image={m.avatar?.id} />)}
        </div>
        <div className="chat-who">
          <h1>{circle.name}</h1>
          <div className="rel">
            {members.map((m) => m.name).join(", ")}
            {topic && <span style={{ color: "var(--accent)" }}> · about {topic}</span>}
          </div>
        </div>
        <Menu
          label={`More for ${circle.name}`}
          items={[
            { label: "Edit group", onSelect: onEdit },
            /* The same as one to one: the room goes along with it, and you kick it off. */
            {
              label: "Start a story with everyone",
              onSelect: () => {
                update((cur) => ({ ...cur, circles: (cur.circles ?? []).map((c) => (c.id === circle.id
                  ? { ...c, topic: "a story we all play out together, saying yes to it" } : c)) }));
                if (box.current) box.current.value = `let's play out a story, all of us 🎬 pick one: ${storyPitches().map((p, i) => `${i + 1}) ${p}`).join(" ")}`;
                void sendDraft();
              },
            },
            "divider",
            {
              label: "Clear this chat",
              disabled: !log.length,
              onSelect: () => {
                if (confirm(`Clear the conversation in ${circle.name}? Everyone keeps what they remember.`)) update((cur) => deleteConversation(cur, circle.id, false));
              },
            },
            {
              label: "Delete group",
              danger: true,
              onSelect: () => {
                if (confirm(`Delete ${circle.name}? The people in it stay, with their own chats.`)) { onBack(); update((cur) => deleteCircle(cur, circle.id)); }
              },
            },
          ]}
        />
      </header>

      <div className="thread" role="log" aria-live="polite" aria-label={`Conversation in ${circle.name}`}>
        {log.length === 0 && (
          <div className="empty" style={{ marginTop: "2rem" }}>
            <p style={{ fontFamily: "var(--serif)", fontSize: "1.1rem" }}>
              {members.map((m) => m.name).join(", ")} are all here.
            </p>
            <p className="fine">
              They know each other. Say something, name one of them, or reply to one of their
              messages to talk to them directly.
            </p>
          </div>
        )}

        {shown.map((m, i) => {
          const q = quoteOf(log, m);
          const run = runOf(shown, i, tz);
          const speaker = m.from === "muse" ? members.find((x) => x.id === m.speakerId) : undefined;
          const replyHere = () => { setReplyTo(m); setPicked(null); box.current?.focus(); };
          return (
            <Fragment key={m.id}>
            {run.newDay && <div className="day-divider" role="separator"><span>{dayLabel(m.at, clock, tz)}</span></div>}
            <Turn id={m.id} mine={m.from === "user"} picked={picked === m.id} onPick={setPicked} onReply={replyHere}>
              {m.from === "muse" && run.first && (
                <span className="who">
                  <Avatar small name={nameOf(m.speakerId ?? "")} image={speaker?.avatar?.id} />
                  {nameOf(m.speakerId ?? "")}
                </span>
              )}
              {m.replyTo && (
                <QuoteBubble who={q ? whoSaid(q) : ""} text={q?.content} onJump={q ? () => jumpTo(q.id) : undefined} />
              )}
              {m.image && <Photo id={m.image.id} w={m.image.w} h={m.image.h} />}
              {m.video && <Video id={m.video.id} w={m.video.w} h={m.video.h} seconds={m.video.seconds} />}
              {(m.image && m.content === PHOTO_ONLY) || (m.video && m.content === VIDEO_ONLY) ? null : m.content}
              {m.edited && <span className="stamp"> · edited</span>}
              <MessageActions
                content={m.content}
                onReply={replyHere}
                onEdit={(text) => editLine(m, text)}
                onDelete={() => {
                  const files = filesOf(m);
                  if (files.length) void deleteImages(files);
                  update(deleteMessage(state, circle.id, m.id));
                }}
                onDeleteFrom={() => update(deleteFrom(state, circle.id, m.id))}
                onDone={() => setPicked(null)}
              />
            </Turn>
            {run.last && <span className={`turn-time turn-time-${m.from === "user" ? "user" : "muse"}`}>{clockTime(m.at, tz)}</span>}
            </Fragment>
          );
        })}

        {(speaking || nextUp || loop.busy) && (
          <p className="typing" role="status">
            <span className="typing-dots" aria-hidden><i /><i /><i /></span>
            <span>{nextUp ? nameOf(nextUp.speakerId ?? "") : speaking ? speaking.name : "someone"} is typing</span>
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        <div ref={foot} />
      </div>

      <div className="vibe">
        <button onClick={() => setPanelOpen(!panelOpen)} aria-expanded={panelOpen}>
          <span>{panelOpen ? "Close" : "Change how this goes"}</span>
          <b>{summary}</b>
        </button>

        {panelOpen && (
          <div className="vibe-panel">
            <div>
              <label htmlFor="circle-topic">What do you want to talk about?</label>
              <input
                id="circle-topic"
                className="input"
                value={circle.topic ?? ""}
                maxLength={200}
                placeholder="Planning Goa, or roasting Kabir's new haircut"
                onChange={(e) => update((cur) => editCircle(cur, circle.id, { topic: e.target.value }))}
              />
              <div className="tags">
                {TOPIC_IDEAS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="tag"
                    aria-pressed={topic === t}
                    onClick={() => update((cur) => editCircle(cur, circle.id, { topic: topic === t ? "" : t }))}
                    style={topic === t ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label>What is the group like together?</label>
              <TraitEditor
                traits={roomTraits}
                onChange={(traits) => update((cur) => editCircle(cur, circle.id, { traits }))}
                suggestions={ROOM_IDEAS}
                label="Add something about the group"
              />
            </div>

            <div>
              <label>Each of them</label>
              {members.map((m) => (
                <div key={m.id} className="member-traits">
                  <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                    <Avatar name={m.name} image={m.avatar?.id} />
                    <b>{m.name}</b>
                  </div>
                  <TraitEditor
                    traits={m.traits ?? []}
                    onChange={(traits) => update((cur) => editMuse(cur, m.id, { traits }))}
                    suggestions={TRAIT_IDEAS}
                    label={`Add a trait for ${m.name}`}
                  />
                </div>
              ))}
              <p className="fine">
                A person&rsquo;s traits are theirs everywhere, one to one as well as in here. The
                group&rsquo;s are only for this room.
              </p>
            </div>

            <p className="fine">
              <strong style={{ color: "var(--accent)" }}>Applies from your next message.</strong>
            </p>
          </div>
        )}
      </div>

      <div className="composer">
        {replyTo && (
          <ReplyBar
            who={replyTo.from === "user" ? "yourself" : nameOf(replyTo.speakerId ?? "")}
            text={replyTo.content}
            onCancel={() => setReplyTo(null)}
          />
        )}
        {attach.preview}
        {attach.button}
        <label className="sr-only" htmlFor="circle-composer">Write to {circle.name}</label>
        <textarea
          id="circle-composer"
          ref={box}
          rows={1}
          placeholder={`Write to ${circle.name}`}
          onChange={(e) => {
            setHasDraft(e.target.value.trim().length > 0);
            loop.hold();
            const el = box.current;
            if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 128)}px`; }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendDraft(); }
            if (e.key === "Escape" && replyTo) setReplyTo(null);
          }}
        />
        <button className="send" onClick={() => void sendDraft()} disabled={!hasDraft && !attach.draft}>Send</button>
      </div>
    </main>
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Who replies. Whoever was replied to or named first, then whoever has been
 *  quietest, capped at two so the room does not shout. Outside the component
 *  so the Math.random() below is not something the compiler has to reason
 *  about for render. */
function chooseSpeakers(
  members: SoloMuse[],
  text: string,
  recent: SoloMessage[],
  repliedTo: string[] = []
): SoloMuse[] {
  const addressed = members.filter(
    (m) => repliedTo.includes(m.id) || new RegExp(`\\b${escapeRe(m.name)}\\b`, "i").test(text)
  );
  if (addressed.length) return addressed.slice(0, 2);

  const lastSpokeAt = new Map<string, number>();
  recent.forEach((m, i) => { if (m.speakerId) lastSpokeAt.set(m.speakerId, i); });
  const quietestFirst = [...members].sort(
    (a, b) => (lastSpokeAt.get(a.id) ?? -1) - (lastSpokeAt.get(b.id) ?? -1)
  );
  // Two most of the time, one sometimes, so the rhythm is not mechanical.
  return quietestFirst.slice(0, Math.random() < 0.35 ? 1 : 2);
}
