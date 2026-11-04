import { redirect } from "next/navigation";

import LoginForm from "./LoginForm";

/* Accounts need somewhere to live. On a deployment without a database there is
   nothing to sign into, and letting someone fill in this form would end at a
   500 from the signup route — so the door is closed here rather than at the
   bottom of the stairs. Same check as the root route. */
/* Evaluated per request, not at build. Whether a deployment has a database is
   configuration, and baking that decision into the build means adding one later
   silently keeps redirecting until someone thinks to rebuild. */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!process.env.DATABASE_URL) redirect("/solo");
  return <LoginForm />;
}
