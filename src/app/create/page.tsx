import { redirect } from "next/navigation";

import CreateWizard from "./CreateWizard";

/* Creating a Muse here writes to the database. On a deployment without one,
   solo mode is where Muses get made — including from a chat export, which is
   the better route anyway. Same per-request check as the root and login. */
export const dynamic = "force-dynamic";

export default async function CreatePage() {
  if (!process.env.DATABASE_URL) redirect("/solo");
  return <CreateWizard />;
}
