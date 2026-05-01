import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChatState,
  submitUser,
  setHistory,
  selectItems,
} from "../public/chat-state.mjs";
import { dispatchSessionEvent } from "../public/session-dispatch.mjs";

// These tests exercise the session-event → chat-state dispatch, modeling the
// real SDK payload shapes (args / toolCallId / toolCall) so we can catch
// field-name regressions and timing issues end-to-end.

function startedSession() {
  const s = createChatState();
  submitUser(s, "hi");
  dispatchSessionEvent(s, { type: "agent_start" });
  setHistory(s, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  return s;
}

// ── Regression: SDK uses `args`, not `input` ─────────────────────────────────

test("tool_execution_start carries input via event.args (SDK field)", () => {
  // Repro for: tool calls render with empty params during streaming and only
  // get backfilled when the canonical snapshot lands. The SDK emits the args
  // under `args`, but the dispatcher was reading `event.input`, so the
  // streaming tool_call ended up with input=undefined.
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "tool_execution_start",
    toolCallId: "tc_1",
    toolName: "Read",
    args: { path: "/etc/passwd", limit: 10 },
  });
  const live = s.liveAssistant;
  assert.ok(live, "live assistant must exist");
  const call = live.blocks.find((b) => b.type === "tool_call");
  assert.ok(call, "tool_call block present");
  assert.equal(call.name, "Read");
  assert.deepEqual(
    call.input,
    { path: "/etc/passwd", limit: 10 },
    "input must come from event.args, not event.input",
  );
});

test("tool_execution_end carries result via event.result", () => {
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "tool_execution_start",
    toolCallId: "tc_1",
    toolName: "Read",
    args: { path: "/x" },
  });
  dispatchSessionEvent(s, {
    type: "tool_execution_end",
    toolCallId: "tc_1",
    toolName: "Read",
    result: [{ type: "text", text: "file contents" }],
  });
  const extras = selectItems(s).filter((it) => it.source === "extra");
  const resultItem = extras.find((it) => it.item.kind === "tool");
  assert.ok(resultItem, "tool result item present");
  assert.deepEqual(
    resultItem.item.blocks[0].result,
    [{ type: "text", text: "file contents" }],
  );
});

// ── Feature: render tool_call as soon as the LLM finishes generating it ─────

test("message_update with toolcall_end renders the tool_call immediately", () => {
  // The SDK forwards LLM stream events through message_update. toolcall_end
  // arrives BEFORE pi has accepted/started the call — surfacing the call now
  // eliminates the blank pause between text streaming and tool_execution_start.
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "checking..." },
  });
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
  });
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"/x"}' },
  });
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } },
    },
  });
  // No tool_execution_start fired yet, but the call must be visible.
  const live = s.liveAssistant;
  assert.ok(live);
  const types = live.blocks.map((b) => b.type);
  assert.deepEqual(types, ["text", "tool_call"]);
  const call = live.blocks[1];
  assert.equal(call.name, "Read");
  assert.deepEqual(call.input, { path: "/x" });
});

test("tool_execution_start does NOT duplicate a tool_call already added by toolcall_end", () => {
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } },
    },
  });
  // pi accepts the call. ID matches — must not append another tool_call block.
  dispatchSessionEvent(s, {
    type: "tool_execution_start",
    toolCallId: "tc_1",
    toolName: "Read",
    args: { path: "/x" },
  });
  const callBlocks = s.liveAssistant.blocks.filter((b) => b.type === "tool_call");
  assert.equal(callBlocks.length, 1, "only one tool_call block; no duplicate");
  // Result placeholder still appears as its own top-level extra.
  const extras = selectItems(s).filter((it) => it.source === "extra");
  const resultItem = extras.find((it) => it.item.kind === "tool");
  assert.ok(resultItem, "result placeholder added by tool_execution_start");
});

test("tool_execution_start without prior toolcall_end still adds the tool_call (fallback)", () => {
  // Defensive: e.g. on reconnect after a missed message_update.
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "tool_execution_start",
    toolCallId: "tc_1",
    toolName: "Read",
    args: { path: "/x" },
  });
  const callBlocks = s.liveAssistant.blocks.filter((b) => b.type === "tool_call");
  assert.equal(callBlocks.length, 1, "tool_call appears via the fallback path");
  assert.deepEqual(callBlocks[0].input, { path: "/x" });
});

// ── Backwards-compat: existing delta types still flow through ───────────────

test("message_update with text_delta still grows the live assistant text block", () => {
  const s = startedSession();
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
  });
  dispatchSessionEvent(s, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  const live = s.liveAssistant;
  assert.equal(live.blocks.length, 1);
  assert.equal(live.blocks[0].type, "text");
  assert.equal(live.blocks[0].text, "Hello");
});
