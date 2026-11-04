import { errorResponse, requireUserId, requireViewableMuse } from "@/lib/authorize";
import { personaExport, safeFilename } from "@/lib/export";

/* GET /api/muses/:id/export — the persona definition, portable and re-readable.
   Viewable rather than owned: a public Muse can be exported by anyone who can
   already see it, and the export carries no conversation and no memories, so
   sharing a persona never shares a relationship. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const muse = await requireViewableMuse(id, userId);

    const body = JSON.stringify(personaExport(muse), null, 2);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${safeFilename(muse.name + "-persona", "json")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
