/* Authorization (PRD §51).
 *
 * Every rule in §51 is expressed here once, so no route has to remember it:
 *
 *   - a Muse may be modified only by its owner
 *   - a private Muse is visible only to its owner
 *   - a conversation belongs to exactly one user
 *   - memories are never reachable through another user's request
 *
 * These functions throw rather than return null. A route that forgets to check
 * a null gets a 500 and a log line; a route that forgets to check a throw does
 * not exist. Getting this wrong leaks somebody's private conversations, so the
 * failure mode is chosen deliberately.
 */

import { Muse, MuseBehaviour, MusePersonality } from "@prisma/client";

import { auth } from "./auth";
import { prisma } from "./db";

export class AuthError extends Error {
  constructor(readonly status: 401 | 403 | 404, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** The signed-in user's id, or 401.
 *
 *  Sessions are JWTs, so a token keeps working after the account behind it is
 *  deleted. This is the one gate every authenticated request passes through,
 *  so the existence check lives here rather than in the session callback. */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new AuthError(401, "Not signed in");

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw new AuthError(401, "Not signed in");

  return id;
}

export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export type MuseWithConfig = Muse & {
  personality: MusePersonality | null;
  behaviour: MuseBehaviour | null;
};

/** A Muse the user is allowed to *see*: their own, or a public/unlisted one. */
export async function requireViewableMuse(museId: string, userId: string): Promise<MuseWithConfig> {
  const muse = await prisma.muse.findUnique({
    where: { id: museId },
    include: { personality: true, behaviour: true },
  });

  /* 404 rather than 403 for a private Muse the user does not own. A 403 would
     confirm the id exists, which turns id guessing into an enumeration oracle. */
  if (!muse) throw new AuthError(404, "Muse not found");
  if (muse.status === "ARCHIVED" && muse.ownerUserId !== userId) {
    throw new AuthError(404, "Muse not found");
  }
  if (muse.visibility === "PRIVATE" && muse.ownerUserId !== userId) {
    throw new AuthError(404, "Muse not found");
  }
  return muse;
}

/** A Muse the user is allowed to *change*. Seed Muses (no owner) are nobody's. */
export async function requireOwnedMuse(museId: string, userId: string): Promise<MuseWithConfig> {
  const muse = await prisma.muse.findUnique({
    where: { id: museId },
    include: { personality: true, behaviour: true },
  });
  if (!muse) throw new AuthError(404, "Muse not found");
  if (!muse.ownerUserId || muse.ownerUserId !== userId) {
    throw new AuthError(404, "Muse not found");
  }
  return muse;
}

export async function requireOwnConversation(conversationId: string, userId: string) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo || convo.deletedAt) throw new AuthError(404, "Conversation not found");
  if (convo.userId !== userId) throw new AuthError(404, "Conversation not found");
  return convo;
}

export async function requireOwnMemory(memoryId: string, userId: string) {
  const memory = await prisma.memory.findUnique({ where: { id: memoryId } });
  if (!memory) throw new AuthError(404, "Memory not found");
  if (memory.userId !== userId) throw new AuthError(404, "Memory not found");
  return memory;
}

/** Turns an AuthError into a response; anything else is a 500 with the detail
 *  logged rather than returned (§44). */
export function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

/** Daily AI budget per user, in units. A chat turn is 1; speech is 3; an image is 10.
 *  Tune with DAILY_AI_UNITS. AI_KILL_SWITCH=1 turns every AI route off at once. */
const DAILY_UNITS = Number(process.env.DAILY_AI_UNITS) || 400;

/** For the /api/solo and /api/persona AI routes: a Response when the call must not
 *  run (not signed in, kill switch on, or daily budget spent), else null.
 *  `units` is the call's cost weight against the user's daily budget. */
export async function soloGate(units = 1): Promise<Response | null> {
  if (process.env.AI_KILL_SWITCH === "1") {
    return Response.json({ error: "Amigos is paused for a moment. Try again soon." }, { status: 503 });
  }
  let userId: string;
  try {
    userId = await requireUserId();
  } catch {
    return Response.json({ error: "Sign in to keep chatting." }, { status: 401 });
  }
  try {
    const day = new Date().toISOString().slice(0, 10);
    const row = await prisma.usageDay.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, units },
      update: { units: { increment: units } },
    });
    if (row.units > DAILY_UNITS) {
      return Response.json({ error: "You have hit the daily limit. It resets tomorrow." }, { status: 429 });
    }
  } catch (err) {
    // ponytail: fails open if the UsageDay table is missing (migration not applied yet); fail closed once it is.
    console.error("usage cap unavailable", err);
  }
  return null;
}
