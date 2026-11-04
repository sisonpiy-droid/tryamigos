/* Server-sent event parsing.
 *
 * Shared because both providers stream SSE and the framing is easy to get
 * subtly wrong: Gemini separates events with CRLF CRLF, Anthropic with LF LF,
 * and splitting on "\n\n" alone silently matches nothing on Gemini -- the
 * stream appears to produce no output rather than failing, which is the worst
 * kind of bug to chase.
 */

/** Splits a byte stream into SSE `data:` payloads, tolerating CRLF or LF and
 *  events arriving split across chunk boundaries. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // An event ends at a blank line. A chunk can split one in half, so the
      // trailing fragment is kept for the next read.
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";

      for (const frame of parts) {
        for (const payload of dataLines(frame)) yield payload;
      }
    }
    // A well-behaved server ends with a blank line, but not all do.
    if (buffer.trim()) for (const payload of dataLines(buffer)) yield payload;
  } finally {
    reader.releaseLock();
  }
}

/** An event may carry several `data:` lines; per spec they concatenate. */
function dataLines(frame: string): string[] {
  const out: string[] = [];
  const collected: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.startsWith("data:")) continue;
    collected.push(line.slice(5).trimStart());
  }
  if (collected.length) {
    const joined = collected.join("\n");
    if (joined && joined !== "[DONE]") out.push(joined);
  }
  return out;
}
