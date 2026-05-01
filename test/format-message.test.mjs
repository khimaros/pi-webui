import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessage, sdkContentToBlocks } from "../public/format-message.mjs";

test("toolResult message preserves details (e.g. edit-tool diff)", () => {
  // Shape mirrors the JSONL written by pi-coding-agent for the "edit" tool:
  // top-level toolResult with a sibling `details.diff` alongside `content`.
  const message = {
    role: "toolResult",
    toolName: "edit",
    content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
    details: { diff: "@@ -1,3 +1,3 @@\n-old\n+new", firstChangedLine: 26 },
  };
  const formatted = formatMessage(message);
  const block = formatted.blocks[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.name, "edit");
  // The renderer needs both content and details to build the diff toggle.
  // Whatever shape `result` takes, extractResultParts must be able to pull
  // both back out — assert details survives by name.
  assert.ok(block.result, "result must be present");
  assert.deepStrictEqual(block.result.details, {
    diff: "@@ -1,3 +1,3 @@\n-old\n+new",
    firstChangedLine: 26,
  });
});

test("sdkContentToBlocks preserves details on embedded toolResult blocks", () => {
  // Some transports emit toolResult as a block inside an assistant message's
  // content array rather than as a top-level message.
  const content = [
    {
      type: "toolResult",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced." }],
      details: { diff: "@@ ..." },
    },
  ];
  const blocks = sdkContentToBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "tool_result");
  assert.ok(blocks[0].result);
  assert.deepStrictEqual(blocks[0].result.details, { diff: "@@ ..." });
});
