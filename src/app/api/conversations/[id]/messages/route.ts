import { z } from "zod";

import { userFacingError } from "@/lib/ai";
import { errorResponse, requireOwnConversation, requireUserId, requireViewableMuse } from "@/lib/authorize";
import { runTurn } from "@/lib/muse/turn";

/* POST /api/conversations/:id/messages — §58.
 *
 * A thin SSE wrapper. The pipeline itself is in lib/muse/turn.ts so it can be
 * tested without HTTP; this file is only responsible for auth, validation and
 * getting bytes to the browser as they arrive (§45).
 */

const bodySchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id: conversationId } = await ctx.params;

    const conversation = await requireOwnConversation(conversationId, userId);
    const muse = await requireViewableMuse(conversation.museId, userId);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "Invalid request." }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: "Write something first." }, { status: 400 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        try {
          const result = await runTurn({
            userId,
            muse,
            conversationId,
            content: parsed.data.content,
            onDelta: (text) => send({ type: "delta", text }),
          });
          send({ type: "done", messageId: result.museMessageId });
        } catch (err) {
          console.error("generation failed", err);
          const { message, retryable } = userFacingError(err);
          send({ type: "error", message, retryable });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        /* Nginx and some proxies buffer by default, which turns a stream into
           one lump arriving at the end. */
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
