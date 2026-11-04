import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";

import { prisma } from "./db";

/* Auth (PRD §56).
 *
 * Email + password only for now. The Account/Session tables and the Prisma
 * adapter are wired up regardless, so adding Google or Apple later is a config
 * change rather than a migration.
 *
 * Sessions are JWT rather than database-backed: the credentials provider
 * requires it, and it keeps every authenticated page render from costing a
 * session lookup. The tradeoff is that a token outlives a deletion, so
 * requireUserId re-checks the account against the database rather than
 * trusting the token alone.
 */

export const credentialsSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
});

export const signupSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().max(64).optional(),
});

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  trustHost: true,

  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
        });

        /* Hash a throwaway password when the user does not exist so the reply
           takes about as long either way. Returning immediately on an unknown
           email leaks which addresses have accounts. */
        if (!user?.passwordHash || user.deletedAt) {
          await bcrypt.compare(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali");
          return null;
        }

        if (!(await verifyPassword(password, user.passwordHash))) return null;

        return { id: user.id, email: user.email, name: user.name, image: user.avatarUrl };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },

    async session({ session, token }) {
      /* Only copies the id across. Whether that account still exists is checked
         in requireUserId, which is the single gate every authenticated request
         passes through -- doing it here would cost a query on session reads
         that never touch the database, and would still need repeating there. */
      const uid = token.uid as string | undefined;
      if (uid && session.user) session.user.id = uid;
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user?: {
      id: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
}
