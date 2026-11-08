import { redirect } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { StartTalking } from "@/components/StartTalking";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";

/* §Screen 2 — Home. A server component, so the §51 ownership rules run where
   they cannot be bypassed and nothing about other users reaches the browser. */

export default async function DatabaseHome() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, deletedAt: true },
  });
  if (!user || user.deletedAt) redirect("/login");

  const [conversations, discover, mine] = await Promise.all([
    // "Continue talking" — recently active relationships.
    prisma.conversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { lastMessageAt: "desc" },
      take: 6,
      select: {
        id: true,
        lastMessageAt: true,
        muse: { select: { id: true, name: true, relationshipType: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { content: true, senderType: true },
        },
      },
    }),
    // §37: private Muses must never appear in discovery.
    prisma.muse.findMany({
      where: { visibility: "PUBLIC", status: "ACTIVE" },
      orderBy: [{ interactionCount: "desc" }, { createdAt: "asc" }],
      take: 12,
      select: {
        id: true, name: true, description: true, relationshipType: true, category: true,
        personality: { select: { traits: true } },
      },
    }),
    prisma.muse.findMany({
      where: { ownerUserId: userId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, description: true, relationshipType: true },
    }),
  ]);

  const talkedTo = new Set(conversations.map((c) => c.muse.id));

  return (
    <main className="shell">
      <header className="row" style={{ justifyContent: "space-between" }}>
        <p className="mark">Try Amigos</p>
        <a href="/create" className="btn" style={{ textDecoration: "none", padding: "0.45rem 1rem", minHeight: "auto" }}>
          Create
        </a>
      </header>

      {conversations.length > 0 && (
        <>
          <h2 className="section-title">Continue talking</h2>
          <div className="card-grid">
            {conversations.map((c) => {
              const last = c.messages[0];
              return (
                <StartTalking key={c.id} museId={c.muse.id} className="muse-card">
                  <Avatar name={c.muse.name} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row" style={{ gap: "0.5rem", justifyContent: "space-between" }}>
                      <h3>{c.muse.name}</h3>
                      <span className="stamp">{relativeTime(c.lastMessageAt)}</span>
                    </div>
                    <span className="rel">{c.muse.relationshipType}</span>
                    {last && (
                      <p style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {last.senderType === "USER" ? "You: " : ""}
                        {last.content}
                      </p>
                    )}
                  </div>
                </StartTalking>
              );
            })}
          </div>
        </>
      )}

      <h2 className="section-title">{mine.length ? "Your Amigos" : "Create your own"}</h2>
      {mine.length ? (
        <div className="card-grid">
          {mine.map((m) => (
            <StartTalking key={m.id} museId={m.id} className="muse-card">
              <Avatar name={m.name} />
              <div style={{ minWidth: 0 }}>
                <h3>{m.name}</h3>
                <span className="rel">{m.relationshipType}</span>
                <p>{m.description}</p>
              </div>
            </StartTalking>
          ))}
        </div>
      ) : (
        /* §43: never a blank screen, and always a way out of one. */
        <div className="empty">
          <p>Your world is empty.</p>
          <a href="/create" className="btn" style={{ textDecoration: "none", display: "inline-block" }}>
            Create your first Amigo
          </a>
        </div>
      )}

      <h2 className="section-title">Discover</h2>
      <div className="card-grid">
        {discover
          .filter((m) => !talkedTo.has(m.id))
          .map((m) => (
            <StartTalking key={m.id} museId={m.id} className="muse-card">
              <Avatar name={m.name} />
              <div style={{ minWidth: 0 }}>
                <h3>{m.name}</h3>
                <span className="rel">{m.relationshipType}</span>
                <p>{m.description}</p>
                {m.personality?.traits?.length ? (
                  <div className="tags">
                    {m.personality.traits.slice(0, 4).map((t) => (
                      <span className="tag" key={t}>{t}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            </StartTalking>
          ))}
      </div>

      <p className="fine" style={{ marginTop: "2.5rem" }}>
        Every Amigo is an AI. Conversations are private to your account.
      </p>
    </main>
  );
}

function relativeTime(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
