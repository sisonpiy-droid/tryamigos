import { z } from "zod";

import { auth } from "@/lib/auth";
import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";

/* The signed-in copy of the /solo state, so another phone or computer can pick
 * it up.
 *
 * One row per account (SoloSync). Nothing here understands the state: the
 * browser merges, this only stores the newest whole copy and refuses a write
 * that was not based on it (409), which is what makes two devices take turns
 * instead of overwriting each other. Photos, voice notes and videos are not
 * here; they stay on the device that made them.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Vercel refuses a request body over about 4.5 MB. */
const MAX_DATA = 4_000_000;

const putSchema = z.object({
  data: z.string().min(2).max(MAX_DATA),
  /** The revision this write is based on; 0 for the first. */
  baseRev: z.number().int().min(0),
});

/** Who is signed in, or null. Never throws, so the page can ask without an error. */
async function who(): Promise<{ id: string; email: string } | null> {
  try {
    const id = await requireUserId();
    const session = await auth();
    return { id, email: session?.user?.email ?? "" };
  } catch {
    return null;
  }
}

/* GET: who is signed in and the current revision. With ?peek=1 only that,
   which is how a device asks "has anything changed?" without downloading
   everything. */
export async function GET(req: Request) {
  const me = await who();
  if (!me) return Response.json({ error: "Not signed in" }, { status: 401 });
  try {
    const peek = new URL(req.url).searchParams.get("peek") === "1";
    const row = await prisma.soloSync.findUnique({
      where: { userId: me.id },
      select: peek ? { rev: true } : { rev: true, data: true },
    });
    return Response.json(
      { email: me.email, rev: row?.rev ?? 0, ...(peek ? {} : { data: (row as { data?: string } | null)?.data ?? null }) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request) {
  const me = await who();
  if (!me) return Response.json({ error: "Not signed in" }, { status: 401 });
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = putSchema.safeParse(raw);
  if (!parsed.success) {
    const tooBig = parsed.error.issues.some((i) => i.code === "too_big");
    return Response.json({ error: tooBig ? "Too big to sync." : "Invalid request." }, { status: tooBig ? 413 : 400 });
  }
  const { data, baseRev } = parsed.data;
  try {
    JSON.parse(data);
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    if (baseRev === 0) {
      try {
        await prisma.soloSync.create({ data: { userId: me.id, data, rev: 1 } });
        return Response.json({ rev: 1 });
      } catch {
        /* A row already exists: another device got there first. */
        return Response.json({ error: "Out of date" }, { status: 409 });
      }
    }
    const done = await prisma.soloSync.updateMany({
      where: { userId: me.id, rev: baseRev },
      data: { data, rev: baseRev + 1 },
    });
    if (done.count === 0) return Response.json({ error: "Out of date" }, { status: 409 });
    return Response.json({ rev: baseRev + 1 });
  } catch (err) {
    return errorResponse(err);
  }
}
