import { z } from "zod";

import { prisma } from "@/lib/db";
import { deviceId } from "@/lib/proactive/device";
import { pushPublicKey } from "@/lib/proactive/push";
import { validZone } from "@/lib/proactive/timing";

/* A device's outreach settings, and where to push to.
 *
 * GET hands out the public half of the push key (public by design). POST
 * creates the device on first use and updates it after. Off by default: a
 * device that has never said otherwise is never contacted. */

export const runtime = "nodejs";

const minutes = z.number().int().min(0).max(1439);

const bodySchema = z.object({
  id: deviceId,
  timezone: z.string().max(64).refine(validZone, "not a timezone"),
  proactiveEnabled: z.boolean().optional(),
  initiationFrequency: z.enum(["NEVER", "RARELY", "SOMETIMES", "OFTEN"]).optional(),
  quietHoursStart: minutes.optional(),
  quietHoursEnd: minutes.optional(),
  maxDailyProactive: z.number().int().min(0).max(5).optional(),
  allowedMuseIds: z.array(z.string().max(80)).max(100).optional(),
  /** null removes the push subscription. */
  push: z
    .object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
    .nullish(),
});

const shape = (d: {
  proactiveEnabled: boolean; initiationFrequency: string; quietHoursStart: number; quietHoursEnd: number;
  maxDailyProactive: number; allowedMuseIds: string[]; pushEndpoint: string | null; timezone: string;
}) => ({
  proactiveEnabled: d.proactiveEnabled,
  initiationFrequency: d.initiationFrequency,
  quietHoursStart: d.quietHoursStart,
  quietHoursEnd: d.quietHoursEnd,
  maxDailyProactive: d.maxDailyProactive,
  allowedMuseIds: d.allowedMuseIds,
  timezone: d.timezone,
  pushing: Boolean(d.pushEndpoint),
});

export async function GET() {
  return Response.json({ publicKey: pushPublicKey() });
}

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Check the settings and try again." }, { status: 400 });
  const { id, push, ...settings } = parsed.data;

  const pushFields =
    push === undefined ? {} : push === null
      ? { pushEndpoint: null, pushP256dh: null, pushAuth: null }
      : { pushEndpoint: push.endpoint, pushP256dh: push.keys.p256dh, pushAuth: push.keys.auth };

  try {
    const d = await prisma.outreachDevice.upsert({
      where: { id },
      create: { id, ...settings, ...pushFields },
      update: { ...settings, ...pushFields, lastSeenAt: new Date() },
    });
    return Response.json({ device: shape(d), publicKey: pushPublicKey() });
  } catch (err) {
    console.error("outreach device save failed", err);
    return Response.json({ error: "Couldn't save that. Try again." }, { status: 502 });
  }
}
