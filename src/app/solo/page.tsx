"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Avatar } from "@/components/Avatar";
import { BuildFigure } from "@/components/BuildFigure";
import { CallScreen } from "@/components/CallScreen";
import { OutreachPanel, applyOutreach } from "@/components/OutreachPanel";
import { useOutreach } from "@/components/useOutreach";
import { CircleChat } from "@/components/CircleChat";
import { EditMuse } from "@/components/EditMuse";
import { ImportPersona } from "@/components/ImportPersona";
import { Memories } from "@/components/Memories";
import { Menu } from "@/components/Menu";
import { MessageActions } from "@/components/MessageActions";
import { QuoteBubble, ReplyBar, jumpTo } from "@/components/Quote";
import { TraitEditor } from "@/components/TraitEditor";
import { Turn } from "@/components/Turn";
import { Photo } from "@/components/Photo";
import { useAttach } from "@/components/Attach";
import { Video } from "@/components/Video";
import { SongCard } from "@/components/SongCard";
import { Story } from "@/components/Story";
import { Look } from "@/components/Look";
import { Scrapbook } from "@/components/Scrapbook";
import { Welcome } from "@/components/Welcome";
import { BlockedSheet } from "@/components/BlockedSheet";
import { arrange, toggleArchive, togglePin } from "@/lib/solo/chatlist";
import { clockTime, dayLabel, runOf } from "@/lib/solo/layout";
import { VoiceNote } from "@/components/VoiceNote";
import { useFollow } from "@/components/useFollow";
import { backgroundedSince, useReplyLoop } from "@/components/useReplyLoop";
import { MADE_TAB, TABS } from "@/lib/personas";
import {
  DEFAULT_VIBE, PICKABLE_REGISTERS, REGISTERS, TOPICS, feelingsSummary, HEATS, HEAT_LABEL, asHeat, hasFeelings, heatBelow, moodsFor, romanceAllowed, splitBurst, storyPitches,
  vibeSummary, type Vibe,
} from "@/lib/presence/persona";
import { safeFilename, transcriptMarkdown } from "@/lib/export";
import {
  allMuses, attachEmbeddings, circleOf, deleteCircle, deleteConversation,
  deleteFrom, deleteMemory, deleteMessage, deleteMuse, download, editMemory, editMessage,
  editMuse, feelingsOf, findMuse, forgetAll, inTab, insertAfter, isEdited, isMediaCaption,
  membersOf, memoriesOf, needsEmbedding, newMessage, paced, parseBackup, quoteOf, react, readMedia, readReaction,
  resetMuse, rewindTo, sentPhoto, sentSong, splitMediaLines,
  setFeelings, typingMs,
  type MediaAllowed, type SoloCircle, type SoloMessage, type SoloMuse, type SoloState,
} from "@/lib/solo/store";
import { ensureAvatar, makePicture, recordVoiceNote, voiceFor } from "@/lib/solo/media";
import { NUDGE_STALE_MS, addPoint, bondOf, markRoughTexted, roughDue, saidBye, advanceLife, markStarted, nudgeAt, planDue, readPoint, unlock } from "@/lib/solo/life";
import { Persister, mergeStates, onOtherTabWrite } from "@/lib/solo/sync";
import { Account, type CloudStatus } from "@/components/Account";
import { browserIo, rememberSignIn, signedInEmail, syncOnce } from "@/lib/solo/cloud";
import { embedTexts, learnFrom } from "@/lib/solo/learn";
import { PHOTO_ONLY, savePhoto } from "@/lib/solo/photos";
import { VIDEO_ONLY, filesOf, keepAttachment } from "@/lib/solo/attach";
import { canStoreImages, deleteImages } from "@/lib/solo/backend";
import { MAX_MESSAGE, cutoffFrom, prepareTurn, primeRecall, streamReply, withAppMessage } from "@/lib/solo/turn";
import { canListen } from "@/lib/voice/listener";
import { settingsOf } from "@/lib/proactive/client";
import { speaker } from "@/lib/voice/speaker";

/** The circles live under the tabs too, as their own. */
const CIRCLES_TAB = "Circles";

/* Solo MUSE — the whole product with no database and no account.
 *
 * Everything lives in this browser: the conversations, the memories, the
 * relationship. One server function does the model call, because the API key
 * must not be shipped to the client (§50).
 *
 * What this trades away is real: no accounts, so no second device and no way to
 * recover a cleared browser. What it keeps is the thing the product is for —
 * personalities that remember you and get more personal as you talk.
 */

/* Accepts a function of the current state as well as a plain value, so a caller
   that writes back after an await cannot resurrect a stale snapshot. */
export type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

/** What /api/solo/chat accepts for one message. Enforced here too, because a
 *  stored message the route rejects is not a failed send -- it stays in the
 *  window and fails every send after it. */

type View =
  | { kind: "home" }
  | { kind: "tab"; tab: string }
  | { kind: "chat"; museId: string }
  /* A live call. Never restored by a reload or by forward: a call needs the
     tap that unlocks audio and the mic, so arriving here any other way lands
     on the conversation instead. */
  | { kind: "call"; museId: string }
  | { kind: "edit"; museId: string }
  | { kind: "memories"; museId: string }
  | { kind: "story"; museId: string }
  | { kind: "look"; museId: string }
  | { kind: "scrapbook"; museId: string }
  | { kind: "account" }
  /* `tab` is where the new person goes when they were made from inside one. */
  | { kind: "import"; tab?: string }
  | { kind: "invent"; tab?: string }
  | { kind: "figure"; tab?: string }
  | { kind: "circle"; circleId: string }
  | { kind: "new-circle" }
  | { kind: "edit-circle"; circleId: string };

/** What each history entry carries. `depth` is how many screens sit above
 *  home, so back knows whether there is anywhere inside the app to go. */
type Entry = { muse: 1; view: View; depth: number };

function asEntry(s: unknown): Entry | null {
  return s && typeof s === "object" && (s as Entry).muse === 1 ? (s as Entry) : null;
}

/** A view that cannot be re-entered without a tap, turned into where it came from. */
const settled = (v: View): View => (v.kind === "call" ? { kind: "chat", museId: v.museId } : v);

const depthNow = () => asEntry(window.history.state)?.depth ?? 0;

/* Unread, the way a chat list counts it: texts of theirs since you last had
   that chat open. Kept per device. */
const seenKey = (id: string) => `muse-seen-${id}`;
function markSeen(id: string) {
  try { localStorage.setItem(seenKey(id), String(Date.now())); } catch { /* the count just stays */ }
}
function seenAt(id: string): number | null {
  try { const v = localStorage.getItem(seenKey(id)); return v ? Number(v) : null; } catch { return null; }
}

