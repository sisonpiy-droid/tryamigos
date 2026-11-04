/* Measuring whether a conversation is actually worth having.
 *
 * "Boring and repetitive" is a real complaint and a measurable one. This runs a
 * scripted conversation against the live chat route and reports numbers rather
 * than impressions, so a prompt change can be judged instead of admired:
 *
 *   echo    how much of what it says it has already said
 *   openers how often two replies start the same way
 *   asks    whether it ever puts the ball back
 *   offers  whether it brings anything of its own
 *
 * The user side is deliberately flat and a bit unhelpful — short, low-effort
 * messages — because that is when a boring character is most obvious and when a
 * good one has to do the most work.
 */

const BASE = process.env.MUSE_BASE || "http://localhost:3000";

const USER_TURNS = [
  "hey",
  "not much, you?",
  "yeah same",
  "idk just tired",
  "work mostly",
  "hmm",
  "yeah",
  "maybe",
  "i guess",
  "ok",
  "lol",
  "nothing really",
];

async function turn(persona, messages, vibe) {
  const res = await fetch(`${BASE}/api/solo/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      muse: {
        name: persona.them,
        description: "test",
        relationshipType: persona.relationship,
        languages: ["English"],
      },
      persona,
      messages,
      memories: [],
      userName: persona.you,
      timezone: "Asia/Kolkata",
      ...vibe,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

  let out = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split(/\r?\n\r?\n/);
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const line = f.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        const e = JSON.parse(line.slice(5).trim());
        if (e.type === "delta" && e.text) out += e.text;
        if (e.type === "error") throw new Error(e.message);
      } catch { /* partial frame */ }
    }
  }
  return out.trim();
}

/** Split a burst reply the way the app does. */
const lines = (reply) =>
  reply.split(/\n?---+\n?/).flatMap((s) => s.split("\n")).map((s) => s.trim()).filter(Boolean);

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
const opener = (s) => norm(s).split(" ").slice(0, 2).join(" ");

export async function run(label, persona, turns = USER_TURNS) {
  const messages = [];
  const all = [];

  for (const u of turns) {
    messages.push({ role: "user", content: u });
    const reply = await turn(persona, messages.slice(-20), {});
    messages.push({ role: "assistant", content: reply });
    all.push(...lines(reply));
  }

  const normed = all.map(norm).filter(Boolean);
  const uniq = new Set(normed);
  const openers = normed.map(opener).filter(Boolean);
  const openerCounts = {};
  for (const o of openers) openerCounts[o] = (openerCounts[o] ?? 0) + 1;
  const repeatedOpeners = Object.entries(openerCounts).filter(([, n]) => n > 1);

  const asks = all.filter((l) => l.includes("?")).length;

  /* Exact-line matching missed the actual problem.
   *
   * A character with three things in its `extra` block asks about all three
   * forever, rewording each time: "betu khana khaya?", "sach batao khana khaya
   * ki nahi?", "khana kya khaya sach batao pehle". Zero repeated lines, one
   * question asked three times. What is repetitive is the SUBJECT, so that is
   * what has to be counted. */
  const STOP = new Set(
    ("the a an and or but if so is are was were be been am i you he she it we they me my your his her" +
     " to of in on at for with from by as that this these those do does did not no yes ok okay" +
     " hai ho hu hun tum tu tera tumhara mera main mai kya kar karo raha rahi rahe na to ki ke ka" +
     " se me bhi hi ab aur bas kuch nahi nhi yeh ye wo woh toh").split(/\s+/)
  );
  const contentWords = (l) =>
    norm(l).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

  const perTurnWords = [];
  for (const l of all) perTurnWords.push(new Set(contentWords(l)));

  const freq = {};
  for (const set of perTurnWords) for (const w of set) freq[w] = (freq[w] ?? 0) + 1;
  const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);

  /* How much of the conversation is about its single favourite subject. */
  const [topWord, topCount] = ranked[0] ?? [null, 0];

  /* Anything said in the back half that was not already being said in the front
     half. A person brings new things; a loop does not. */
  const half = Math.floor(all.length / 2);
  const early = new Set(perTurnWords.slice(0, half).flatMap((s) => [...s]));
  const lateOnly = new Set(
    perTurnWords.slice(half).flatMap((s) => [...s]).filter((w) => !early.has(w))
  );

  const report = {
    label,
    lines: all.length,
    unique: uniq.size,
    /* The headline: what share of everything it said was something it had
       already said. 0 is a person, high is a loop. */
    echo: +(1 - uniq.size / Math.max(1, normed.length)).toFixed(2),
    repeatedLines: normed.length - uniq.size,
    repeatedOpeners: repeatedOpeners.length,
    worstOpener: repeatedOpeners.sort((a, b) => b[1] - a[1])[0] ?? null,
    askRate: +(asks / Math.max(1, all.length)).toFixed(2),
    /* The real measure of boring: one subject dominating, and nothing new
       arriving once the character has run through its opening material. */
    obsession: topWord ? `${topWord} x${topCount}` : null,
    topSubjects: ranked.slice(0, 5).map(([w, n]) => `${w}:${n}`),
    freshLateWords: lateOnly.size,
    avgWords: +(all.reduce((n, l) => n + l.split(/\s+/).length, 0) / Math.max(1, all.length)).toFixed(1),
    sample: all.slice(0, 14),
  };
  return report;
}

const ADITI = {
  them: "Aditi", you: "Piyush", relationship: "Girlfriend",
  arch: "partner", texture: "devoted", mode: "living", consent: true,
  brief:
    "You write in short lowercase Hinglish bursts, two or three in a row. You almost never punctuate except a question mark. You call him betu. You ask whether he has eaten before anything else.",
  samples: "yo\nbetu kya kar rahe ho\nkhana khaya\ntheek ho?\nbye\nmera mann nahi lag raha\ncall karo na",
  extra: "teases him about bodyfat. calls him betu. always asks if he has eaten.",
};

const MAYA = {
  them: "Maya", you: "Sam", relationship: "best friend",
  arch: "friend", texture: "close", mode: "character",
  brief:
    "You write in short lowercase bursts, two or three in a row rather than one tidy message. You rarely use full stops. You ask what someone actually said, not what they meant. You tease constantly and stop instantly when something is really wrong.",
  samples:
    "ok but what did you actually say to him\nno. not what you meant. what you SAID\nright. thought so\nyou're spiralling. put the phone down and go outside for ten minutes\ni love you but you are being an idiot about this one\nwait is this the same guy from march",
  extra:
    "interrupts spiralling rather than sympathising with it. never lets an excuse stand. remembers small details from months ago and brings them up unprompted.",
};

if (process.argv[1]?.endsWith("chat-quality.mjs")) {
  const who = process.argv[2] === "maya" ? MAYA : ADITI;
  const r = await run(process.argv[2] || "aditi", who);
  console.log(JSON.stringify(r, null, 2));
}

export { ADITI, MAYA, USER_TURNS };
