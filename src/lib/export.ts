/* Export (PRD §37 — users must be able to export their data).
 *
 * Two audiences, so two shapes:
 *
 *   Persona JSON is meant to be read back in. It is versioned and carries only
 *   the definition of a Muse, never anybody's conversation or memories, so a
 *   persona can be shared without handing over a relationship along with it.
 *
 *   A transcript is meant to be read by a person. Markdown, with dates, because
 *   the point of exporting a conversation is usually to keep or reread it.
 */

export const PERSONA_FORMAT = "muse.persona/1";
export const ARCHIVE_FORMAT = "muse.archive/1";

export interface PersonaExport {
  format: typeof PERSONA_FORMAT;
  exportedAt: string;
  muse: {
    name: string;
    description: string;
    relationshipType: string;
    category: string | null;
    languages: string[];
    personality: {
      traits: string[];
      values: string | null;
      humour: string | null;
      emotionalStyle: string | null;
      opinions: string | null;
      customInstructions: string | null;
      tone: string | null;
      formality: string | null;
      vocabulary: string | null;
      sentenceLength: string | null;
      catchphrases: string | null;
      dialect: string | null;
    };
  };
}

type MuseForExport = {
  name: string;
  description: string;
  relationshipType: string;
  category: string | null;
  languages: string[];
  personality: {
    traits: string[];
    values: string | null;
    humour: string | null;
    emotionalStyle: string | null;
    opinions: string | null;
    customInstructions: string | null;
    tone: string | null;
    formality: string | null;
    vocabulary: string | null;
    sentenceLength: string | null;
    catchphrases: string | null;
    dialect: string | null;
  } | null;
};

export function personaExport(muse: MuseForExport): PersonaExport {
  const p = muse.personality;
  return {
    format: PERSONA_FORMAT,
    exportedAt: new Date().toISOString(),
    muse: {
      name: muse.name,
      description: muse.description,
      relationshipType: muse.relationshipType,
      category: muse.category,
      languages: muse.languages,
      personality: {
        traits: p?.traits ?? [],
        values: p?.values ?? null,
        humour: p?.humour ?? null,
        emotionalStyle: p?.emotionalStyle ?? null,
        opinions: p?.opinions ?? null,
        customInstructions: p?.customInstructions ?? null,
        tone: p?.tone ?? null,
        formality: p?.formality ?? null,
        vocabulary: p?.vocabulary ?? null,
        sentenceLength: p?.sentenceLength ?? null,
        catchphrases: p?.catchphrases ?? null,
        dialect: p?.dialect ?? null,
      },
    },
  };
}

export interface TranscriptMessage {
  senderType: string;
  content: string;
  createdAt: Date;
}

export function transcriptMarkdown(opts: {
  museName: string;
  relationshipType: string;
  userName: string | null;
  messages: TranscriptMessage[];
}): string {
  const { museName, relationshipType, userName, messages } = opts;
  const me = userName?.trim() || "You";

  const lines: string[] = [
    `# ${museName}`,
    ``,
    `Your ${relationshipType}. ${messages.length} message${messages.length === 1 ? "" : "s"}.`,
    ``,
    `> Exported ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`,
    `> ${museName} is an AI persona; this is a record of a conversation with a language model.`,
    ``,
  ];

  let lastDay = "";
  for (const m of messages) {
    const day = m.createdAt.toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
    if (day !== lastDay) {
      lines.push(``, `## ${day}`, ``);
      lastDay = day;
    }
    const time = m.createdAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const who = m.senderType === "USER" ? me : museName;
    /* Blockquote the body so a message containing a markdown heading or list
       cannot restructure the document around it. */
    const body = m.content.split("\n").map((l) => `> ${l}`).join("\n");
    lines.push(`**${who}** · ${time}`, ``, body, ``);
  }

  return lines.join("\n");
}

/** A filename that survives Windows, macOS and Linux. */
export function safeFilename(base: string, ext: string): string {
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return `${cleaned || "muse"}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}