export default function SoloPage() {
  const [state, setState] = useState<SoloState | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  /* Opening a chat reads it, and so does leaving it: what arrived while you
     were in it is not unread. */
  const thread = view.kind === "chat" ? view.museId : view.kind === "circle" ? view.circleId : null;
  const lastThread = useRef<string | null>(null);
  useEffect(() => {
    if (lastThread.current && lastThread.current !== thread) markSeen(lastThread.current);
    if (thread) markSeen(thread);
    lastThread.current = thread;
  }, [thread]);

  /* Every screen is a history entry.
   *
   * Screens used to change in memory only, so the browser had one entry for
   * the whole app and the phone's back gesture left the site from inside a
   * conversation. Now opening something pushes an entry, and back -- the
   * browser's, the phone's, or the arrow on screen -- pops to wherever you
   * came from, down to the home screen. Only back from home leaves.
   *
   * Moving sideways (switching tabs, a wizard turning into the chat it made)
   * replaces the entry instead, so back never walks through every tab you
   * glanced at. */
  const go = (next: View) => {
    window.history.pushState({ muse: 1, view: next, depth: depthNow() + 1 } satisfies Entry, "");
    setView(next);
  };
  const swap = (next: View) => {
    window.history.replaceState({ muse: 1, view: next, depth: depthNow() } satisfies Entry, "");
    setView(next);
  };
  const back = () => {
    if (depthNow() > 0) window.history.back();
    else swap({ kind: "home" });
  };

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const entry = asEntry(e.state);
      setView(entry ? settled(entry.view) : { kind: "home" });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  /* Whether the last write actually landed. Everything in here is one
     localStorage key that only grows, and when the browser finally refuses it
     the app carries on working perfectly for the rest of the session and loses
     the lot on reload. Silence there is the worst failure the product has. */
  const [saveIssue, setSaveIssue] = useState<null | "quota" | "unavailable" | "nearly" | "corrupt">(null);

  /* One per page: it remembers what disk looked like when this tab last read
     or wrote it, which is what makes a second tab merge instead of overwrite. */
  const persist = useRef<Persister | null>(null);
  /* The newest state, for the listeners below, which outlive any one render. */
  const latestState = useRef<SoloState | null>(null);
  useLayoutEffect(() => { latestState.current = state; });

  /* Deliberately not a lazy useState initializer: this runs during SSR too,
     where there is no localStorage, so the server and the client's first
     render must both start from null and swap in the real state after mount
     -- otherwise hydration sees different markup from the two passes. */
  /* A reload keeps the screen it was on: the entry survives it, and so do the
     ones behind it, so back still works afterwards. */
  useEffect(() => {
    const p = new Persister();
    persist.current = p;
    /* IndexedDB opens asynchronously; nothing renders until it has been read,
       so the first paint is never an empty state that flips a moment later. */
    const entry = asEntry(window.history.state);
    const restored = entry ? settled(entry.view) : null;
    if (entry && restored && restored !== entry.view) window.history.replaceState({ ...entry, view: restored } satisfies Entry, "");
    if (!entry) window.history.replaceState({ muse: 1, view: { kind: "home" }, depth: 0 } satisfies Entry, "");
    void p.open().then((loaded) => {
      setState(loaded);
      if (restored) setView(restored);
    });
  }, []);

  /* Saving is a consequence of the state changing, not something every call site
     remembers to do. That matters for more than tidiness: memory extraction
     writes back seconds after the turn it belongs to, and it used to hand back a
     whole state object captured before the network call. Anything the user did
     while it was in flight -- a message sent, a reply received -- was silently
     discarded when it landed. Callers now pass a function of the current state
     instead, and the save happens once, here, on whatever actually committed. */
  useEffect(() => {
    const p = persist.current;
    if (!state || !p || state === p.persisted) return;
    void p.save(state).then(({ result: saved, state: written }) => {
      /* Another copy had written in the meantime and the two were merged: show
         the merged state, which is now what is on disk -- with anything that
         changed here while the write was in flight put back on top. */
      if (written !== state) setState((cur) => (!cur || cur === state ? written : mergeStates(state, written, cur)));
      const issue = saved.ok ? (saved.nearlyFull ? "nearly" : null) : saved.reason;
      /* Only when it actually changes: setting the same value each time would
         schedule a render per save for no reason. */
      setSaveIssue((cur) => (cur === issue ? cur : issue));
    });
  }, [state]);

  const ready = state !== null;
  /* Other copies of the app, and the trip into the background.
     - storage: another tab wrote. Fold its changes in now, while they are small.
     - visible again / restored from the back-forward cache: the same, because a
       frozen phone tab hears no storage events.
     - hidden / pagehide: save whatever has not been, because on a phone that is
       the last moment any code is guaranteed to run. */
  useEffect(() => {
    const p = persist.current;
    if (!p) return;
    const pull = () => {
      const cur = latestState.current;
      if (!cur) return;
      void p.refresh(cur).then((next) => {
        if (next) setState((c) => (!c || c === cur ? next : mergeStates(cur, next, c)));
      });
    };
    const flush = () => {
      const cur = latestState.current;
      if (cur && cur !== p.persisted) void p.save(cur);
    };
    const offOther = onOtherTabWrite(pull);
    const onVisibility = () => (document.visibilityState === "visible" ? pull() : flush());
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) pull(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("pageshow", onShow);
    return () => {
      offOther();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("pageshow", onShow);
    };
  }, [ready]);

  const update: Update = (next) =>
    setState((cur) => (typeof next === "function" ? next(cur as SoloState) : next));

  /* Texts a Muse sent first: collected into the thread, notification taps
     landed on the right conversation, new reasons offered to the server. */
  useOutreach(state, latestState, update, (museId) => go({ kind: "chat", museId }));

  /* Signed in: the same people and chats on every device (lib/solo/cloud.ts).
     Syncs when the app opens, a few seconds after something changes, and when
     you come back to it. Signed out, none of this does anything. */
  const [cloud, setCloud] = useState<{ email: string | null; status: CloudStatus; at: number | null }>({ email: null, status: "idle", at: null });
  const syncing = useRef(false);
  const syncAgain = useRef(false);
  async function syncCloud() {
    if (syncing.current) { syncAgain.current = true; return; }
    const cur = latestState.current;
    if (!cur) return;
    syncing.current = true;
    setCloud((c) => ({ ...c, status: "syncing" }));
    try {
      const r = await syncOnce(cur, browserIo);
      if (r.status === "ok") {
        rememberSignIn(r.email || signedInEmail());
        if (r.changed) update((c) => (c === cur ? r.merged : mergeStates(cur, r.merged, c)));
        setCloud({ email: r.email || signedInEmail(), status: "ok", at: clockNow() });
      } else if (r.status === "signed-out") {
        rememberSignIn(null);
        setCloud({ email: null, status: "idle", at: null });
      } else {
        setCloud((c) => ({ ...c, status: r.status as CloudStatus }));
      }
    } finally {
      syncing.current = false;
      if (syncAgain.current) { syncAgain.current = false; void syncCloud(); }
    }
  }
  /* Whether this device was signed in, read after mount: the server has no localStorage. */
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setCloud((c) => ({ ...c, email: signedInEmail() })); }, []);
  useEffect(() => {
    if (!cloud.email || !ready) return;
    const t = setTimeout(() => void syncCloud(), state === persist.current?.persisted ? 0 : 5000);
    return () => clearTimeout(t);
    // Again whenever the state changes; syncCloud reads the latest through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, cloud.email, ready]);
  useEffect(() => {
    if (!cloud.email) return;
    const onVisible = () => { if (document.visibilityState === "visible") void syncCloud(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.email]);

  const banner = saveIssue && state && (
    <div className={saveIssue === "nearly" ? "notice" : "notice notice-bad"} role="alert">
      <div>
        {saveIssue === "quota" && (
          <>
            <strong>This browser is full, and nothing new is being saved.</strong> Everything
            since you opened the app will be gone on reload. Take a backup now, then delete a
            conversation you have finished with to make room.
          </>
        )}
        {saveIssue === "unavailable" && (
          <>
            <strong>This browser is refusing to store anything.</strong> Private browsing does
            this, and so can a shield or cookie setting that blocks site data (in Brave: tap
            the lion, turn Shields off for this site, or open the page in a normal tab).
            Until then nothing said here will survive closing the tab.
          </>
        )}
        {saveIssue === "corrupt" && (
          <>
            <strong>Your saved data is here but couldn&apos;t be read.</strong> Nothing is being
            written over it, so it is not lost — but this session will not be saved either. If you
            have a backup file, restoring it from the home screen is the way back.
          </>
        )}
        {saveIssue === "nearly" && (
          <>
            <strong>Storage is nearly full.</strong> Take a backup while everything still fits,
            and clear out a conversation or two.
          </>
        )}
      </div>
      <button
        className="btn"
        hidden={saveIssue === "corrupt"}
        onClick={() => download(
          safeFilename("muse-backup", "json"),
          JSON.stringify(state, null, 2),
          "application/json"
        )}
      >
        Back up now
      </button>
    </div>
  );

  /* The banner has to ride above whichever view is showing -- running out of
     room mid-conversation is exactly when it matters and exactly when the user
     is not on the home screen. */
  const shell = (node: React.ReactNode) => (<>{banner}{node}</>);

  // Nothing renders until localStorage has been read, so the first paint is
  // never a wrong empty state that flips a tick later.
  if (!state) {
    return (
      <main className="shell" aria-busy="true" aria-label="Loading">
        <header className="row" style={{ justifyContent: "space-between" }}><p className="mark">Muse</p></header>
        <div className="skeleton-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton-row"><i className="skeleton skeleton-avatar" /><div><i className="skeleton skeleton-line" /><i className="skeleton skeleton-line short" /></div></div>
          ))}
        </div>
      </main>
    );
  }

  if (view.kind === "import" || view.kind === "invent") {
    return shell(
      <ImportPersona
        /* Same wizard either way. Inventing someone just skips the question it
           already knows the answer to. */
        startMode={view.kind === "invent" ? "character" : undefined}
        onCancel={back}
        onCreate={(draft) => {
          const id = `made-${Date.now()}`;
          /* The card fields are only for display; everything the model reads
             comes from `persona`, which is Presence's whole profile. */
          update({
            ...state,
            userName: state.userName ?? draft.you,
            muses: [
              {
                id,
                builtin: false,
                persona: draft,
                name: draft.them,
                description: draft.relationship?.trim() || "Built from their messages.",
                relationshipType: draft.relationship?.trim() || "someone close",
                category: view.tab ?? "Personal",
                traits: [],
              },
              ...state.muses,
            ],
          });
          swap({ kind: "chat", museId: id });
        }}
      />
    );
  }

  if (view.kind === "figure") {
    return shell(
      <BuildFigure
        userName={state.userName ?? undefined}
        onCancel={back}
        onCreate={(draft) => {
          const id = `figure-${Date.now()}`;
          update((cur) => ({
            ...cur,
            userName: cur.userName ?? draft.you,
            muses: [
              {
                id,
                builtin: false,
                persona: draft,
                name: draft.them,
                description: draft.interests?.trim() || (draft.mode === "fictional" ? "A character from a story." : "Built from what they have said in public."),
                relationshipType: draft.relationship?.trim() || "someone in public life",
                category: view.tab ?? "Public",
                traits: [],
              },
              ...cur.muses,
            ],
          }));
          swap({ kind: "chat", museId: id });
        }}
      />
    );
  }

  if (view.kind === "circle") {
    const circle = circleOf(state, view.circleId);
    if (!circle) { setView({ kind: "home" }); return null; }
    return shell(
      <CircleChat circle={circle} state={state} update={update} onBack={back}
        onEdit={() => go({ kind: "edit-circle", circleId: circle.id })} />
    );
  }

  if (view.kind === "edit-circle") {
    const circle = circleOf(state, view.circleId);
    if (!circle) { setView({ kind: "home" }); return null; }
    return shell(
      <NewCircle
        state={state}
        initial={circle}
        onCancel={back}
        onCreate={(name, memberIds) => {
          update((cur) => ({ ...cur, circles: (cur.circles ?? []).map((c) => (c.id === circle.id ? { ...c, name, memberIds } : c)) }));
          back();
        }}
      />
    );
  }

  if (view.kind === "new-circle") {
    return shell(
      <NewCircle
        state={state}
        onCancel={back}
        onCreate={(name, memberIds) => {
          const id = `circle-${Date.now()}`;
          update({
            ...state,
            circles: [
              { id, name, memberIds, createdAt: new Date().toISOString() },
              ...(state.circles ?? []),
            ],
          });
          swap({ kind: "circle", circleId: id });
        }}
      />
    );
  }

  if (view.kind === "edit") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <EditMuse
        key={muse.id}
        muse={muse}
        feelings={feelingsOf(state, muse.id)}
        /* A starter with a standing state but no profile changes is still
           something to put back, so both count. */
        resettable={
          muse.builtin && (isEdited(state, muse.id) || hasFeelings(feelingsOf(state, muse.id)))
        }
        onCancel={() => back()}
        onSave={(patch, feelings) => {
          update(setFeelings(editMuse(state, muse.id, patch), muse.id, feelings));
          back();
        }}
        onReset={() => {
          update(resetMuse(state, muse.id));
          back();
        }}
      />
    );
  }

  if (view.kind === "memories") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <Memories
        key={muse.id}
        muse={muse}
        memories={memoriesOf(state, muse.id)}
        onEdit={(id, patch) => update((cur) => editMemory(cur, id, patch))}
        onDelete={(id) => update((cur) => deleteMemory(cur, id))}
        onForgetAll={() => update((cur) => forgetAll(cur, muse.id))}
        onBack={() => back()}
      />
    );
  }

  if (view.kind === "account") {
    return shell(
      <Account
        email={cloud.email}
        status={cloud.status}
        syncedAt={cloud.at}
        onSignedIn={(email) => setCloud({ email, status: "idle", at: null })}
        onSignedOut={() => setCloud({ email: null, status: "idle", at: null })}
        onSync={() => void syncCloud()}
        place={state.place}
        onPlace={(place) => update((cur) => ({ ...cur, place: place ?? undefined }))}
        onBack={() => back()}
      />
    );
  }

  if (view.kind === "scrapbook") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(<Scrapbook muse={muse} state={state} update={update} onBack={() => back()} />);
  }

  if (view.kind === "look") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <Look
        key={muse.id}
        muse={muse}
        onSave={(look) => update((cur) => ({
          ...cur,
          muses: cur.muses.map((m) => (m.id === muse.id && m.persona ? { ...m, persona: { ...m.persona, look: look ?? undefined } } : m)),
        }))}
        onBack={() => back()}
      />
    );
  }

  if (view.kind === "story") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <Story
        key={muse.id}
        muse={muse}
        state={state}
        update={update}
        onBack={back}
        onMemories={() => swap({ kind: "memories", museId: muse.id })}
      />
    );
  }

  if (view.kind === "call") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <CallScreen
        muse={muse}
        getState={() => latestState.current ?? state}
        update={update}
        onClose={back}
      />
    );
  }

  if (view.kind === "chat") {
    const muse = findMuse(state, view.museId);
    if (!muse) { setView({ kind: "home" }); return null; }
    return shell(
      <SoloChat
        muse={muse}
        state={state}
        update={update}
        onBack={back}
        onEdit={() => go({ kind: "edit", museId: muse.id })}
        onMemories={() => go({ kind: "memories", museId: muse.id })}
        onStory={() => go({ kind: "story", museId: muse.id })}
        onLook={() => go({ kind: "look", museId: muse.id })}
        onScrapbook={() => go({ kind: "scrapbook", museId: muse.id })}
        onCall={() => {
          /* Inside the tap, before anything is awaited: mobile browsers only
             allow sound that a gesture started. */
          speaker.unlock();
          go({ kind: "call", museId: muse.id });
        }}
      />
    );
  }

  const nav = {
    onOpen: (id: string) => go({ kind: "chat", museId: id }),
    onEdit: (id: string) => go({ kind: "edit", museId: id }),
    onImport: (tab?: string) => go({ kind: "import", tab }),
    onInvent: (tab?: string) => go({ kind: "invent", tab }),
    onFigure: (tab?: string) => go({ kind: "figure", tab }),
    onOpenCircle: (id: string) => go({ kind: "circle", circleId: id }),
    onNewCircle: () => go({ kind: "new-circle" }),
    onTab: (tab: string) => go({ kind: "tab", tab }),
    onAccount: () => go({ kind: "account" }),
    cloudEmail: cloud.email,
  };

  if (view.kind === "tab") {
    return shell(<SoloTab
        state={state} update={update} tab={view.tab} onHome={back} {...nav}
        /* Sideways, so back from any tab is one step to home. */
        onTab={(tab) => swap({ kind: "tab", tab })}
      />);
  }

  return shell(<SoloHome state={state} update={update} {...nav} />);
}

