import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExtraItemRender } from "../public/render-decision.mjs";

// Cached entry as renderLog tracks it across ticks.
function cached(blocks, wasLive = false) {
  return { blocks, wasLive };
}

test("first tick of a streaming entry renders without highlight", () => {
  const blocks = [];
  const item = { blocks };
  const r = decideExtraItemRender(cached(blocks, false), item, true);
  assert.equal(r.rerender, true, "live entries always re-render to absorb deltas");
  assert.equal(r.highlight, false, "skip hljs while content is partial");
});

test("steady frozen entry with unchanged blocks is left alone", () => {
  const blocks = [{ type: "text", text: "hi" }];
  const item = { blocks };
  const r = decideExtraItemRender(cached(blocks, false), item, false);
  assert.equal(r.rerender, false);
});

test("blocks reference swap (e.g. onToolEnd) re-renders with highlight", () => {
  const oldBlocks = [{ type: "tool_call", name: "Read", input: {} }];
  const newBlocks = [{ type: "tool_call", name: "Read", input: { file: "x" } }];
  const item = { blocks: newBlocks };
  const r = decideExtraItemRender(cached(oldBlocks, false), item, false);
  assert.equal(r.rerender, true);
  assert.equal(r.highlight, true);
});

// Regression: the live assistant entry holds tool_call/tool_result blocks
// nested inside it. While streaming, hljs is skipped (partial JSON). When
// the entry freezes, the blocks reference does NOT change, so without a
// freeze-transition signal renderLog never re-runs and the JSON never gets
// highlighted. This test pins the desired behavior.
test("freeze transition re-renders with highlight even if blocks unchanged", () => {
  const blocks = [
    { type: "text", text: "calling tool" },
    { type: "tool_call", name: "Read", input: { file: "x" } },
  ];
  const item = { blocks };
  const r = decideExtraItemRender(cached(blocks, true), item, false);
  assert.equal(r.rerender, true, "must re-render once on freeze to apply hljs");
  assert.equal(r.highlight, true, "now-frozen content should be highlighted");
});
