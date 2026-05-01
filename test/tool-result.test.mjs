import { test } from "node:test";
import assert from "node:assert/strict";
import { extractTextFromResult, extractResultParts } from "../public/tool-result.mjs";

test("plain string passes through", () => {
  assert.equal(extractTextFromResult("hello"), "hello");
});

test("canonical reload shape: array of text content blocks", () => {
  // SDK persists toolResult.content as (TextContent | ImageContent)[].
  const content = [{ type: "text", text: "line one" }, { type: "text", text: "line two" }];
  assert.equal(extractTextFromResult(content), "line one\nline two");
});

test("array of bare strings joins with newlines", () => {
  assert.equal(extractTextFromResult(["a", "b"]), "a\nb");
});

test("object with .text returns that text", () => {
  assert.equal(extractTextFromResult({ text: "ok" }), "ok");
});

// Regression: streaming `tool_execution_end.result` per pi RPC docs is
// shaped { content: [{type:"text", text}], details: {...} } — a wrapper
// object, not a bare array. Today extractTextFromResult returns null for
// this shape, so renderToolResultBlockHtml falls through to a raw JSON
// dump. Reload works only because the SDK persists just `content` (the
// inner array). Both paths must produce the same display text.
test("streaming wrapper shape ({ content, details }) extracts text", () => {
  const streamed = {
    content: [{ type: "text", text: "tool output here" }],
    details: { truncation: null, fullOutputPath: null },
  };
  assert.equal(
    extractTextFromResult(streamed),
    "tool output here",
    "streamed result must yield the same text as the canonical shape",
  );
});

test("streaming wrapper with multiple text blocks joins them", () => {
  const streamed = {
    content: [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ],
    details: {},
  };
  assert.equal(extractTextFromResult(streamed), "line one\nline two");
});

// ── extractResultParts tests ──────────────────────────────────────────

test("null/undefined returns { text: null, details: null }", () => {
  assert.deepStrictEqual(extractResultParts(null), { text: null, details: null });
  assert.deepStrictEqual(extractResultParts(undefined), { text: null, details: null });
});

test("plain string returns text only", () => {
  assert.deepStrictEqual(extractResultParts("hello world"), { text: "hello world", details: null });
});

test("canonical array extracts text and any details from items", () => {
  const result = [
    { type: "text", text: "Applied" },
    { details: { diff: "@@ ..." } },
  ];
  const { text, details } = extractResultParts(result);
  assert.equal(text, "Applied");
  assert.deepStrictEqual(details, { diff: "@@ ..." });
});

test("streaming wrapper extracts text and details", () => {
  const result = {
    content: [{ type: "text", text: "3 changes applied" }],
    details: { diff: "@@ -1,3 +1,3 @@\n-old\n+new" },
  };
  const { text, details } = extractResultParts(result);
  assert.equal(text, "3 changes applied");
  assert.equal(details.diff, "@@ -1,3 +1,3 @@\n-old\n+new");
});

test("array of bare strings extracts text, no details", () => {
  assert.deepStrictEqual(extractResultParts(["a", "b"]), { text: "a\nb", details: null });
});

test("single object with text property", () => {
  assert.deepStrictEqual(
    extractResultParts({ text: "hello" }),
    { text: "hello", details: null },
  );
});
