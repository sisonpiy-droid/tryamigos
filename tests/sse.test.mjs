/* SSE framing. This bug produced an empty stream with no error at all, which
   is why it gets tests rather than a fix and a shrug. */
import assert from "node:assert";
import { sseData } from "../src/lib/ai/sse.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

/** Feeds text to the parser in arbitrary byte-sized slices. */
function streamOf(text, chunkSize = 1024) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}
const collect = async (text, chunkSize) => {
  const out = [];
  for await (const p of sseData(streamOf(text, chunkSize))) out.push(p);
  return out;
};

check("CRLF framing, as Gemini actually sends it", async () => {
  // The original parser split on "\n\n" only, matched nothing, and yielded
  // an empty stream without erroring.
  const out = await collect('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n');
  assert.deepEqual(out, ['{"a":1}', '{"a":2}']);
});

check("LF framing, as Anthropic sends it", async () => {
  assert.deepEqual(await collect('data: {"a":1}\n\ndata: {"a":2}\n\n'), ['{"a":1}', '{"a":2}']);
});

check("an event split across chunk boundaries is reassembled", async () => {
  const payload = 'data: {"text":"' + "x".repeat(200) + '"}\r\n\r\n';
  const out = await collect(payload, 7); // deliberately tiny chunks
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).text.length, 200);
});

check("a trailing event with no blank line is not dropped", async () => {
  assert.deepEqual(await collect('data: {"a":1}'), ['{"a":1}']);
});

check("[DONE] and comments are skipped", async () => {
  assert.deepEqual(await collect(': ping\r\n\r\ndata: [DONE]\r\n\r\ndata: {"a":1}\r\n\r\n'), ['{"a":1}']);
});

check("multi-line data in one event concatenates", async () => {
  assert.deepEqual(await collect('data: line one\ndata: line two\n\n'), ["line one\nline two"]);
});

check("named events keep their data", async () => {
  assert.deepEqual(await collect('event: content_block_delta\ndata: {"x":1}\n\n'), ['{"x":1}']);
});

check("streamed fragments keep their leading and trailing spaces", async () => {
  /* Gemini splits mid-sentence, so a delta is often " you" or "the ". Trimming
     each fragment welds words together: "prepareyou", "Pull upthe". */
  const frames = [' you', 'the ', ' up '].map(t => `data: ${JSON.stringify({ text: t })}

`).join("");
  const out = await collect(frames);
  assert.deepEqual(out.map(p => JSON.parse(p).text), [" you", "the ", " up "]);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
