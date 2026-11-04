import { z } from "zod";

import { prisma } from "@/lib/db";
import { classify, compose } from "@/lib/proactive/compose";
import { feelingsSchema, personaSchema } from "@/lib/presence/schema";
import { deviceId, findDevice } from "@/lib/proactive/device";
import { nextAllowed, planTime, validZone, type TriggerType } from "@/lib/proactive/timing";

/* Memories in, reasons to text out.
 *
 * Called by the app after memory extraction stores something dated or
 * goal-like, for a Muse that is allowed to text first. The persona, the notes
 * and the recent lines arrive with the request, are used to decide and to
 * write, and are not kept: what is stored is the finished message, when to
 * send it, and a few words of why.
 *
 * One trigger per memory, ever -- the database enforces it. Anything the app
 * no longer lists (deleted, replaced by "the interview went fine") has its
 * pending trigger cancelled here.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const persona = personaSchema("character");

const bodySchema = z.object({
  deviceId,
  muse: z.object({ id: z.string().max(80), name: z.string().max(60) }),
  persona,
  /* The same standing state and closeness the chat uses, so a text she starts
     is the same person as the one in the thread. */
  feelings: feelingsSchema.nullish(),
  bond: z.number().int().min(0).max(10).nullish(),
  userName: z.string().max(80).nullish(),
  /** Memories worth looking at that have not been looked at before. */
  candidates: z
    .array(z.object({
      id: z.string().max(80),
      content: z.string().max(420),
      type: z.string().max(20),
      at: z.string().max(40).nullish(),
      createdAt: z.string().max(40).optional(),
    }))
    .max(10),
  /** Every memory id that could still justify a trigger; pending ones not listed are cancelled. */
  keep: z.array(z.string().max(80)).max(400),
  recent: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000), at: z.string().max(40).optional() }))
    .max(8)
    .default([]),
  /** Her storylines, for telling a story she promised. Not stored. */
  life: z.array(z.string().max(400)).max(6).default([]),
});

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const body = parsed.data;

  const device = await findDevice(body.deviceId);
  if (!device) return Response.json({ error: "Unknown device." }, { status: 404 });
  if (!validZone(device.timezone)) return Response.json({ created: [], evaluated: [] });
  const tz = device.timezone;
  const now = Date.now();

  /* Whatever the app no longer lists has stopped being a reason. */
  await prisma.proactiveTrigger.updateMany({
    where: { deviceId: device.id, museId: body.muse.id, status: "PENDING", sourceMemoryId: { notIn: body.keep } },
    data: { status: "CANCELLED", statusReason: "memory gone or replaced" },
  });

  const existing = new Set(
    (await prisma.proactiveTrigger.findMany({
      where: { deviceId: device.id, sourceMemoryId: { in: body.candidates.map((c) => c.id) } },
      select: { sourceMemoryId: true },
    })).map((t) => t.sourceMemoryId)
  );
  /* A few per request: each is written one at a time, and the rest come back
     on the next sync because they are not reported as evaluated. */
  const fresh = body.candidates.filter((c) => !existing.has(c.id)).slice(0, 4);
  const evaluated = [...existing, ...fresh.map((c) => c.id)];
  if (!fresh.length) return Response.json({ created: [], evaluated });

  /* Something she said she would tell them is its own reason: no need to ask
     whether it is one. It goes out as a follow-up, a few hours on. */
  const promised = fresh.filter((c) => c.type === "PROMISE");
  let reasons;
  try {
    reasons = [
      ...(await classify(fresh.filter((c) => c.type !== "PROMISE"), { now, tz })),
      ...promised.map((c) => ({
        id: c.id, kind: "FOLLOW_UP" as const, reason: "what she said she would tell them",
        remindAt: null, dateOnly: false, eventAt: null, keywords: [] as string[],
      })),
    ];
  } catch (err) {
    console.error("outreach classify failed", err);
    /* Not evaluated: the app will offer them again next time. */
    return Response.json({ created: [], evaluated: [] });
  }

  const you = body.userName?.trim() || body.persona.you || "them";
  const created: { id: string; sourceMemoryId: string; type: TriggerType; reason: string; scheduledFor: string; keywords: string[] }[] = [];

  /* One at a time, so the same-event check below sees what this batch made. */
  for (const r of reasons) await (async () => {
    const c = fresh.find((x) => x.id === r.id)!;
    const promise = c.type === "PROMISE";
    /* The memory's own date first; failing that, the date the note states. */
    const stated = c.at ?? r.eventAt;
    const eventAt = stated ? Date.parse(stated) : null;
    /* A promise is timed from when she made it: a few hours on, that evening. */
    const madeAt = c.createdAt ? Date.parse(c.createdAt) : now;
    const plan = planTime({
      type: r.kind, id: c.id, now, tz,
      eventAt: promise ? madeAt : Number.isFinite(eventAt) ? eventAt : null,
      remindAt: r.remindAt ? Date.parse(r.remindAt) : Number.isFinite(eventAt) ? eventAt : null,
      remindDateOnly: r.dateOnly,
      createdAt: c.createdAt ? Date.parse(c.createdAt) : now,
    });
    if (!plan) return;

    /* One event, one text -- not one per memory of it. Talking about the exam
       again ("don't worry, I've revised") tends to produce a second memory of
       the same exam, and with it a second reason to text about it. A trigger
       already made for an event at about the same moment, whatever became of
       it (including called off because they raised it first), means there is
       nothing new to say. */
    if (eventAt !== null && Number.isFinite(eventAt)) {
      const near = await prisma.proactiveTrigger.count({
        where: {
          deviceId: device.id, museId: body.muse.id,
          eventAt: { gte: new Date(eventAt - 12 * 3600_000), lte: new Date(eventAt + 12 * 3600_000) },
        },
      });
      if (near) return;
    }
    const sendAt = nextAllowed(plan.scheduledFor, tz, device.quietHoursStart, device.quietHoursEnd, c.id);
    if (sendAt >= plan.expiresAt) return;

    let message: string | null = null;
    try {
      message = await compose({
        persona: body.persona, feelings: body.feelings ?? undefined, bond: body.bond ?? null, you, tz, kind: r.kind, reason: r.reason, note: c.content,
        sendAt, eventAt: stated ?? null, recent: body.recent,
        ...(promise ? { promise: true, life: body.life } : {}),
      });
    } catch (err) {
      console.error("outreach compose failed", err);
    }
    if (!message) return;

    try {
      const t = await prisma.proactiveTrigger.create({
        data: {
          deviceId: device.id, museId: body.muse.id, museName: body.muse.name,
          type: r.kind, reason: r.reason, sourceMemoryId: c.id,
          eventAt: Number.isFinite(eventAt) ? new Date(eventAt!) : null,
          scheduledFor: new Date(sendAt), expiresAt: new Date(plan.expiresAt), message,
        },
      });
      created.push({ id: t.id, sourceMemoryId: c.id, type: r.kind, reason: r.reason, scheduledFor: t.scheduledFor.toISOString(), keywords: r.keywords });
    } catch (err) {
      /* P2002: another request made it first. One per memory either way. */
      if ((err as { code?: string }).code !== "P2002") console.error("outreach trigger save failed", err);
    }
  })();

  return Response.json({ created, evaluated });
}
