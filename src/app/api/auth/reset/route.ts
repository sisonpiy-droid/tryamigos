import { z } from "zod";

import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkRecoveryCode, hashRecoveryCode, makeRecoveryCode } from "@/lib/recovery";

/* POST /api/auth/reset -- a forgotten password, reset with the recovery code
   shown at sign-up. Email, the code and a new password. The code is used up:
   a new one comes back in the reply, and the old one stops working.

   A wrong email and a wrong code get the same answer, after the same wait. */
export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email().max(320),
  code: z.string().min(8).max(40),
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const pw = parsed.error.issues.some((i) => i.path[0] === "password");
    return Response.json({ error: pw ? "Password must be at least 8 characters." : "Check the details and try again." }, { status: 400 });
  }
  const { email, code, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, recoveryHash: true, deletedAt: true },
  });
  const ok = await checkRecoveryCode(code, user && !user.deletedAt ? user.recoveryHash : null);
  if (!user || !ok) return Response.json({ error: "That email and recovery code don't match." }, { status: 401 });

  const recoveryCode = makeRecoveryCode();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password), recoveryHash: await hashRecoveryCode(recoveryCode) },
  });
  return Response.json({ recoveryCode });
}
