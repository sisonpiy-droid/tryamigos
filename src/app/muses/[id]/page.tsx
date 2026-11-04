import { redirect } from "next/navigation";

import { Chat } from "@/components/Chat";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

/* The chat screen. `id` here is the conversation id, not the Muse id: a
   relationship is a continuing thread, and routing by conversation keeps the
   history addressable. */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      deletedAt: true,
      muse: { select: { id: true, name: true, relationshipType: true, description: true } },
    },
  });

  // §51: a conversation belongs to exactly one user. Anyone else gets sent home
  // rather than told the id exists.
  if (!conversation || conversation.deletedAt || conversation.userId !== userId) {
    redirect("/");
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: id, senderType: { in: ["USER", "MUSE"] } },
    orderBy: { createdAt: "asc" },
    // metadata deliberately not selected — §8 keeps model details server-side.
    select: { id: true, senderType: true, content: true, createdAt: true },
  });

  return (
    <main className="shell" style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <Chat
        conversationId={conversation.id}
        muse={conversation.muse}
        initialMessages={messages.map((m) => ({
          id: m.id,
          senderType: m.senderType as "USER" | "MUSE",
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
