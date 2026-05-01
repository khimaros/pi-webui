// Pure helpers for normalizing tool-result payloads into displayable text.
// Extracted from app.js so the boundary between streamed and canonical
// shapes can be tested without a DOM.
//
// Shapes seen in practice:
//   - canonical (after reload): SDK persists toolResult.content as
//     (TextContent | ImageContent)[] — bare array.
//   - streaming (tool_execution_end.result per pi RPC docs):
//     { content: [{ type: "text", text }], details: {...} } — wrapper
//     object; we unwrap into its `content` array.

export function extractTextFromResult(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts = result
      .map((p) => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : null))
      .filter((t) => t !== null);
    if (texts.length > 0) return texts.join("\n");
    return null;
  }
  if (result && Array.isArray(result.content)) return extractTextFromResult(result.content);
  if (result && typeof result.text === "string") return result.text;
  return null;
}

export function extractResultParts(result) {
  // Normalise the result into { text, details } for renderer consumption.
  // Handles both canonical (array of content objects) and streaming
  // ({ content, details }) shapes.  Returns { text: string|null,
  // details: object|null }.
  let text = null;
  let details = null;

  if (result === null || result === undefined) {
    return { text, details };
  }

  if (typeof result === "string") {
    return { text: result, details };
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      if (item && typeof item === "object") {
        if (!details && "details" in item) details = item.details;
        if (item.type === "text" && typeof item.text === "string") {
          text = text ? text + "\n" + item.text : item.text;
        }
      }
    }
    // Flattened strings
    if (!text) {
      const texts = result.filter((x) => typeof x === "string");
      if (texts.length) text = texts.join("\n");
    }
    return { text, details };
  }

  // Object with { content, details } — streaming shape.
  if (result.content) {
    const inner = Array.isArray(result.content)
      ? result.content
      : result.content.text
        ? [{ type: "text", text: result.content.text }]
        : null;
    if (inner) {
      details = result.details || null;
      const texts = inner
        .map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : null))
        .filter((t) => t !== null);
      if (texts.length) text = texts.join("\n");
    }
    return { text, details };
  }

  if (result.text) {
    return { text: result.text, details };
  }

  return { text, details };
}

export function stripCatNLinePrefixes(text) {
  // tool "Read" returns lines like "  123\tcontent" — strip the line-number prefix.
  const lines = text.split("\n");
  let stripped = 0;
  const out = lines.map((line) => {
    const m = line.match(/^\s*\d+\t(.*)$/);
    if (m) {
      stripped += 1;
      return m[1];
    }
    return line;
  });
  const nonEmpty = lines.filter((l) => l.length > 0).length;
  return nonEmpty > 0 && stripped / nonEmpty > 0.6 ? out.join("\n") : text;
}
