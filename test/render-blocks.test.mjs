import { test } from "node:test";
import assert from "node:assert/strict";
import { planBlockRenders, reconcileChildrenInPlace } from "../public/render-blocks.mjs";

// Tiny fake parent that records every snapshot of its children array so we
// can inspect the intermediate states reconcileChildrenInPlace produces.
function fakeParent(initial = []) {
  const children = [...initial];
  const snapshots = [[...children]];
  const snap = () => snapshots.push([...children]);
  return {
    children,
    snapshots,
    get firstChild() { return children[0] ?? null; },
    get lastChild() { return children[children.length - 1] ?? null; },
    get childNodes() { return children; },
    appendChild(node) { children.push(node); snap(); return node; },
    removeChild(node) {
      const i = children.indexOf(node);
      if (i >= 0) children.splice(i, 1);
      snap();
      return node;
    },
    insertBefore(node, ref) {
      const cur = children.indexOf(node);
      if (cur >= 0) children.splice(cur, 1);
      if (ref == null) {
        children.push(node);
      } else {
        const at = children.indexOf(ref);
        children.splice(at < 0 ? children.length : at, 0, node);
      }
      snap();
      return node;
    },
  };
}

test("first render: every block is built", () => {
  const blocks = [
    { type: "text", text: "hello" },
    { type: "tool_call", name: "edit", input: { path: "/x" } },
  ];
  const plan = planBlockRenders(blocks, null);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].action, "build");
  assert.equal(plan[1].action, "build");
});

// Regression: scrolling gets stuck during streaming because the live
// assistant's .message-body is rebuilt on every text delta, which redraws
// (and eventually re-highlights) any tool_call block already inside it.
// chat-state pushes the tool_call once and never replaces the reference,
// so once we've rendered it we should be able to keep the existing node.
test("tool_call block with stable reference is kept across re-renders", () => {
  const toolCall = { type: "tool_call", name: "edit", input: { path: "/x" } };
  const prev = [{ type: "text", text: "thinking" }, toolCall];
  // Text block mutates in place (chat-state appends to .text); same array
  // and same block references — only the inner text grew.
  prev[0].text += "...";
  const next = prev;
  const plan = planBlockRenders(next, prev);
  assert.equal(plan[1].action, "keep", "tool_call should be reused on re-render");
});

test("tool_result block with stable reference is also kept", () => {
  const toolResult = { type: "tool_result", name: "edit", result: { content: [], details: {} } };
  const prev = [toolResult];
  const plan = planBlockRenders(prev, prev);
  assert.equal(plan[0].action, "keep");
});

test("text block always builds (content may have grown)", () => {
  const textBlock = { type: "text", text: "hi" };
  const prev = [textBlock];
  textBlock.text += " there";
  const plan = planBlockRenders([textBlock], prev);
  assert.equal(plan[0].action, "build");
});

test("a new block at a position not present in prev is built", () => {
  const toolCall = { type: "tool_call", name: "edit", input: {} };
  const prev = [{ type: "text", text: "hi" }];
  const next = [prev[0], toolCall];
  const plan = planBlockRenders(next, prev);
  assert.equal(plan[1].action, "build");
});

// ── reconcileChildrenInPlace ──────────────────────────────────────────
//
// Regression: scroll auto-follow stops working after a tool result is
// rendered. Cause — the reconcile algorithm transiently empties the
// parent (`while firstChild remove`) before re-appending. While the
// parent is empty, the scroll container's scrollHeight shrinks past
// scrollTop; the browser clamps scrollTop, fires a scroll event, and the
// followBottom listener observes "no longer at bottom" and disables
// auto-follow. The invariant: if both `existing` and `desired` are
// non-empty, the parent must never be empty at any intermediate step.

test("reconcile produces final state matching desired", () => {
  const A = { id: "A" }, B = { id: "B" }, C = { id: "C" };
  const parent = fakeParent([A, B]);
  reconcileChildrenInPlace(parent, [A, B, C]);
  assert.deepEqual(parent.children, [A, B, C]);
});

test("reconcile never empties the parent when both sides are non-empty", () => {
  const A = { id: "A" }, B = { id: "B" }, C = { id: "C" };
  const parent = fakeParent([A, B]);
  reconcileChildrenInPlace(parent, [A, B, C]);
  // Every intermediate snapshot of the children array must be non-empty.
  for (const snap of parent.snapshots) {
    assert.ok(snap.length > 0, `parent went empty at some point: ${JSON.stringify(parent.snapshots)}`);
  }
});

test("reconcile keeps the kept node identity when nothing changed", () => {
  const A = { id: "A" }, B = { id: "B" };
  const parent = fakeParent([A, B]);
  const before = parent.children[0];
  reconcileChildrenInPlace(parent, [A, B]);
  assert.equal(parent.children[0], before, "kept node should not be removed/re-added");
});
