import { z } from "zod";

import { prisma } from "@/lib/db";
import { deviceId, findDevice } from "@/lib/proactive/device";

/* Calling off pending outreach: the user already brought it up, or deleted the
   Muse, or the thing it was about stopped being true. Only ever touches
   triggers that have not been sent. */

export const runtime = "nodejs";

const bodySchema = z.object({
  deviceId,
  triggerIds: z.array(z.string().max(40)).max(50).optional(),
  museId: z.string().max(80).optional(),
  reason: z.string().max(60).default("cancelled"),
});

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success || (!parsed.data.triggerIds?.length && !parsed.data.museId)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const { triggerIds, museId, reason } = parsed.data;
  const device = await findDevice(parsed.data.deviceId);
  if (!device) return Response.json({ error: "Unknown device." }, { status: 404 });

  const { count } = await prisma.proactiveTrigger.updateMany({
    where: {
      deviceId: device.id,
      status: "PENDING",
      ...(triggerIds?.length ? { id: { in: triggerIds } } : {}),
      ...(museId ? { museId } : {}),
    },
    data: { status: "CANCELLED", statusReason: reason },
  });
  return Response.json({ cancelled: count });
}
