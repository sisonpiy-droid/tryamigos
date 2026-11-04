import { NOT_ENOUGH } from "./persona";

/* Reading what /api/persona/research's search came back with.
 *
 * The model is asked for one of four shapes -- a real person, a fictional
 * character, "which one?", or NOT_ENOUGH -- and it does not always format them
 * cleanly: grounding tends to add bold, bullets and a stray preamble. Parsed
 * here, apart from the route, so it can be tested without a network. */

export type Candidate = { name: string; knownFor: string };

export type Research =
  | { kind: "none" }
  | { kind: "which"; candidates: Candidate[] }
  | {
      kind: "found";
      fictional: boolean;
      /** Fiction only. Unknown counts as a minor: it only ever takes romance off the table. */
      minor: boolean;
      knownFor: string;
      fullName: string;
      research: string;
    };

const HEADER = /^\s*[*_#]*\s*(KNOWN FOR|FICTIONAL|FULL NAME|AGE)\s*[*_]*\s*:.*$/gim;

function field(key: string, text: string): string {
  const m = new RegExp(`^\\s*[*_#]*\\s*${key}\\s*[*_]*\\s*:\\s*(.+)$`, "im").exec(text);
  return (m?.[1] ?? "").replace(/[*_]+/g, "").trim();
}

export function parseCandidates(text: string): Candidate[] {
  const at = text.search(/WHICH\s*[*_]*\s*:/i);
  if (at < 0) return [];
  return text
    .slice(at)
    .replace(/^.*?:/, "")
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").replace(/[*_]{2,}/g, "").trim())
    .filter((l) => l.includes("|"))
    .map((l) => {
      const [name, ...rest] = l.split("|");
      return { name: name.trim().slice(0, 60), knownFor: rest.join("|").trim().slice(0, 80) };
    })
    .filter((c) => c.name.length > 1)
    .slice(0, 5);
}

export function readResearch(text: string): Research {
  if (text.replace(/[^A-Z_]/g, "").startsWith(NOT_ENOUGH)) return { kind: "none" };

  const fictional = field("FICTIONAL", text);
  const knownFor = fictional || field("KNOWN FOR", text);

  /* Only when it did not also write a briefing: a model that hedges with a
     WHICH line and then picks someone anyway has picked someone. */
  if (!knownFor) {
    const candidates = parseCandidates(text);
    if (candidates.length > 1) return { kind: "which", candidates };
  }

  return {
    kind: "found",
    fictional: Boolean(fictional),
    minor: fictional ? !/^adult/i.test(field("AGE", text)) : false,
    knownFor: knownFor.slice(0, 120),
    fullName: field("FULL NAME", text).slice(0, 60),
    research: text.replace(HEADER, "").trim().slice(0, 6000),
  };
}