/* ------------------------------------------------------------------ home */

type Nav = {
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  /** With a tab, whoever is made goes straight into it. */
  onImport: (tab?: string) => void;
  onInvent: (tab?: string) => void;
  onFigure: (tab?: string) => void;
  onOpenCircle: (id: string) => void;
  onNewCircle: () => void;
  onTab: (tab: string) => void;
  onAccount: () => void;
  /** Set when this device is signed in and syncing. */
  cloudEmail: string | null;
};

const MADE_BLURB = "Built from your chats, from public life, or made up";
const CIRCLES_BLURB = "Group chats, with whoever you put in the room";

function blurbOf(tab: string): string {
  if (tab === MADE_TAB) return MADE_BLURB;
  if (tab === CIRCLES_TAB) return CIRCLES_BLURB;
  return TABS.find((t) => t.id === tab)?.blurb ?? "";
}

/* The home screen is doors, not people.
 *
 * It used to lay every starter out in three long sections -- twenty cards
 * reads as a list to get through rather than people you know. Now each group
 * is a tile, and the people are inside it. The only faces here are the few you
 * were talking to most recently, because opening a tab to carry on a
 * conversation you had an hour ago is a tap too many. */
function SoloHome({
  state, update, onOpen, onImport, onInvent, onFigure, onOpenCircle, onNewCircle, onTab, onAccount, cloudEmail,
}: { state: SoloState; update: Update } & Nav) {
  const muses = allMuses(state);
  const circles = state.circles ?? [];

  /* Every conversation, people and groups together: pinned first, then the most
     recent; searchable; and an archive for what is put away (lib/solo/chatlist.ts). */
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const chats = [
    ...muses.filter((m) => (state.conversations[m.id]?.length ?? 0) > 0).map((m) => ({ id: m.id, circle: undefined as SoloCircle | undefined, muse: m })),
    ...circles.filter((c) => (state.conversations[c.id]?.length ?? 0) > 0).map((c) => ({ id: c.id, circle: c, muse: undefined as SoloMuse | undefined })),
  ];
  const infos = chats.flatMap((c) => {
    const info = chatInfo(state, c.id, c.circle);
    return info ? [{ id: c.id, name: c.circle ? c.circle.name : c.muse!.name, preview: info.preview, at: Date.parse(info.last.at), unread: info.unread }] : [];
  });
  const { main, archived } = arrange(infos, { pinned: state.pinned, archived: state.archived, query });
  const rowFor = (id: string) => chats.find((c) => c.id === id)!;
  const renderRow = (id: string) => {
    const c = rowFor(id);
    return (
      <ChatRow key={id} state={state} id={id} muse={c.muse} circle={c.circle}
        pinned={!!state.pinned?.includes(id)} archived={!!state.archived?.includes(id)}
        onOpen={c.circle ? onOpenCircle : onOpen}
        onPin={() => update((cur) => togglePin(cur, id))}
        onArchive={() => update((cur) => toggleArchive(cur, id))} />
    );
  };

  const inCircles = [...new Set(circles.flatMap((c) => c.memberIds))]
    .map((id) => findMuse(state, id))
    .filter((m): m is SoloMuse => Boolean(m));

  const tiles = [
    ...TABS.map((t) => ({ id: t.id, people: inTab(state, t.id), count: `${inTab(state, t.id).length} people` })),
    { id: MADE_TAB, people: inTab(state, MADE_TAB), count: countOf(inTab(state, MADE_TAB).length, "person", "people") },
    { id: CIRCLES_TAB, people: inCircles, count: countOf(circles.length, "circle", "circles") },
  ];

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Muse</p>
        <button className="link-btn" onClick={onAccount} style={{ textDecoration: "none", fontSize: "0.78rem" }}>
          {cloudEmail ? `synced · ${cloudEmail}` : "this browser only · sign in to sync"}
        </button>
      </header>

      {!state.userName && <Welcome count={muses.length} onStart={(name) => update({ ...state, userName: name })} />}

      {state.userName && (
        <>
          {/* The people you are already talking to come first. Making someone
              new is the rarer thing, and four full-width panels of it pushed
              your own chats below the fold on a phone. */}
          {chats.length > 0 && (
            <>
              <h2 className="section-title">Chats</h2>
              {chats.length >= 3 && (
                <input type="search" className="input chat-search" value={query} placeholder="Search chats" aria-label="Search chats"
                  onChange={(e) => setQuery(e.target.value)} />
              )}
              <ul className="chat-list">{main.map((r) => renderRow(r.id))}</ul>
              {query && !main.length && !archived.length && <p className="fine">Nothing matches &ldquo;{query}&rdquo;.</p>}
              {archived.length > 0 && (
                <>
                  <button className="link-btn archived-toggle" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
                    Archived ({archived.length}) {showArchived ? "\u25b4" : "\u25be"}
                  </button>
                  {showArchived && <ul className="chat-list">{archived.map((r) => renderRow(r.id))}</ul>}
                </>
              )}
            </>
          )}

          <h2 className="section-title">Make someone new</h2>
          <MakeRow onImport={() => onImport()} onFigure={() => onFigure()} onInvent={() => onInvent()} onNewCircle={onNewCircle} />

          <h2 className="section-title">Your people</h2>
          <div className="tab-tiles">
            {tiles.map((t) => (
              <button key={t.id} className="tab-tile" onClick={() => onTab(t.id)}>
                <div className="stack-avatars" aria-hidden>
                  {t.people.slice(0, 3).map((p) => <Avatar key={p.id} name={p.name} image={p.avatar?.id} />)}
                </div>
                <div className="tab-tile-text">
                  <b>{t.id}</b>
                  <span>{blurbOf(t.id)}</span>
                </div>
                <em>{t.count}</em>
              </button>
            ))}
          </div>

          <h2 className="section-title">Texts from them</h2>
          <OutreachPanel state={state} update={update} />

          <div className="row" style={{ marginTop: "2.5rem", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              className="btn-ghost"
              onClick={() => download(
                safeFilename("muse-solo", "json"),
                JSON.stringify(state, null, 2),
                "application/json"
              )}
            >
              Export everything
            </button>

            {/* The other half of that button. Without it the export was a file
                nobody could use, and a cleared browser was total loss even for
                someone who had backed up. */}
            <label className="btn-ghost" style={{ cursor: "pointer" }}>
              Restore a backup
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const result = parseBackup(await file.text());
                  if (!result.ok) { alert(result.error); return; }
                  const { people, messages, memories, circles } = result.summary;
                  const has = (state.muses.length || Object.keys(state.conversations).length);
                  const warning = has
                    ? "\n\nThis REPLACES everything currently in this browser. Export first if you are not sure."
                    : "";
                  if (!confirm(
                    `Restore ${people} ${people === 1 ? "person" : "people"}, ${messages} messages, ` +
                    `${memories} memories and ${circles} ${circles === 1 ? "circle" : "circles"}?${warning}`
                  )) return;
                  update(result.state);
                }}
              />
            </label>
            <button
              className="link-btn"
              onClick={() => {
                /* It also deletes every character the user built from an
                   export, which the old wording never mentioned. */
                const built = state.muses.length;
                const msg = built
                  ? `Delete everything in this browser?\n\nThat includes the ${built} ${built === 1 ? "character" : "characters"} you built from a chat export, every conversation, and everything they remember. It cannot be undone.`
                  : "Delete every conversation and memory in this browser? This cannot be undone.";
                if (!confirm(msg)) return;
                update({ userName: state.userName, muses: [], conversations: {}, memories: [] });
              }}
            >
              Delete everything
            </button>
          </div>
        </>
      )}

      <p className="fine" style={{ marginTop: "2.5rem" }}>
        Every Muse is an AI.{" "}
        {cloudEmail
          ? "You're signed in, so a copy of your people, chats and memories is stored on the server to sync between your devices. Photos, voice notes and videos stay on the device that made them."
          : "Your people, conversations and memories are never stored on a server — clearing this browser's data deletes them all, and there is no way to get them back."}
        {settingsOf(state).proactiveEnabled &&
          " The one exception: a text someone has scheduled to send you waits on the server until it is sent."}
      </p>
    </main>
  );
}

/* One tab's people. The strip across the top switches tabs without going back
 * through home, which is how people actually browse -- "who's in family,
 * actually who's in close friends". */
