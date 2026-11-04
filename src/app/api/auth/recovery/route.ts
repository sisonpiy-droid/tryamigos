import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";
import { hashRecoveryCode, makeRecoveryCode } from "@/lib/recovery";

/* POST /api/auth/recovery -- a new recovery code for the signed-in account,
   replacing the old one. For accounts made before codes existed, and for
   anyone who has lost theirs while still signed in somewhere. Shown once. */
export const runtime = "nodejs";

export async function POST() {
  try {
    const userId = await requireUserId();
    const recoveryCode = makeRecoveryCode();
    await prisma.user.update({ where: { id: userId }, data: { recoveryHash: await hashRecoveryCode(recoveryCode) } });
    return Response.json({ recoveryCode });
  } catch (err) {
    return errorResponse(err);
  }
}
