import { redirect } from "next/navigation";

/* The root chooses which MUSE this deployment is.
 *
 * With a database configured, it serves the full product: accounts, shared
 * Muses, memory in Postgres. Without one, there is nothing for the signed-in
 * app to talk to, so it hands over to solo mode rather than throwing a 500 at
 * whoever opened the link.
 *
 * The import is dynamic on purpose. `@/lib/db` constructs a Prisma client at
 * module scope, so a static import would pull it into the graph — and fail on
 * load — even on a deployment that never intended to use it.
 */

/* Evaluated per request, not at build. Whether a deployment has a database is
   configuration, and baking that decision into the build means adding one later
   silently keeps redirecting until someone thinks to rebuild. */
export const dynamic = "force-dynamic";

/* Having a database is no longer enough to switch the product over.
 *
 * Provisioning Postgres is the first step of building accounts, not the last:
 * for the whole time the signed-in app is being brought up to what solo mode
 * already does, DATABASE_URL is set and the account app is not ready. Keying
 * the redirect off the connection string alone meant the next deploy of
 * anything at all would land visitors on a half-built signup flow and hide the
 * conversations they actually have.
 *
 * So the switch is its own decision. Set ACCOUNTS_ENABLED=1 when the signed-in
 * app is genuinely the better one, and not before. */
const accountsReady = () =>
  Boolean(process.env.DATABASE_URL) && process.env.ACCOUNTS_ENABLED === "1";

export default async function RootPage() {
  if (!accountsReady()) redirect("/solo");

  const { default: DatabaseHome } = await import("./home-db");
  return <DatabaseHome />;
}
