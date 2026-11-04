import { hashPassword, signupSchema } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hashRecoveryCode, makeRecoveryCode } from "@/lib/recovery";

/* POST /api/auth/signup — §56.
   Creates the account only; the client signs in afterwards through the
   credentials provider so there is one code path that issues sessions. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message =
      issue?.path[0] === "password"
        ? "Password must be at least 8 characters."
        : issue?.path[0] === "email"
          ? "That email address doesn't look right."
          : "Check the details and try again.";
    return Response.json({ error: message }, { status: 400 });
  }

  const { email, password, name, timezone } = parsed.data;
  const normalised = email.toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email: normalised },
    select: { id: true },
  });
  if (existing) {
    /* Signup necessarily reveals whether an address is taken -- there is no way
       to create a duplicate account silently. Login does not leak it, which is
       where it matters. */
    return Response.json({ error: "An account with that email already exists." }, { status: 409 });
  }

  /* Shown once, in this reply; only its hash is kept. */
  const recoveryCode = makeRecoveryCode();
  const user = await prisma.user.create({
    data: {
      email: normalised,
      recoveryHash: await hashRecoveryCode(recoveryCode),
      name: name ?? null,
      passwordHash: await hashPassword(password),
      timezone: timezone ?? "UTC",
      subscription: { create: { plan: "FREE" } },
    },
    select: { id: true, email: true, name: true },
  });

  return Response.json({ user, recoveryCode }, { status: 201 });
}
