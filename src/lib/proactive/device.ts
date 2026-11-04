import { z } from "zod";

import { prisma } from "@/lib/db";

/* The anonymous device every outreach belongs to.
 *
 * Solo mode has no accounts, so the browser makes a long random id the first
 * time outreach is switched on and keeps it beside its own data. Knowing the id
 * is what lets a caller read or change that device's outreach -- it is never
 * shown, never in a URL, and carries nothing but settings and a push address.
 */

export const deviceId = z.string().regex(/^[A-Za-z0-9_-]{24,64}$/);

export async function findDevice(id: unknown) {
  const parsed = deviceId.safeParse(id);
  if (!parsed.success) return null;
  return prisma.outreachDevice.findUnique({ where: { id: parsed.data } });
}