function SoloTab({
  state, update, tab, onHome, onOpen, onImport, onInvent, onFigure, onOpenCircle, onNewCircle, onTab,
}: { state: SoloState; update: Update; tab: string; onHome: () => void } & Nav) {
  const all = [...TABS.map((t) => t.id as string), MADE_TAB, CIRCLES_TAB];
  const people = tab === CIRCLES_TAB ? [] : inTab(state, tab);
  const circles = state.circles ?? [];

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <button className="link-btn" onClick={onHome} style={{ textDecoration: "none" }}>← Home</button>
        <span className="fine">no account · this browser only</span>
      </header>

      <nav className="tab-strip" aria-label="Your people">
        {all.map((t) => (
          <button key={t} className="tab-pill" aria-current={t === tab ? "page" : undefined} onClick={() => onTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <h1 className="display" style={{ fontSize: "1.9rem", marginTop: "1.75rem" }}>{tab}</h1>
      <p className="lede">{blurbOf(tab)}</p>

      {tab === CIRCLES_TAB ? (
        <>
          {circles.length ? (
            <div className="card-grid">
              {circles.map((c) => (
                <CircleCard key={c.id} circle={c} state={state} update={update} onOpen={onOpenCircle} />
              ))}
            </div>
          ) : (
            <div className="empty"><p>No circles yet. Put two or more people in a room and they talk to each other, not just to you.</p></div>
          )}
          <div className="make-row" style={{ marginTop: "1rem" }}>
            <button className="make" onClick={onNewCircle}>
              <b>Start a circle</b>
              <span>Two or more, in a room together</span>
            </button>
          </div>
        </>
      ) : (
        <>
          {people.length ? (
            <div className="card-grid">
              {people.map((m) => (
                <MuseCard key={m.id} muse={m} state={state} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className="empty"><p>Nobody here yet.</p></div>
          )}
          {/* Made from here, they land here. Made from the home screen they go
              under your own tab, and either way they can be moved later. */}
          <h2 className="section-title">{tab === MADE_TAB ? "Make someone new" : `Add someone to ${tab}`}</h2>
          {tab === MADE_TAB ? (
            <MakeRow onImport={() => onImport()} onFigure={() => onFigure()} onInvent={() => onInvent()} />
          ) : (
            <MakeRow onImport={() => onImport(tab)} onFigure={() => onFigure(tab)} onInvent={() => onInvent(tab)} />
          )}
          <p className="fine" style={{ marginTop: "1rem" }}>
            Move anyone to a different tab from their edit screen.
          </p>
        </>
      )}
    </main>
  );
}

/* A strip, not the three full-height panels this used to be. Those pushed the
   people you actually talk to 1,329px down on a phone. */
function MakeRow({
  onImport, onFigure, onInvent, onNewCircle,
}: { onImport: () => void; onFigure: () => void; onInvent: () => void; onNewCircle?: () => void }) {
  return (
    <div className="make-row">
      <button className="make" onClick={onImport}>
        <b>From a chat export</b>
        <span>Reads how they actually wrote</span>
      </button>
      <button className="make" onClick={onFigure}>
        <b>Someone in public life</b>
        <span>Any celebrity, creator or character</span>
      </button>
      {/* This was always possible and had no door. You had to open "From a chat
          export", get to the second question, and pick "Someone I made up" --
          behind a button that promises a file upload. */}
      <button className="make" onClick={onInvent}>
        <b>Someone you make up</b>
        <span>Invent them — no export needed</span>
      </button>
      {onNewCircle && (
        <button className="make" onClick={onNewCircle}>
          <b>A circle</b>
          <span>Two or more, in a room together</span>
        </button>
      )}
    </div>
  );
}

function CircleCard({
  circle, state, update, onOpen,
}: { circle: SoloCircle; state: SoloState; update: Update; onOpen: (id: string) => void }) {
  const members = membersOf(state, circle);
  return (
    <div className="card-wrap">
      <button className="muse-card" onClick={() => onOpen(circle.id)}>
        <div className="stack-avatars">
          {members.slice(0, 3).map((m) => <Avatar key={m.id} name={m.name} image={m.avatar?.id} />)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{circle.name}</h3>
          <span className="rel">{members.map((m) => m.name).join(", ")}</span>
          <p>
            {circle.topic?.trim() ? `About ${circle.topic.trim()} · ` : ""}
            {state.conversations[circle.id]?.length ?? 0} messages
          </p>
        </div>
      </button>
      {/* Attached to its own card rather than pooled underneath the whole grid,
          where "delete The Group Chat" sat next to a card it had no visible
          relationship to. */}
      <div className="card-actions">
        <button
          onClick={() => {
            if (confirm(`Delete the circle "${circle.name}" and its conversation? The people in it are kept.`)) {
              update((cur) => deleteCircle(cur, circle.id));
            }
          }}
        >
          delete
        </button>
      </div>
    </div>
  );
}

/* Timing inside a reply, which runs long after any render. Kept out here so the
   component's purity check does not mistake it for something done while
   rendering. */
const clockNow = () => Date.now();
const TYPING_LEAD = 15_000;
const WINDOW = 120;
const chance = (p: number) => Math.random() < p;
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** Resolves once the last text of a burst is due on screen, or on abort. */
async function untilShown(at: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < at && !signal.aborted) await new Promise((r) => setTimeout(r, Math.min(400, at - Date.now())));
}

function countOf(n: number, one: string, many: string): string {
  return n === 0 ? "none yet" : `${n} ${n === 1 ? one : many}`;
}

/* No edit or delete links under the card any more: they sat one mis-tap from
   "delete chat" on a phone, and they are all in the chat's ⋯ menu now. */
/* What a row says: the last line as a preview, and how many of theirs you have
   not seen. Null for a conversation with nothing shown yet. */
function chatInfo(state: SoloState, id: string, circle?: SoloCircle) {
  const now = clockNow();
  const shown = (state.conversations[id] ?? []).filter((m) => !m.showAt || Date.parse(m.showAt) <= now);
  const last = shown.at(-1);
  if (!last) return null;
  const label = last.voiceNote ? "\u{1F3A4} Voice message" : last.video ? "\u{1F3A5} Video" : last.image ? "\u{1F4F7} Photo" : last.song ? `\u{1F3B5} ${last.song.title}` : last.content;
  const who = last.from === "user" ? "You: " : circle && last.speakerId ? `${findMuse(state, last.speakerId)?.name.split(" ")[0] ?? ""}: ` : "";
  /* Never opened since this was added: only what they said after your last text counts. */
  const seen = seenAt(id) ?? Date.parse(shown.findLast((m) => m.from === "user")?.at ?? "") ?? 0;
  const unread = Math.min(99, shown.filter((m) => m.from !== "user" && Date.parse(m.at) > (Number.isFinite(seen) ? seen : 0)).length);
  return { last, preview: `${who}${label}`, unread };
}

/* One line of the chat list: who, the last thing said, when, and how many of
   theirs you have not seen. Swipe it left on a phone (or hover it on a computer)
   to pin it or put it away. */
const SWIPE_OPEN = -152;
function ChatRow({
  state, id, muse, circle, pinned, archived, onOpen, onPin, onArchive,
}: {
  state: SoloState; id: string; muse?: SoloMuse; circle?: SoloCircle;
  pinned: boolean; archived: boolean;
  onOpen: (id: string) => void; onPin: () => void; onArchive: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; from: number; sideways: boolean | null } | null>(null);
  const info = chatInfo(state, id, circle);
  if (!info) return null;
  const { last, preview, unread } = info;
  const members = circle ? membersOf(state, circle) : [];

  const touchStart = (e: React.TouchEvent) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, from: dx, sideways: null }; };
  const touchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const mx = e.touches[0].clientX - s.x, my = e.touches[0].clientY - s.y;
    /* A drag that turns out to be a scroll is a scroll. */
    if (s.sideways === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) s.sideways = Math.abs(mx) > Math.abs(my);
    if (!s.sideways) return;
    setDragging(true);
    setDx(Math.max(SWIPE_OPEN, Math.min(0, s.from + mx)));
  };
  const touchEnd = () => {
    const was = start.current?.sideways;
    start.current = null;
    setDragging(false);
    if (was) setDx((cur) => (cur < SWIPE_OPEN / 2 ? SWIPE_OPEN : 0));
  };

  return (
    <li className="chat-swipe" data-open={dx ? "1" : undefined} onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={touchEnd}>
      <div className="chat-actions">
        <button className="chat-action pin" onClick={() => { setDx(0); onPin(); }} tabIndex={-1}>{pinned ? "Unpin" : "Pin"}</button>
        <button className="chat-action archive" onClick={() => { setDx(0); onArchive(); }} tabIndex={-1}>{archived ? "Unarchive" : "Archive"}</button>
      </div>
      <button className={dragging ? "chat-row dragging" : "chat-row"} style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onClick={() => { if (dx) setDx(0); else onOpen(id); }}>
        {circle
          ? <div className="stack-avatars" aria-hidden>{members.slice(0, 2).map((m) => <Avatar key={m.id} name={m.name} image={m.avatar?.id} />)}</div>
          : <Avatar name={muse!.name} image={muse!.avatar?.id} ring={unread > 0} />}
        <div className="chat-row-text">
          <div className="chat-row-top">
            <b>{pinned && <span className="chat-row-pin" role="img" aria-label="Pinned">{"\u{1F4CC}"} </span>}{circle ? circle.name : muse!.name}</b>
            <span className={unread ? "chat-row-time unread" : "chat-row-time"}>{ago(Date.parse(last.at))}</span>
          </div>
          <div className="chat-row-bottom">
            <span className="chat-row-preview">{preview}</span>
            {unread > 0 && <span className="chat-row-badge" aria-label={`${unread} unread`}>{unread}</span>}
          </div>
        </div>
      </button>
    </li>
  );
}

function MuseCard({
  muse, state, onOpen,
}: {
  muse: SoloMuse;
  state: SoloState;
  onOpen: (id: string) => void;
}) {
  const log = state.conversations[muse.id] ?? [];
  const last = log[log.length - 1];
  const when = last ? ago(new Date(last.at).getTime()) : "";

  return (
    <div className="card-wrap">
    <button className="muse-card" onClick={() => onOpen(muse.id)}>
      <Avatar name={muse.name} image={muse.avatar?.id} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: "0.5rem", justifyContent: "space-between" }}>
          <h3>{muse.name}</h3>
          {when && <span className="stamp">{when}</span>}
        </div>
        <span className="rel">{muse.relationshipType}</span>
        <p style={last ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}>
          {last ? `${last.from === "user" ? "You: " : ""}${last.content}` : muse.description}
        </p>
        {!last && muse.traits?.length ? (
          <div className="tags">
            {muse.traits.slice(0, 4).map((t) => <span className="tag" key={t}>{t}</span>)}
          </div>
        ) : null}
      </div>
    </button>

    </div>
  );
}

/* ------------------------------------------------------------------ chat */

function SoloChat({
  muse, state, update, onBack, onEdit, onMemories, onCall, onStory, onLook, onScrapbook,
}: {
  muse: SoloMuse;
  state: SoloState;
  update: Update;
  onBack: () => void;
  onEdit: () => void;
  onMemories: () => void;
  onCall: () => void;
  onStory: () => void;
  onLook: () => void;
  onScrapbook: () => void;
}) {
  const log = state.conversations[muse.id] ?? [];
  /* The message whose actions are open. One at a time, like any chat app. */
  const [picked, setPicked] = useState<string | null>(null);
  const [canPhoto, setCanPhoto] = useState(false);
  useEffect(() => { void canStoreImages().then(setCanPhoto); }, []);
  const [canCall, setCanCall] = useState(true);
  // Read after mount: the server render has no window to ask.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setCanCall(canListen()), []);
  /* The text lives in the textarea, not in state: a keystroke that set state
     re-rendered the whole thread, and typing lagged in a long conversation.
     Only whether there is anything in it is state. */
  const [hasDraft, setHasDraft] = useState(false);
  const [streaming, setStreaming] = useState("");
  /* Making something to send that is not a text: shown instead of "typing". */
  const [sending, setSending] = useState<"photo" | "voice" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A photo or video chosen but not sent yet. */
  const attach = useAttach(setError);
  /* Some failures are worth another go and some are not. Offering "Try again"
     on a prompt-level block just runs the user into the same wall. */
  const [canRetry, setCanRetry] = useState(true);
  /* A filter stopped the reply: the "keep it going" sheet shows instead of a bare error. */
  const [blocked, setBlocked] = useState(false);
  /* A milder heat for the next reply only, after a block. */
  const heatOnce = useRef<string | undefined>(undefined);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<SoloMessage | null>(null);
  const foot = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  /* A reply can start seconds after the send that asked for it, and a second
     text may have landed in between. It reads the state as it is when it
     starts, not the render that scheduled it. */
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  });

  /* Owed a reply: the thread ends with something the user said. Checked on
     opening the chat and on coming back to the app, so a reply interrupted by
     leaving, a reload or a dead connection is picked up rather than lost. */
  const loop = useReplyLoop(muse.id, reply, () => {
    const end = (latest.current.conversations[muse.id] ?? []).at(-1);
    /* A reaction is an answer: nothing is owed to a message she reacted to. */
    return end?.from === "user" && !end.reactions?.muse;
  });

  const vibe: Vibe = state.vibes?.[muse.id] ?? DEFAULT_VIBE;
  /* Romantic is on here, and allowed for this character. */
  const romanceOn = vibe.mood === "flirty" && !!muse.persona && romanceAllowed(muse.persona);
  const setVibe = (next: Vibe) =>
    update({ ...state, vibes: { ...(state.vibes ?? {}), [muse.id]: next } });

  /* Standing state, set on the edit screen and unchanged by anything here. Read
     fresh on every render so a change made in the middle of a conversation
     applies to the next message rather than the next reload. */
  const feelings = feelingsOf(state, muse.id);

  /* Texts still being "typed": saved, not shown yet. The clock only moves when
     the next one is due, so nothing re-renders while nothing is changing. */
  const [clock, setClock] = useState(() => Date.now());
  const shown = log.filter((m) => !m.showAt || Date.parse(m.showAt) <= clock);
  /* "Typing" only in the last stretch before the next one shows: a text sent
     for a minute from now should arrive out of nowhere, not after a minute of dots. */
  /* Only the latest messages are drawn: every keystroke re-renders the thread,
     and 400 bubbles made typing lag. Older ones on request. */
  const [limit, setLimit] = useState(WINDOW);
  const from = Math.max(0, shown.length - limit);
  const typingNext = log.some((m) => m.showAt && Date.parse(m.showAt) > clock && Date.parse(m.showAt) - clock <= TYPING_LEAD);
  useEffect(() => {
    const due = log.map((m) => (m.showAt ? Date.parse(m.showAt) : 0)).filter((t) => t > clock);
    if (!due.length) return;
    const next = Math.min(...due);
    const wake = next - TYPING_LEAD > Date.now() ? next - TYPING_LEAD : next;
    const t = setTimeout(() => setClock(Date.now()), Math.max(30, wake - Date.now() + 20));
    return () => clearTimeout(t);
    // Reschedules when a message arrives or the clock moves; that is all that changes when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.length, clock]);

  /* She is starting a plan made together: typing, without a reply owed. */
  const [starting, setStarting] = useState(false);
  const typing = (loop.busy || typingNext || starting) && !streaming;
  useFollow(shown.length * 2 + (typing ? 1 : 0), streaming, shown.at(-1)?.from === "user");

  const memoriesFor = state.memories.filter((m) => m.museId === muse.id);

  /* Memories written before recall worked on meaning have no vector, and
     ranking only uses vectors when every candidate has one -- so a single old
     memory would hold the whole character on word overlap forever. Filled in
     quietly on open, a batch at a time, and harmless if it never finishes. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = needsEmbedding(state, muse.id);
      if (!pending.length) return;
      const vecs = await embedTexts(pending.map((m) => m.content));
      if (!vecs || cancelled) return;
      const patch: Record<string, number[] | null> = {};
      pending.forEach((m, i) => { patch[m.id] = vecs[i]; });
      update((cur) => attachEmbeddings(cur, patch));
    })();
    return () => { cancelled = true; };
    /* Deliberately keyed on the count rather than on `state`: this should run
       when there is new work, not on every keystroke that changes anything. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muse.id, memoriesFor.length]);

  /* Her life moves on about once a day; opening the chat is when it is checked. */
  useEffect(() => {
    void advanceLife(latest.current, muse.id, update);
    /* And the first time, a picture of them. */
    void ensureAvatar(latest.current, muse.id, update);
    // Once per conversation opened; it reads the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muse.id]);


  const nameOf = (m: SoloMessage) => (m.from === "user" ? "You" : muse.name);

  async function sendDraft() {
    const content = (box.current?.value ?? "").trim();
    if (!content && !attach.draft) return;
    const file = attach.take();
    const base = newMessage("user", content || (file?.kind === "video" ? VIDEO_ONLY : PHOTO_ONLY), { replyTo: replyTo?.id });
    let msg: SoloMessage = base;
    if (file) {
      /* The file first, then the message that points at it. */
      const kept = await keepAttachment(file, base.id);
      URL.revokeObjectURL(file.url);
      if (!kept) { setError(`Couldn't keep that ${file.kind} on this device. Try again.`); return; }
      msg = { ...base, ...kept };
    }
    update((cur) => ({
      ...cur,
      conversations: { ...cur.conversations, [muse.id]: [...(cur.conversations[muse.id] ?? []), msg] },
    }));
    if (box.current) box.current.value = "";
    setHasDraft(false);
    setReplyTo(null);
    setError(null);
    if (box.current) box.current.style.height = "auto";
    /* Memory recall starts now, during the pause, rather than when the reply does. */
    primeRecall([...log, msg]);
    loop.schedule();
  }

  /* Answers whatever the user has said since the last reply -- one message or
     several. Does nothing if the thread already ends with a reply. */
  async function reply(signal: AbortSignal) {
    const startedAt = clockNow();
    const s = latest.current;
    const thread = s.conversations[muse.id] ?? [];
    const last = thread[thread.length - 1];
    if (!last || last.from !== "user") return;

    setError(null);
    setCanRetry(true);
    setBlocked(false);
    const heatNow = heatOnce.current;
    heatOnce.current = undefined;

    /* The request is built in lib/solo/turn.ts, shared with voice calls, so
       a call is exactly this character with exactly these memories. */
    const prepared = await prepareTurn(s, muse.id, { signal, fallback: muse, canStore: canPhoto, heat: heatNow });
    if (!prepared || signal.aborted) return;
    const { person, vibe: vibeNow } = prepared;

    try {
      /* A burst of texts appears text by text once it is in, so it is not also
         streamed in as one block first. A letter or a voice note still is. */
      const regNow = REGISTERS[vibeNow.register as keyof typeof REGISTERS] ?? REGISTERS.texts;
      const outcome = await streamReply(prepared.body, signal, (soFar) => { if (!regNow.burst) setStreaming(soFar); });
      /* A reply that ended in an error is not a reply, however much of it
         arrived first. Saving the fragment is how half-sentences got into the
         thread. */
      if (!outcome.ok) {
        setError(outcome.message);
        setCanRetry(outcome.retryable);
        setBlocked(outcome.blocked === true);
        return;
      }
      if (signal.aborted) return;
      const acc = outcome.text;
      /* It only went through without the older part of the conversation:
         stop sending that part, so the next reply does not hit the same wall. */
      const cut = outcome.trimmed && cutoffFrom(prepared, outcome.trimmed);
      if (cut) update((cur) => ({ ...cur, cutoffs: { ...(cur.cutoffs ?? {}), [muse.id]: { ...(cur.cutoffs?.[muse.id] ?? {}), ...cut } } }));

      /* "[react: 😂]" first: she reacted to what she is answering. That alone
         is a whole reply when nothing more needs saying. */
      const { emoji, rest } = readReaction(acc.trim());
      if (emoji) update((cur) => react(cur, muse.id, last.id, "muse", emoji));
      const text = rest;
      /* They said bye: sometimes one more text, a minute later, out of nowhere --
         after a reply or after just a 👋. */
      const oneMore = () => {
        if (!saidBye(last.content) || !chance(0.5)) return;
        void appTurn(`(${state.userName ?? "They"} just said bye and you said bye back. A minute later, send ONE more text, the "wait, one more thing" kind: something you forgot to tell them, a tease about something you will tell them tomorrow, or one last soft or funny line. Short. Do not ask them to stay.)`, { max: 2, later: between(45_000, 90_000) });
      };
      if (!text && emoji) { oneMore(); return; }
      /* Nothing came back. Saying so, with a way to ask again, beats a thread
         that simply stops. */
      if (!text) {
        setError(`${muse.name} didn't answer that time. Try again?`);
        setCanRetry(true);
        return;
      }
      /* Presence tells a texting persona to send several short messages
         separated by a line of ---, because that is how people actually text.
         Splitting them here is what makes that instruction mean anything;
         without it the separator just shows up in the message. */
      /* Only the registers that ask for several messages get split. A letter
         or a voice note is one piece by definition, and splitting it would
         contradict the instruction the model was just given. */
      const reg = REGISTERS[vibeNow.register as keyof typeof REGISTERS] ?? REGISTERS.texts;
      const burst = person.persona ? splitBurst(text, reg.burst) : [text];
      const can = (prepared.body.can as MediaAllowed | null) ?? { photo: false, voice: false, song: false };
      const answer = await deliver(burst, can, last.id, person, signal);
      /* It only went through one step milder: said on the reply, not hidden. */
      if (outcome.softened && answer[0]) {
        const id = answer[0].id;
        const to = outcome.softened;
        update((cur) => ({ ...cur, conversations: { ...cur.conversations, [muse.id]: (cur.conversations[muse.id] ?? []).map((x) => (x.id === id ? { ...x, softened: to } : x)) } }));
      }
      if (!answer.length) {
        if (!signal.aborted) {
          setError(`${muse.name} didn't answer that time. Try again?`);
          setCanRetry(true);
        }
        return;
      }
      /* Stay "typing" until the last of them is out. */
      const lastAt = Date.parse(answer.at(-1)!.showAt!);
      await untilShown(lastAt, signal);

      /* Extraction runs after the reply is on screen and never blocks it, the
         same shape as the server app's aftercare. */
      /* A moment, once she has had it. */
      const moment = prepared.body.moment as string | null | undefined;
      if (moment) update((cur) => unlock(cur, muse.id, moment));

      void learnFrom({ museIds: [muse.id], window: [...thread, ...answer].slice(-8), state: s, update });
      oneMore();
    } catch {
      /* Lost to the page being in the background: not an error, asked again on return. */
      if (!signal.aborted && !backgroundedSince(startedAt)) setError("You're offline.");
    } finally {
      setStreaming("");
      setSending(null);
    }
  }

  /* Puts a reply into the thread, one message at a time.
   *
   * Texts go in at once, paced to appear the way someone types them. A voice
   * note or a photo has to be made first, which takes a few seconds, so the
   * texts before it go in, "recording a voice note" shows while it is made, and
   * it lands after them -- then whatever came after it. What cannot be made is
   * left out, or for a voice note, sent as the words it would have said. */
  async function deliver(
    parts: string[],
    can: MediaAllowed,
    after: string,
    person: SoloMuse,
    signal: AbortSignal,
    /** When the first of them shows; now if absent. */
    startAt?: number
  ): Promise<SoloMessage[]> {
    const left = { ...can };
    const out: SoloMessage[] = [];
    let pending: SoloMessage[] = [];
    let anchor = after;
    let nextAt = clockNow();
    const flush = () => {
      if (!pending.length || signal.aborted) return;
      const start = out.length ? Math.max(clockNow(), nextAt + typingMs(pending[0])) : Math.max(clockNow(), startAt ?? 0);
      const msgs = paced(pending, start);
      const at = anchor;
      update((cur) => insertAfter(cur, muse.id, at, msgs));
      anchor = msgs.at(-1)!.id;
      nextAt = Date.parse(msgs.at(-1)!.showAt!);
      out.push(...msgs);
      pending = [];
    };

    /* One thing besides texts per reply: a photo and a voice note and a song in
       one go is a performance, not someone texting. */
    const spent = () => { left.photo = left.voice = left.song = false; };
    for (const tagged of splitMediaLines(parts)) {
      if (signal.aborted) break;
      /* "[point: …]": a quiz question settled. Counted, and kept on the message. */
      const { point, rest: untagged } = readPoint(tagged);
      if (point) update((cur) => addPoint(cur, muse.id, point));
      /* A reaction tag that came after another tag, rather than first in the
         reply: still a reaction to what they said, never text in a bubble. */
      const { emoji, rest: raw } = readReaction(untagged);
      if (emoji && after) update((cur) => react(cur, muse.id, after, "muse", emoji));
      if (!raw) continue;
      const part = readMedia(raw);
      if (part.kind === "text") {
        pending.push({ ...newMessage("muse", part.text), ...(point ? { point } : {}) });
      } else if (part.kind === "song") {
        if (left.song) {
          spent();
          pending.push({ ...newMessage("muse", sentSong(part)), song: { title: part.title, artist: part.artist } });
        }
        if (part.caption) pending.push(newMessage("muse", part.caption));
      } else if (part.kind === "voice") {
        if (!left.voice) { pending.push(newMessage("muse", part.text)); continue; }
        spent();
        flush();
        setSending("voice");
        const note = await recordVoiceNote(part.text, await voiceFor(person, muse.id, update), signal);
        setSending(null);
        const msg = newMessage("muse", part.text);
        const id = `vn-${msg.id}`;
        pending.push(note && (await savePhoto(id, note.blob)) ? { ...msg, voiceNote: { id, seconds: note.seconds } } : msg);
      } else {
        if (left.photo) {
          spent();
          flush();
          setSending("photo");
          const pic = await makePicture(part.description, signal);
          setSending(null);
          const msg = newMessage("muse", sentPhoto(part.description));
          const id = `img-${msg.id}`;
          /* Some arrive blurred, tap to see: not knowing what it is is the pull. */
          if (pic && (await savePhoto(id, pic.blob))) pending.push({ ...msg, image: { id, w: pic.w, h: pic.h }, ...(chance(0.4) ? { veiled: true } : {}) });
        }
        if (part.caption) pending.push(newMessage("muse", part.caption));
      }
    }
    flush();
    return out;
  }

  /* A turn the app starts rather than the user: a plan beginning, a nudge
     after being left on read. She texts; nothing of theirs is answered. */
  async function appTurn(note: string, opts: { nudge?: boolean; max?: number; later?: number } = {}) {
    /* Sent for later: no "typing" while it is written, only before it shows. */
    if (!opts.later) setStarting(true);
    try {
      const signal = new AbortController().signal;
      const heatNow = heatOnce.current;
      heatOnce.current = undefined;
      const prepared = await prepareTurn(latest.current, muse.id, { fallback: muse, canStore: canPhoto, heat: heatNow });
      if (!prepared) return;
      withAppMessage(prepared, note);
      const out = await streamReply(prepared.body, signal, () => {});
      if (!out.ok) return;
      const text = readReaction(out.text.trim()).rest;
      const parts = splitBurst(text, true).slice(0, opts.max ?? 4);
      const anchor = (latest.current.conversations[muse.id] ?? []).at(-1)?.id;
      if (!parts.length) return;
      const sent = await deliver(parts, { photo: false, voice: false, song: false }, anchor ?? "", prepared.person, signal,
        opts.later ? clockNow() + opts.later : undefined);
      if (opts.nudge && sent.length) {
        const ids = new Set(sent.map((m) => m.id));
        update((cur) => ({
          ...cur,
          conversations: { ...cur.conversations, [muse.id]: (cur.conversations[muse.id] ?? []).map((m) => (ids.has(m.id) ? { ...m, nudge: true } : m)) },
        }));
      }
    } catch { /* nothing was said; the conversation is as it was */ } finally {
      setStarting(false);
    }
  }

  const startPlan = (what: string) =>
    appTurn(`(It is time for what you two planned: ${what} You start it now: text ${state.userName ?? "them"} the way you would when it is time, and get it going.)`);

  /* Left on read: she asked something and they went quiet. One more text, a
     few minutes on, while the chat is open -- never while they are typing,
     and never for a question asked long ago. */
  const drafting = useRef(false);
  useLayoutEffect(() => { drafting.current = hasDraft; });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nudgeDue = nudgeAt(log, tz);
  /* How close you have got. The banner shows once per level, per device. */
  const bond = bondOf(state, muse.id, clockNow(), tz);
  const bondKey = `muse-bond-${muse.id}`;
  const [seenBond, setSeenBond] = useState(() => { try { return Number(localStorage.getItem(bondKey)) || 0; } catch { return 0; } });
  const levelUp = bond && bond.level > seenBond ? bond : null;
  const seeBond = () => {
    if (!bond) return;
    try { localStorage.setItem(bondKey, String(bond.level)); } catch { /* the banner just shows again */ }
    setSeenBond(bond.level);
  };
  useEffect(() => {
    if (nudgeDue === null || drafting.current) return;
    const fire = () => {
      const now = Date.now();
      const thread = latest.current.conversations[muse.id] ?? [];
      if (nudgeAt(thread, tz) !== nudgeDue || now - nudgeDue > NUDGE_STALE_MS) return;
      if (document.visibilityState !== "visible" || drafting.current || loop.busy || starting) return;
      const quiet = Math.round((now - Date.parse(thread.at(-1)!.showAt ?? thread.at(-1)!.at)) / 60_000);
      void appTurn(`(${state.userName ?? "They"} has not answered your last message for about ${quiet} minutes -- maybe busy, maybe distracted, maybe just reading. Send ONE short follow-up text, the way you would: "hello??", a nudge, a joke about being left on read, or one more thought on what you asked. Light. Never a guilt trip, never sulking, never asking whether they are angry.)`, { nudge: true, max: 2 });
    };
    const t = setTimeout(fire, Math.max(0, nudgeDue - Date.now()));
    return () => clearTimeout(t);
    // Re-armed when the time it is due changes, or typing stops or starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudgeDue, hasDraft]);

  /* A bad day: when you open the chat and she had one she has not mentioned,
     she texts first, wanting you. Once per bad day, and never over a reply
     that is owed. */
  const roughSent = useRef(new Set<string>());
  useEffect(() => {
    const t = setTimeout(() => {
      const s = latest.current;
      const due = roughDue(s, muse.id);
      if (!due || roughSent.current.has(due.id) || loop.busy || starting || document.visibilityState !== "visible") return;
      if ((s.conversations[muse.id] ?? []).at(-1)?.from === "user") return;
      roughSent.current.add(due.id);
      update((cur) => markRoughTexted(cur, muse.id, due.id));
      void appTurn(`(You had a rough day today: ${due.text} You are texting ${s.userName ?? "them"} first, because you want them. Tell them what happened in your own words, a bit raw, the way you would to someone you trust: two or three short texts. You want comfort and company, not advice or solutions, and you do not ask whether they have time. Nothing is a crisis.)`, { max: 3 });
    }, 4000);
    return () => clearTimeout(t);
    // When the chat opens, and when her life moves on (a new bad day lands).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muse.id, state.lives?.[muse.id]]);

  /* A plan made together, when its time comes with the chat open: she starts
     it. Checked every minute, and never over a reply that is owed or on its
     way. If she already texted first about it, that was the start. */
  useEffect(() => {
    const check = () => {
      const s = latest.current;
      const plan = planDue(s, muse.id);
      if (!plan || loop.busy || starting) return;
      const thread = s.conversations[muse.id] ?? [];
      if (thread.at(-1)?.from === "user") return;
      const texted = thread.some((m) => m.proactive && Date.now() - Date.parse(m.at) < 3 * 3_600_000);
      update((cur) => markStarted(cur, plan.id));
      if (!texted) void startPlan(plan.content);
    };
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
    // Re-armed per conversation; reads the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muse.id, loop.busy]);

  /* Editing a message changes what the conversation was about.
   *
   * Changing the stored text alone left every reply after it answering words
   * that no longer existed, and the memory made from the old version stayed.
   * So an edit to your own latest message takes the thread back to it and asks
   * again. Further up, it asks first, because redoing from there removes
   * everything said since. Either way the edited version is read for memory. */
  function editLine(m: SoloMessage, text: string) {
    const at = log.findIndex((x) => x.id === m.id);
    const after = log.slice(at + 1);
    const redo =
      m.from === "user" &&
      (!after.some((x) => x.from === "user") ||
        confirm(
          `Redo the conversation from this message?\n\nOK takes it back to here and ${muse.name} answers the new version. The ${after.length} messages after it are removed.\n\nCancel just changes the text.`
        ));

    if (redo) {
      update((cur) => rewindTo(editMessage(cur, muse.id, m.id, text), muse.id, m.id));
      setError(null);
      loop.restart();
      return;
    }

    update((cur) => editMessage(cur, muse.id, m.id, text));
    if (m.from === "user") {
      const window = log.slice(Math.max(0, at - 7), at + 1).map((x) => (x.id === m.id ? { ...x, content: text } : x));
      void learnFrom({ museIds: [muse.id], window, state, update });
    }
  }

  function exportChat() {
    download(
      safeFilename(muse.name, "md"),
      transcriptMarkdown({
        museName: muse.name,
        relationshipType: muse.relationshipType,
        userName: state.userName,
        messages: log.map((m) => ({
          senderType: m.from === "user" ? "USER" : "MUSE",
          content: m.content,
          createdAt: new Date(m.at),
        })),
      }),
      "text/markdown"
    );
  }

  function exportPersona() {
    download(
      safeFilename(`${muse.name}-persona`, "json"),
      JSON.stringify({ format: "muse.persona/1", exportedAt: new Date().toISOString(), muse }, null, 2),
      "application/json"
    );
  }

  const lastLine = log[log.length - 1];

  return (
    <main className="shell" style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <header className="chat-head">
        <button className="link-btn" onClick={onBack} aria-label="Back" style={{ textDecoration: "none" }}>←</button>
        <Avatar name={muse.name} image={muse.avatar?.id} />
        <div className="chat-who">
          <h1>{muse.name}</h1>
          <div className="rel">
            {muse.relationshipType}
            {bond && (
              <>
                {" · "}
                <button className="inline-link" onClick={onStory}>{bond.label}</button>
              </>
            )}
            {memoriesFor.length > 0 && (
              <>
                {" · "}
                {/* The count was the only sign memory existed at all, and it led
                    nowhere. It is the obvious door, so it is the door. */}
                <button className="inline-link" onClick={onMemories}>
                  remembers {memoriesFor.length}
                </button>
              </>
            )}
            {isDefaultVibe(vibe) ? null : (
              <span style={{ color: "var(--accent)" }}> · {vibeSummary(vibe)}</span>
            )}
            {hasFeelings(feelings) && (
              <span style={{ color: "var(--muted)" }}> · {feelingsSummary(feelings)}</span>
            )}
          </div>
        </div>
        {/* Shown to everyone, so the feature is findable; a browser that cannot
            recognise speech gets the reason on the call screen, not a dead button. */}
        <button className="menu-btn call-start" aria-label={`Call ${muse.name}`} title={canCall ? `Call ${muse.name}` : "Calls need Chrome, Edge or Safari"} onClick={onCall}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
          </svg>
        </button>
        <Menu
          label={`More for ${muse.name}`}
          items={[
            { label: `Edit ${muse.name}`, onSelect: onEdit },
            { label: `You & ${muse.name}`, onSelect: onStory },
            /* A story played out together: "Up for anything", and she pitches three. */
            ...(muse.persona ? [{
              label: `Start a story with ${muse.name}`,
              onSelect: () => {
                /* Romantic stays on if it is: a love story is what it is for. */
                const flirty = vibe.mood === "flirty" || (vibe.mood === "any" && feelings.mood === "flirty");
                const loves = !!muse.persona && romanceAllowed(muse.persona);
                if (!(flirty && loves)) setVibe({ ...vibe, mood: "yes" });
                const [a, b, c] = storyPitches(3, loves && (flirty ? "all" : true));
                void appTurn(`(${state.userName ?? "They"} wants to play out a story with you, over text, the two of you in it. Pitch exactly these three premises, numbered, one or two lines each, in your own voice and your own words -- keep each one's idea, do not swap in other ones or add a fourth: 1) ${a}. 2) ${b}. 3) ${c}. Ask which one they want. Once they pick, or say their own, start it and play it fully, chapter by chapter, and remember every choice.)`);
              },
            }] : []),
            { label: `What ${muse.name} remembers`, onSelect: onMemories },
            { label: `Scrapbook with ${muse.name}`, onSelect: onScrapbook },
            /* Someone in public life, or someone made up: photos to take a look and vibe from. */
            ...(!muse.builtin && (muse.persona?.mode === "figure" || muse.persona?.mode === "character")
              ? [{ label: muse.persona.look ? `Photos of ${muse.name} (added)` : `Add photos of ${muse.name}`, onSelect: onLook }]
              : []),
            {
              label: settingsOf(state).proactiveEnabled && settingsOf(state).allowedMuseIds.includes(muse.id)
                ? `Stop ${muse.name} texting first`
                : `Let ${muse.name} text you first`,
              onSelect: () => {
                const cur = settingsOf(state);
                const on = cur.proactiveEnabled && cur.allowedMuseIds.includes(muse.id);
                void applyOutreach(state, update, {
                  proactiveEnabled: on ? cur.proactiveEnabled : true,
                  allowedMuseIds: on ? cur.allowedMuseIds.filter((x) => x !== muse.id) : [...new Set([...cur.allowedMuseIds, muse.id])],
                }, !on && !cur.proactiveEnabled);
              },
            },
            "divider",
            { label: "Save this chat", onSelect: exportChat, disabled: !log.length },
            { label: `Save ${muse.name} as a file`, onSelect: exportPersona },
            "divider",
            {
              label: "Clear this chat",
              disabled: !log.length,
              onSelect: () => {
                if (confirm(`Clear your conversation with ${muse.name}? They keep what they remember about you.`)) {
                  update(deleteConversation(state, muse.id, false));
                }
              },
            },
            {
              label: "Clear chat and memories",
              danger: true,
              disabled: !log.length && !memoriesFor.length,
              onSelect: () => {
                if (confirm(`Clear the conversation and everything ${muse.name} remembers? This cannot be undone.`)) {
                  update(deleteConversation(state, muse.id, true));
                }
              },
            },
            ...(muse.builtin ? [] : [{
              label: `Delete ${muse.name}`,
              danger: true,
              onSelect: () => {
                if (confirm(`Delete ${muse.name} completely? Their conversation and everything they remember goes too.`)) {
                  onBack();
                  update((cur) => deleteMuse(cur, muse.id));
                }
              },
            }]),
          ]}
        />
      </header>

      <div className="thread" role="log" aria-live="polite" aria-label={`Conversation with ${muse.name}`}>
        {log.length === 0 && !streaming && (
          <div className="empty" style={{ marginTop: "2rem" }}>
            <p style={{ fontFamily: "var(--serif)", fontSize: "1.1rem" }}>{muse.description}</p>
            <p className="fine">Say anything. {muse.name} will remember it next time.</p>
          </div>
        )}

        {from > 0 && (
          <button className="link-btn earlier" onClick={() => setLimit((n) => n + WINDOW)}>
            Show earlier messages
          </button>
        )}
        {shown.slice(from).map((m, j) => {
          const i = from + j;
          const run = runOf(shown, i, tz);
          const q = quoteOf(log, m);
          const replyHere = () => { setReplyTo(m); setPicked(null); box.current?.focus(); };
          /* A call shows where it started, in the same thread as everything else. */
          const callStarts = m.callId && shown.findIndex((x) => x.callId === m.callId) === i;
          const call = callStarts ? (state.calls ?? []).find((c) => c.id === m.callId) : undefined;
          return (
            <Fragment key={m.id}>
            {run.newDay && <div className="day-divider" role="separator"><span>{dayLabel(m.at, clock, tz)}</span></div>}
            {callStarts && (
              <p className="call-row">
                Voice call{call?.endedAt ? ` · ${callLength(call.durationSeconds)}` : ""}
              </p>
            )}
            <Turn id={m.id} mine={m.from === "user"} picked={picked === m.id} onPick={setPicked} onReply={replyHere}>
              {m.replyTo && (
                <QuoteBubble who={q ? nameOf(q) : ""} text={q?.content} onJump={q ? () => {
                  /* Quoting something older than what is drawn: draw it all first. */
                  if (document.getElementById(`msg-${q.id}`)) jumpTo(q.id);
                  else { setLimit(Infinity); setTimeout(() => jumpTo(q.id), 50); }
                } : undefined} />
              )}
              {m.image && <Photo id={m.image.id} w={m.image.w} h={m.image.h} veiled={m.veiled}
                onReveal={() => update((cur) => ({ ...cur, conversations: { ...cur.conversations,
                  [muse.id]: (cur.conversations[muse.id] ?? []).map((x) => (x.id === m.id ? { ...x, veiled: false } : x)) } }))} />}
              {m.video && <Video id={m.video.id} w={m.video.w} h={m.video.h} seconds={m.video.seconds} />}
              {m.voiceNote ? <VoiceNote id={m.voiceNote.id} seconds={m.voiceNote.seconds} text={m.content} />
                : m.song ? <SongCard title={m.song.title} artist={m.song.artist} />
                : m.image && (m.content === PHOTO_ONLY || isMediaCaption(m.content)) ? null
                : m.video && m.content === VIDEO_ONLY ? null
                : m.content}
              {m.edited && <span className="stamp"> · edited</span>}
              {m.interrupted && <span className="stamp"> · cut off</span>}
              {m.softened && <span className="stamp"> · kept it {m.softened === "sweet" ? "sweeter" : "softer"}</span>}
              {m.point && <span className="stamp point"> · point to {m.point === "user" ? "you" : muse.name}</span>}
              <MessageActions
                content={m.content}
                onReply={replyHere}
                onEdit={(text) => editLine(m, text)}
                onDelete={() => {
                  const files = filesOf(m);
                  if (files.length) void deleteImages(files);
                  update(deleteMessage(state, muse.id, m.id));
                }}
                onDeleteFrom={() => update(deleteFrom(state, muse.id, m.id))}
                onDone={() => setPicked(null)}
                {...(m.from === "muse" ? { onReact: (e: string) => update((cur) => react(cur, muse.id, m.id, "user", e)), reacted: m.reactions?.user } : {})}
              />
              {m.reactions && (
                <span className="reacts" aria-label="Reactions">{m.reactions.muse}{m.reactions.user}</span>
              )}
            </Turn>
            {run.last && <span className={`turn-time turn-time-${m.from === "user" ? "user" : "muse"}`}>{clockTime(m.at, tz)}</span>}
            </Fragment>
          );
        })}

        {streaming && <div className="turn turn-muse">{streaming}</div>}
        {typing && (
          <p className="typing" role="status">
            <span className="typing-dots" aria-hidden><i /><i /><i /></span>
            <span>{muse.name} {sending && !typingNext ? (sending === "photo" ? "is sending a photo" : "is recording a voice note") : "is typing"}</span>
          </p>
        )}

        {error && blocked && (
          <BlockedSheet
            name={muse.name}
            nextHeat={romanceOn && heatBelow(asHeat(vibe.heat)) ? HEAT_LABEL[heatBelow(asHeat(vibe.heat))!] : null}
            canReword={!!lastLine && lastLine.from === "user" && !lastLine.image && !lastLine.video && lastLine.content.trim().length > 0}
            onSofter={() => {
              heatOnce.current = romanceOn ? (heatBelow(asHeat(vibe.heat)) ?? undefined) : undefined;
              setBlocked(false); setError(null); loop.schedule(0);
            }}
            onReword={() => {
              if (!lastLine) return;
              if (box.current) { box.current.value = lastLine.content; box.current.focus(); }
              setHasDraft(true);
              update(deleteMessage(state, muse.id, lastLine.id));
              setBlocked(false); setError(null);
            }}
            onMoveOn={() => {
              heatOnce.current = romanceOn ? (heatBelow(asHeat(vibe.heat)) ?? undefined) : undefined;
              setBlocked(false); setError(null);
              void appTurn("(That last reply did not come through, so skip ahead: carry on from a little later -- the next morning or the next scene -- without picking up exactly where it was cut off. One or two short texts, in your own voice.)");
            }}
            onClose={() => { setBlocked(false); setError(null); }}
          />
        )}
        {error && !blocked && (
          <div style={{ marginTop: "1rem" }}>
            <p className="error" role="alert">{error}</p>
            {canRetry && lastLine?.from === "user" && (
              <button className="link-btn" onClick={() => loop.schedule(0)}>Try again</button>
            )}
            {!canRetry && (
              <button className="link-btn" onClick={onEdit}>Edit {muse.name}</button>
            )}
          </div>
        )}

        <div ref={foot} />
      </div>

      {muse.persona && (
        <div className="vibe">
          <button onClick={() => setVibeOpen(!vibeOpen)} aria-expanded={vibeOpen}>
            <span>{vibeOpen ? "Close" : "Change how this goes"}</span>
            <b>{vibeSummary(vibe)}</b>
          </button>

          {vibeOpen && (
            <div className="vibe-panel">
              <div>
                <label>What mood is {muse.name} in?</label>
                <div className="tags">
                  {Object.entries(moodsFor(muse.persona)).map(([k, v]) => (
                    <button key={k} className="tag" aria-pressed={vibe.mood === k}
                      onClick={() => setVibe({ ...vibe, mood: k })}
                      style={vibe.mood === k ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              {romanceOn && (
                <div>
                  <label>How far should it go?</label>
                  <div className="tags">
                    {HEATS.map((h) => (
                      <button key={h} className="tag" aria-pressed={asHeat(vibe.heat) === h}
                        onClick={() => setVibe({ ...vibe, heat: h })}
                        style={asHeat(vibe.heat) === h ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
                        {HEAT_LABEL[h]}
                      </button>
                    ))}
                  </div>
                  <p className="fine" style={{ margin: "0.4rem 0 0" }}>Sweet is affection. Flirty teases. Steamy builds the tension. It always cuts away like a film, and if a reply is blocked it steps down on its own.</p>
                </div>
              )}

              <div>
                <label>What do you want to talk about?</label>
                <div className="tags">
                  {Object.entries(TOPICS).map(([k, v]) => (
                    <button key={k} className="tag" aria-pressed={vibe.topic === k}
                      onClick={() => setVibe({ ...vibe, topic: k })}
                      style={vibe.topic === k ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label>How are you talking?</label>
                <div className="tags">
                  {Object.entries(PICKABLE_REGISTERS).map(([k, v]) => (
                    <button key={k} className="tag" aria-pressed={vibe.register === k}
                      onClick={() => setVibe({ ...vibe, register: k })}
                      style={vibe.register === k ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label>What {muse.name} is like</label>
                <TraitEditor
                  traits={muse.traits ?? []}
                  onChange={(traits) => update((cur) => editMuse(cur, muse.id, { traits }))}
                  suggestions={TRAIT_IDEAS}
                />
              </div>

              <p className="fine">
                <strong style={{ color: "var(--accent)" }}>
                  {isDefaultVibe(vibe)
                    ? "Nothing set — they will be however they are."
                    : `From your next message: ${vibeSummary(vibe)}.`}
                </strong>{" "}
                Mood, subject and register are for today only. Traits stay. For something standing &mdash; what they have going on at
                the moment, or where things are between you &mdash; use <em>edit</em> at the top.
              </p>
            </div>
          )}
        </div>
      )}

      {levelUp && (
        <div className="notice bond-up" role="status">
          <div>
            <strong>You and {muse.name} are now {levelUp.label}</strong>
            {muse.name} will open up a little more with you from here.
          </div>
          <button className="btn" onClick={seeBond}>Nice</button>
        </div>
      )}

      <div className="composer">
        {replyTo && (
          <ReplyBar who={replyTo.from === "user" ? "yourself" : muse.name} text={replyTo.content} onCancel={() => setReplyTo(null)} />
        )}
        {attach.preview}
        {attach.button}
        <label className="sr-only" htmlFor="solo-composer">Write to {muse.name}</label>
        <textarea
          id="solo-composer"
          ref={box}
          rows={1}
          maxLength={MAX_MESSAGE}
          placeholder={`Write to ${muse.name}`}
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
        {/* Never disabled while they are typing back: a second text is how
            people talk, and it gets answered with the first. */}
        <button className="send" onClick={() => void sendDraft()} disabled={!hasDraft && !attach.draft}>Send</button>
      </div>
    </main>
  );
}

/** Offered as one-tap additions wherever traits are edited. */
const TRAIT_IDEAS = ["funny", "sarcastic", "caring", "blunt", "chill", "dramatic", "flirty", "nosy", "savage", "soft"];

/* ---------------------------------------------------------------- helpers */


/* ---------------------------------------------------------- new circle */

function NewCircle({
  state, initial, onCancel, onCreate,
}: {
  state: SoloState;
  /** Editing an existing group rather than making one. */
  initial?: SoloCircle;
  onCancel: () => void;
  onCreate: (name: string, memberIds: string[]) => void;
}) {
  const everyone = allMuses(state);
  const [picked, setPicked] = useState<string[]>(initial?.memberIds ?? []);
  const [name, setName] = useState(initial?.name ?? "");

  /* Only people with a full profile can be in a circle. A Muse without one has
     no archetype or samples for the group prompt to work from, and would be the
     one flat voice in the room.
     
     Public figures are out too, for a different reason: circleBlock tells every
     member "You know these people and they know you", which for a real named
     person sitting in a room with the user's father is a fabricated
     relationship between a real human being and a private one. Everything else
     in the figure mode works to stop it inventing its own life; putting it in a
     circle would invent one for it. */
  const eligible = everyone.filter((m) => m.persona && m.persona.mode !== "figure");

  /* The route carries a roster of everyone else in the room and caps it, so a
     circle of nine could be created and then never produce a single reply --
     every turn rejected, permanently, with nothing saying why. Capped where the
     circle is made instead. Eight is also about where a group conversation
     stops being one. */
  const MAX_CIRCLE = 8;

  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_CIRCLE ? p : [...p, id]
    );
  const full = picked.length >= MAX_CIRCLE;

  const suggested = picked.length
    ? picked.map((id) => eligible.find((m) => m.id === id)?.name).filter(Boolean).join(" & ")
    : "";

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">{initial ? "Edit group" : "New circle"}</p>
        <button className="link-btn" onClick={onCancel}>Cancel</button>
      </header>

      <h1 className="display" style={{ fontSize: "1.9rem" }}>Who knows who?</h1>
      <p className="lede">
        Pick two or more. Everyone in a circle knows everyone else in it — they will talk to each
        other, not just to you.
      </p>

      <div className="card-grid">
        {eligible.map((m) => (
          <button
            key={m.id}
            className="muse-card"
            onClick={() => toggle(m.id)}
            disabled={full && !picked.includes(m.id)}
            style={picked.includes(m.id) ? { borderColor: "var(--accent)" } : undefined}
          >
            <Avatar name={m.name} image={m.avatar?.id} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <h3>{m.name}{picked.includes(m.id) ? " ✓" : ""}</h3>
              <span className="rel">{m.relationshipType}</span>
              <p>{m.description}</p>
            </div>
          </button>
        ))}
      </div>

      {eligible.length < 2 && (
        <p className="fine" style={{ marginTop: "1rem" }}>
          You need at least two people with a full profile. Build someone from a chat export, or
          start a conversation with one of the people already here.
        </p>
      )}

      <label className="field" style={{ marginTop: "1.5rem" }}>
        <span>Call it something</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={suggested || "The group chat"}
        />
      </label>

      <div className="row" style={{ marginTop: "1.25rem" }}>
        <button
          className="btn"
          disabled={picked.length < 2}
          onClick={() => onCreate(name.trim() || suggested || "The group chat", picked)}
        >
          {picked.length < 2 ? "Pick at least two" : initial ? "Save" : `Put ${picked.length} in a room`}
        </button>
        {full && <span className="fine">Eight is the most a room holds.</span>}
      </div>
    </main>
  );
}

function isDefaultVibe(v: Vibe): boolean {
  return v.mood === DEFAULT_VIBE.mood && v.topic === DEFAULT_VIBE.topic && v.register === DEFAULT_VIBE.register;
}

/** "4:32", "1:02:10". */
function callLength(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), sec = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** When you last talked, the way a chat list says it: "now", "14m", "3h", "Mon", "12 Sep". */
function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `${Math.floor(s / 3600)}h`;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
