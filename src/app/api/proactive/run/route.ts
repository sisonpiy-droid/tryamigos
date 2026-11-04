import { runOutreach } from "@/lib/proactive/run";

/* The scheduler's entry point.
 *
 * Called every 15 minutes by .github/workflows/outreach.yml (Vercel's free
 * plan only runs its own cron once a day), and once a day by vercel.json as a
 * backstop. Both authenticate with CRON_SECRET; Vercel sends it as a bearer
 * token on its own. Without the secret configured this refuses to run at all,
 * rather than letting anyone on the internet trigger sends.
 */

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Not configured." }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const summary = await runOutreach();
    return Response.json({ ok: true, ...summary });
  } catch (err) {
    console.error("outreach run failed", err);
    return Response.json({ ok: false }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
