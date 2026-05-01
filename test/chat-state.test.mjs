import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChatState,
  submitUser,
  setHistory,
  resetHistory,
  applyDelta,
  onToolStart,
  onToolEnd,
  onAgentStart,
  onAgentEnd,
  setError,
  clearError,
  selectItems,
  userMessageText,
} from "../public/chat-state.mjs";

// Returns the text of the first text block in an item, if any.
function itemText(item) {
  if (!item?.blocks) return null;
  const t = item.blocks.find((b) => b.type === "text");
  return t ? t.text : null;
}

// Returns true if the rendered items show a user message whose text is `text`.
function hasUserMessage(items, text) {
  for (const it of items) {
    if (it.source === "extra" && it.item.kind === "user" && itemText(it.item) === text) return true;
    if (it.source === "canonical" && userMessageText(it.message) === text) return true;
  }
  return false;
}

function userMsg(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("submit shows user message immediately", () => {
  const s = createChatState();
  submitUser(s, "hi");
  assert.ok(hasUserMessage(selectItems(s), "hi"), "user message should be visible after submit");
});

test("user message stays visible after agent_start snapshot that does not yet include it", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, []); // server snapshot at agent_start lacks user message
  assert.ok(
    hasUserMessage(selectItems(s), "hi"),
    "user message must remain visible after early-snapshot replaces canonical",
  );
});

test("user message visible exactly once when agent_start snapshot already contains it", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  const items = selectItems(s);
  let count = 0;
  for (const it of items) {
    if (it.source === "extra" && it.item.kind === "user" && itemText(it.item) === "hi") count += 1;
    if (it.source === "canonical" && userMessageText(it.message) === "hi") count += 1;
  }
  assert.equal(count, 1, "user message should appear exactly once, not duplicated");
});

test("typing indicator shows immediately on submit", () => {
  const s = createChatState();
  submitUser(s, "hi");
  const items = selectItems(s);
  assert.ok(items.some((it) => it.source === "typing"), "typing indicator should be visible");
});

test("typing indicator clears once first delta arrives", () => {
  const s = createChatState();
  submitUser(s, "hi");
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  const items = selectItems(s);
  assert.ok(!items.some((it) => it.source === "typing"), "typing should clear after first delta");
});

test("strict ordering: user, then assistant streaming below", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  const items = selectItems(s);
  const userIdx = items.findIndex(
    (it) =>
      (it.source === "canonical" && userMessageText(it.message) === "hi") ||
      (it.source === "extra" && it.item.kind === "user" && itemText(it.item) === "hi"),
  );
  const asstIdx = items.findIndex((it) => it.source === "extra" && it.item.kind === "assistant");
  assert.notEqual(userIdx, -1, "user should be present");
  assert.notEqual(asstIdx, -1, "streaming assistant should be present");
  assert.ok(userIdx < asstIdx, "user must come before streaming assistant");
});

test("prior turn's assistant stays visible while next turn streams before snapshot lands", () => {
  // Reproduces: between turn N submit and the message_history snapshot that
  // includes the new user message, selectItems used lastUserMessageIndex of
  // canonical (still pointing at turn N-1's user) as the canonical clip
  // boundary — hiding turn N-1's assistant content until the next snapshot.
  const s = createChatState();
  // Snapshot after turn 1 completes.
  setHistory(s, [userMsg("first"), assistantMsg("response one")]);
  // User submits turn 2; streaming begins before server sends an updated snapshot.
  submitUser(s, "second");
  onAgentStart(s);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "working..." });

  const items = selectItems(s);
  const firstUserShown = items.some(
    (it) => it.source === "canonical" && userMessageText(it.message) === "first",
  );
  const firstAssistantShown = items.some(
    (it) => it.source === "canonical" && it.message?.role === "assistant",
  );
  assert.ok(firstUserShown, "turn 1 user must remain visible during turn 2 streaming");
  assert.ok(
    firstAssistantShown,
    "turn 1 assistant must remain visible during turn 2 streaming (was being clipped by canonicalEnd boundary)",
  );
});

test("strict ordering: thinking delta then text delta render in order as separate blocks", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "thinking_delta", contentIndex: 0, delta: "thinking..." });
  applyDelta(s, { type: "text_delta", contentIndex: 1, delta: "answer" });
  const items = selectItems(s);
  const live = items.find((it) => it.source === "extra" && it.item.kind === "assistant");
  assert.ok(live, "live assistant present");
  // Blocks should be ordered: thinking first, then text.
  assert.deepEqual(
    live.item.blocks.map((b) => `${b.type}:${b.text}`),
    ["thinking:thinking...", "text:answer"],
    "thinking must precede final text in blocks array",
  );
});

test("tool call between assistant text splits into 3 entries: assistant, result, assistant", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "I'll check." });
  onToolStart(s, "Read", { path: "/tmp/x" });
  onToolEnd(s, "Read", [{ type: "text", text: "file contents" }]);
  applyDelta(s, { type: "text_delta", contentIndex: 2, delta: "Done." });
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 3);
  assert.deepEqual(extras.map((it) => it.item.kind), ["assistant", "tool", "assistant"]);
  assert.deepEqual(extras[0].item.blocks.map((b) => b.type), ["text", "tool_call"]);
  assert.deepEqual(extras[1].item.blocks.map((b) => b.type), ["tool_result"]);
  assert.deepEqual(extras[2].item.blocks.map((b) => b.type), ["text"]);
});

// ── Failure / disconnect paths ──────────────────────────────────────────────

function hasTyping(items) {
  return items.some((it) => it.source === "typing");
}

test("agent_end alone clears the typing indicator (no snapshot follows on LLM error)", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, []);
  onAgentEnd(s);
  const items = selectItems(s);
  assert.equal(s.isRunning, false, "isRunning must be false");
  assert.ok(!hasTyping(items), "typing indicator must clear after agent_end");
});

test("agent_end during streaming preserves partial assistant + ordering, clears typing", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "thinking_delta", contentIndex: 0, delta: "thinking..." });
  applyDelta(s, { type: "text_delta", contentIndex: 1, delta: "partial answer" });
  onAgentEnd(s);
  const items = selectItems(s);
  assert.ok(!hasTyping(items), "typing indicator must clear after agent_end");
  const userIdx = items.findIndex(
    (it) => it.source === "canonical" && userMessageText(it.message) === "hi",
  );
  const asstIdx = items.findIndex((it) => it.source === "extra" && it.item.kind === "assistant");
  assert.notEqual(userIdx, -1, "user visible");
  assert.notEqual(asstIdx, -1, "partial assistant visible");
  assert.ok(userIdx < asstIdx, "user must precede assistant");
  // Partial text retained as a text block.
  const live = items[asstIdx].item;
  const hasPartial = live.blocks.some((b) => b.type === "text" && b.text.includes("partial answer"));
  assert.ok(hasPartial, "partial text retained in blocks");
});

test("agent_end after tool start without tool end clears typing; entries preserved", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Calling tool..." });
  onToolStart(s, "Read", { path: "/tmp/x" });
  // Two top-level extras now: assistant (text + tool_call) and the pending
  // tool_result placeholder.
  const before = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(before.length, 2);
  assert.deepEqual(before.map((it) => it.item.kind), ["assistant", "tool"]);
  assert.deepEqual(before[0].item.blocks.map((b) => b.type), ["text", "tool_call"]);
  assert.equal(before[1].item.blocks[0].result, null, "placeholder result stays null when tool never completed");

  onAgentEnd(s);
  const items = selectItems(s);
  assert.ok(!hasTyping(items), "typing indicator must clear");
  const extras = items.filter((it) => it.source === "extra");
  assert.equal(extras.length, 2, "both entries survive agent_end");
});

test("user message preserved when agent never produces canonical update (server crash)", () => {
  const s = createChatState();
  submitUser(s, "what's up");
  onAgentStart(s);
  onAgentEnd(s);
  const items = selectItems(s);
  assert.equal(s.isRunning, false);
  assert.ok(!hasTyping(items), "typing must clear");
  assert.ok(hasUserMessage(items, "what's up"), "user message must still be visible");
});

test("websocket reconnect (replay miss): resetHistory discards stale streaming extras", () => {
  // On reconnect, if the server's event-log buffer doesn't cover the gap
  // (replay miss), it sends a session reset followed by a fresh canonical
  // snapshot. resetHistory clears the partial assistant + abandoned tool
  // entries the client had been showing.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "stale partial" });
  onToolStart(s, "Read", { path: "/x" });
  onAgentEnd(s);
  resetHistory(s, [userMsg("hi")]);
  const items = selectItems(s);
  assert.ok(!hasTyping(items), "typing must be off after reset");
  assert.equal(
    items.filter((it) => it.source === "extra").length,
    0,
    "stale streaming extras must be discarded by resetHistory",
  );
  assert.ok(hasUserMessage(items, "hi"), "canonical user message visible");
});

test("strict ordering after agent_end with mixed events", () => {
  const s = createChatState();
  submitUser(s, "do a thing");
  onAgentStart(s);
  setHistory(s, [userMsg("do a thing")]);
  applyDelta(s, { type: "thinking_delta", contentIndex: 0, delta: "let me think" });
  applyDelta(s, { type: "text_delta", contentIndex: 1, delta: "I'll read a file." });
  onToolStart(s, "Read", { path: "/x" });
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);
  applyDelta(s, { type: "text_delta", contentIndex: 4, delta: "Done." });
  onAgentEnd(s);
  const items = selectItems(s);
  assert.ok(!hasTyping(items), "no typing after agent_end");
  // Layout: canonical user, assistant1 (thinking + text + tool_call),
  // tool result, assistant2 (text).
  const summary = items.map((it) =>
    it.source === "canonical"
      ? `canon:${it.message.role}`
      : it.source === "extra"
        ? `extra:${it.item.kind}`
        : "typing",
  );
  assert.deepEqual(summary, ["canon:user", "extra:assistant", "extra:tool", "extra:assistant"]);
  assert.deepEqual(
    items[1].item.blocks.map((b) => b.type),
    ["thinking", "text", "tool_call"],
  );
  assert.deepEqual(items[2].item.blocks.map((b) => b.type), ["tool_result"]);
  assert.deepEqual(items[3].item.blocks.map((b) => b.type), ["text"]);
});

// ── Tool result placeholder ─────────────────────────────────────────────────

test("tool_execution_end fills the pending placeholder; map cleared; liveAssistant reset", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolStart(s, "Read", { path: "/x" });
  const placeholder = [...s.pendingToolResults.values()][0];
  assert.ok(placeholder, "pending placeholder present before end");
  onToolEnd(s, "Read", [{ type: "text", text: "file contents" }]);
  assert.equal(s.pendingToolResults.size, 0, "map cleared after end");
  assert.equal(s.liveAssistant, null, "liveAssistant reset so next text starts a new section");
  assert.deepEqual(placeholder.blocks[0].result, [{ type: "text", text: "file contents" }]);
});

test("tool call block carries structured input, not a serialized string", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolStart(s, "Read", { path: "/etc/passwd", limit: 10 });
  const call = s.liveAssistant.blocks[0];
  assert.equal(call.type, "tool_call");
  assert.equal(call.name, "Read");
  assert.deepEqual(call.input, { path: "/etc/passwd", limit: 10 });
});

test("multiple sequential tool calls produce alternating assistant/tool entries", () => {
  // Each tool_end resets liveAssistant, so the next tool_start spins up a
  // fresh assistant entry. Layout matches what canonical would show after
  // reload: assistant(tool_call), tool_result, assistant(tool_call), tool_result.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolStart(s, "Read", { path: "/a" });
  onToolEnd(s, "Read", [{ type: "text", text: "A" }]);
  onToolStart(s, "Read", { path: "/b" });
  onToolEnd(s, "Read", [{ type: "text", text: "B" }]);
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.deepEqual(
    extras.map((it) => `${it.item.kind}:${it.item.blocks.map((b) => b.type).join(",")}`),
    ["assistant:tool_call", "tool:tool_result", "assistant:tool_call", "tool:tool_result"],
  );
  const results = extras.filter((it) => it.item.kind === "tool");
  assert.deepEqual(results[0].item.blocks[0].result, [{ type: "text", text: "A" }]);
  assert.deepEqual(results[1].item.blocks[0].result, [{ type: "text", text: "B" }]);
});

test("tool_execution_end without a prior start appends a tool_result block", () => {
  // Defensive: server might emit out-of-order events, or a result may arrive
  // after a reconnect with no matching tool_execution_start.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolEnd(s, "Read", [{ type: "text", text: "orphan" }]);
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 1, "synthesized assistant entry holds the orphan result");
  const blocks = extras[0].item.blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["tool_result"]);
  assert.deepEqual(blocks[0].result, [{ type: "text", text: "orphan" }]);
});


// ── Error indicator ─────────────────────────────────────────────────────────

test("setError stores last error and is exposed via state.lastError", () => {
  const s = createChatState();
  setError(s, "rate limit");
  assert.equal(s.lastError, "rate limit");
});

test("error survives agent_end so it can be shown after a failed turn", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setError(s, "model overloaded");
  onAgentEnd(s);
  assert.equal(s.lastError, "model overloaded", "error must persist past agent_end");
});

test("starting a new successful turn clears the previous error", () => {
  const s = createChatState();
  setError(s, "previous failure");
  submitUser(s, "retry");
  onAgentStart(s);
  assert.equal(s.lastError, null, "agent_start should clear stale error");
});

test("clearError resets lastError to null", () => {
  const s = createChatState();
  setError(s, "x");
  clearError(s);
  assert.equal(s.lastError, null);
});

test("streamed extras survive a canonical snapshot containing the same content", () => {
  // Why this matters: the DOM renderer keys element identity on extras-item
  // identity (WeakMap). When setHistory throws the streamed extras away on
  // agent_end, the corresponding DOM nodes are removed by reconcileChildren
  // and any UI state on them — <details> open/closed, scroll position inside
  // a tool result, text selection — is lost.
  //
  // Fix model: keep streamed extras whose content is now reflected in
  // canonical, and have selectItems dedupe so they don't render twice.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  const streamed = s.streamExtras.find((e) => e.kind === "assistant");
  assert.ok(streamed, "streamed assistant entry exists");

  onAgentEnd(s);
  setHistory(s, [
    userMsg("hi"),
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ]);

  const items = selectItems(s);
  // Same item object must still be in the rendered list so the renderer's
  // WeakMap-keyed DOM node (and its open <details>) survives.
  const matched = items.filter((it) => it.source === "extra" && it.item === streamed);
  assert.equal(matched.length, 1, "streamed assistant identity preserved across snapshot");

  // And the assistant message must not be rendered twice — once via canonical
  // and once via the surviving extra.
  const assistantCount = items.filter(
    (it) =>
      (it.source === "canonical" && it.message.role === "assistant") ||
      (it.source === "extra" && it.item.kind === "assistant"),
  ).length;
  assert.equal(assistantCount, 1, "assistant message must not appear twice");
});

test("agent_end + final canonical snapshot keeps streamed extras and dedupes the canonical tail", () => {
  // With the buffer+replay model, streamed extras are sticky — they own the
  // visible tail of the conversation since the last user message. The
  // canonical snapshot still arrives but is hidden past that user message;
  // it kicks in for rendering only after a resetHistory (cold start, session
  // switch, or replay miss).
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  onAgentEnd(s);
  setHistory(s, [
    userMsg("hi"),
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ]);
  const items = selectItems(s);
  // user from canonical, then streamed assistant — exactly one of each.
  assert.equal(items.filter((it) => it.source === "typing").length, 0);
  const canonRoles = items.filter((it) => it.source === "canonical").map((it) => it.message.role);
  assert.deepEqual(canonRoles, ["user"], "only canonical messages up to last user are rendered");
  const extras = items.filter((it) => it.source === "extra");
  assert.equal(extras.length, 1);
  assert.equal(extras[0].item.kind, "assistant");
});

test("submitting a new prompt does not erase the previous assistant response", () => {
  // Repro: after a turn finishes, streamed extras hold the assistant response.
  // Canonical also has it (added at agent_end's sendMessages). When the user
  // submits a new prompt, submitUser clears streamExtras — and the previous
  // assistant must keep rendering, this time from canonical.
  const s = createChatState();
  // Turn 1 happens.
  submitUser(s, "u1");
  onAgentStart(s);
  setHistory(s, [userMsg("u1")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "first answer" });
  onAgentEnd(s);
  setHistory(s, [
    userMsg("u1"),
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  ]);
  // Confirm the previous assistant is currently visible (via extras).
  let items = selectItems(s);
  let assistantBlocks = items
    .filter((it) => it.source === "extra" && it.item.kind === "assistant")
    .flatMap((it) => it.item.blocks)
    .filter((b) => b.type === "text")
    .map((b) => b.text);
  assert.ok(assistantBlocks.includes("first answer"), "previous assistant visible before new submit");

  // User starts a new prompt.
  submitUser(s, "u2");
  items = selectItems(s);
  // Previous assistant must still be visible — now via canonical, since
  // submitUser clears streamExtras for the new turn.
  const visibleAssistantTexts = [];
  for (const it of items) {
    if (it.source === "canonical" && it.message.role === "assistant") {
      const t = (it.message.content || []).find((b) => b.type === "text");
      if (t) visibleAssistantTexts.push(t.text);
    }
    if (it.source === "extra" && it.item.kind === "assistant") {
      for (const b of it.item.blocks) {
        if (b.type === "text") visibleAssistantTexts.push(b.text);
      }
    }
  }
  assert.ok(
    visibleAssistantTexts.includes("first answer"),
    "previous assistant must remain visible after new submit",
  );
});

test("agent_end between toolcall_end and tool_execution_start does not duplicate the tool_call", () => {
  // Repro: when agent_end fires after the LLM streamed a tool_use but BEFORE
  // pi accepts the call, our liveAssistant pointer is reset. Then
  // tool_execution_start's ensureLiveAssistant creates a fresh assistant
  // entry and dedup against id only checks THAT new entry's blocks (empty),
  // so it pushes the tool_call again. Result: two assistant entries each
  // containing the same tool_call.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "I'll check." });
  applyDelta(s, {
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } },
  });
  // LLM turn ends; pi has not yet started the tool.
  onAgentEnd(s);
  onToolStart(s, "Read", { path: "/x" }, "tc_1");
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);

  const extras = selectItems(s).filter((it) => it.source === "extra");
  // Expect: assistant(text + tool_call), tool result. Exactly two entries.
  assert.equal(extras.length, 2, "no phantom assistant entry");
  assert.deepEqual(extras.map((it) => it.item.kind), ["assistant", "tool"]);
  assert.deepEqual(
    extras[0].item.blocks.map((b) => b.type),
    ["text", "tool_call"],
    "tool_call appears exactly once, in the assistant entry that emitted it",
  );
  // No second assistant entry containing a duplicate tool_call.
  const allToolCalls = extras
    .filter((it) => it.item.kind === "assistant")
    .flatMap((it) => it.item.blocks)
    .filter((b) => b.type === "tool_call" && b.id === "tc_1");
  assert.equal(allToolCalls.length, 1, "tool_call must not appear in a second assistant entry");
});

test("agent_end between tool_execution_start and tool_execution_end fills the placeholder, no phantom", () => {
  // Repro: the SDK fires agent_end at the end of the LLM turn — BEFORE pi
  // runs the tool. If onAgentEnd resets pendingToolResults, the subsequent
  // tool_execution_end can't find its placeholder and falls into the orphan
  // branch, pushing a fresh "Tool result" entry. Visually that's a phantom
  // empty result followed by a correct filled result.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "checking..." });
  onToolStart(s, "Read", { path: "/x" }, "tc_1");
  // LLM turn ends (assistant message done) before pi finishes running the tool.
  onAgentEnd(s);
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);

  const extras = selectItems(s).filter((it) => it.source === "extra");
  const toolResults = extras.filter((it) => it.item.kind === "tool");
  assert.equal(
    toolResults.length,
    1,
    "exactly one tool_result entry — no phantom from a stranded placeholder",
  );
  assert.deepEqual(
    toolResults[0].item.blocks[0].result,
    [{ type: "text", text: "data" }],
    "the single entry must carry the actual result",
  );
});

// ── Buffer+replay model: setHistory preserves extras, resetHistory clears ──

test("setHistory with no extras renders all canonical messages", () => {
  // Cold start / first bootstrap: no streamed extras; canonical drives the
  // entire view with no skipping.
  const s = createChatState();
  setHistory(s, [
    userMsg("hi"),
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    userMsg("again"),
    { role: "assistant", content: [{ type: "text", text: "Yes" }] },
  ]);
  const items = selectItems(s);
  assert.equal(items.filter((it) => it.source === "canonical").length, 4);
  assert.equal(items.filter((it) => it.source === "extra").length, 0);
});

test("selectItems hides canonical past the last user when streamed extras exist", () => {
  // Streamed extras represent the visible tail since the last user message.
  // The canonical assistant for that tail must NOT also render.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hello" });
  setHistory(s, [
    userMsg("hi"),
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ]);
  const items = selectItems(s);
  const canonRoles = items.filter((it) => it.source === "canonical").map((it) => it.message.role);
  assert.deepEqual(canonRoles, ["user"], "canonical assistant after last user is hidden");
  assert.equal(items.filter((it) => it.source === "extra").length, 1);
});

test("resetHistory clears all streamed extras and renders canonical fully", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "stale" });
  onToolStart(s, "Read", { path: "/x" });
  resetHistory(s, [
    userMsg("hi"),
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
  ]);
  assert.equal(s.streamExtras.length, 0, "streamExtras cleared");
  assert.equal(s.liveAssistant, null, "liveAssistant cleared");
  assert.equal(s.pendingToolResults.size, 0, "pendingToolResults cleared");
  assert.equal(s.pendingUser, null, "pendingUser cleared");
  const items = selectItems(s);
  assert.equal(items.filter((it) => it.source === "canonical").length, 2);
  assert.equal(items.filter((it) => it.source === "extra").length, 0);
});

test("multi-turn loop: extras span multiple assistant + tool result entries past the last user", () => {
  const s = createChatState();
  submitUser(s, "do it");
  onAgentStart(s);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Reading..." });
  onToolStart(s, "Read", { path: "/x" }, "tc_1");
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Done." });
  // Final snapshot reflects everything we streamed.
  setHistory(s, [
    userMsg("do it"),
    { role: "assistant", content: [{ type: "text", text: "Reading..." }, { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } }] },
    { role: "toolResult", toolName: "Read", content: [{ type: "text", text: "data" }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]);
  const items = selectItems(s);
  // canonical only renders the user; the rest is owned by extras.
  const canonRoles = items.filter((it) => it.source === "canonical").map((it) => it.message.role);
  assert.deepEqual(canonRoles, ["user"]);
  const extraKinds = items.filter((it) => it.source === "extra").map((it) => it.item.kind);
  assert.deepEqual(extraKinds, ["assistant", "tool", "assistant"]);
});

// ── Structured-blocks model invariants ─────────────────────────────────────

test("submitUser stores the user text as a single text block", () => {
  const s = createChatState();
  submitUser(s, "hello world");
  assert.deepEqual(s.pendingUser.blocks, [{ type: "text", text: "hello world" }]);
});

test("delta growth appends to the same text block, not new ones", () => {
  const s = createChatState();
  submitUser(s, "hi");
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Hel" });
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "lo" });
  const live = s.streamExtras.find((e) => e.kind === "assistant");
  assert.equal(live.blocks.length, 1, "single block for repeated deltas at same index");
  assert.equal(live.blocks[0].type, "text");
  assert.equal(live.blocks[0].text, "Hello");
});

test("liveAssistant blocks are the same array as streamExtras entry (stable pointer)", () => {
  const s = createChatState();
  submitUser(s, "hi");
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "x" });
  const live = s.streamExtras.find((e) => e.kind === "assistant");
  assert.strictEqual(live, s.liveAssistant, "liveAssistant must be the same object pushed into streamExtras");
});

test("tool_call block appears at toolcall_end (LLM-side), before tool_execution_start fires", () => {
  // Repro: nothing visible happens for a tool call until tool_execution_start
  // fires (after pi accepts the call). With long tool args or slow models, the
  // user sees a long blank pause. The SDK already streams toolcall_start /
  // toolcall_delta / toolcall_end events through message_update — we should
  // surface the call as soon as the LLM finishes generating it.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "checking..." });
  applyDelta(s, { type: "toolcall_start", contentIndex: 1 });
  applyDelta(s, { type: "toolcall_delta", contentIndex: 1, delta: '{"path"' });
  applyDelta(s, { type: "toolcall_delta", contentIndex: 1, delta: ': "/x"}' });
  applyDelta(s, {
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } },
  });
  // pi has NOT fired tool_execution_start yet — but the tool_call must be visible.
  const live = s.liveAssistant;
  assert.ok(live, "live assistant exists");
  assert.deepEqual(
    live.blocks.map((b) => b.type),
    ["text", "tool_call"],
    "tool_call appended to live assistant on toolcall_end",
  );
  const call = live.blocks[1];
  assert.equal(call.name, "Read");
  assert.deepEqual(call.input, { path: "/x" });
});

test("tool_execution_start does not duplicate a tool_call already added by the LLM stream", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, {
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: { type: "toolCall", id: "tc_1", name: "Read", arguments: { path: "/x" } },
  });
  // pi then accepts the call. With a matching toolCallId, no duplicate.
  onToolStart(s, "Read", { path: "/x" }, "tc_1");
  assert.deepEqual(
    s.liveAssistant.blocks.map((b) => b.type),
    ["tool_call"],
    "tool_execution_start must not re-add a tool_call already streamed in",
  );
  // Result placeholder still gets added as its own top-level extra.
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 2);
  assert.equal(extras[1].item.kind, "tool");
  assert.equal(extras[1].item.title, "Tool result: Read");
});

test("tool_execution_start without a prior toolcall_end still adds the tool_call (graceful fallback)", () => {
  // E.g., on reconnect after a missed message_update stream.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolStart(s, "Read", { path: "/x" }, "tc_1");
  assert.deepEqual(
    s.liveAssistant.blocks.map((b) => b.type),
    ["tool_call"],
    "fallback: tool_call still added when no preceding LLM-stream event",
  );
});

test("tool_result is a top-level extra during streaming; tool_call stays nested in the assistant", () => {
  // Canonical SDK shape after reload is:
  //   assistant message 1: [text, tool_call]
  //   toolResult message:   own top-level entry
  //   assistant message 2: [text]
  // Streaming should match — tool_call stays inside the live assistant entry,
  // but tool_result pops out to its own top-level streamExtras item, and a
  // fresh assistant entry starts for any text that follows.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "I'll check." });
  onToolStart(s, "Read", { path: "/x" });
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);
  applyDelta(s, { type: "text_delta", contentIndex: 2, delta: "Done." });

  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 3, "three top-level entries: assistant, tool result, assistant");

  assert.equal(extras[0].item.kind, "assistant");
  assert.deepEqual(
    extras[0].item.blocks.map((b) => b.type),
    ["text", "tool_call"],
    "first assistant entry contains the text and the tool_call (no tool_result)",
  );
  assert.equal(extras[0].item.blocks[0].text, "I'll check.");
  assert.equal(extras[0].item.blocks[1].name, "Read");

  assert.equal(extras[1].item.kind, "tool");
  assert.equal(extras[1].item.title, "Tool result: Read");
  assert.equal(extras[1].item.blocks.length, 1);
  assert.equal(extras[1].item.blocks[0].type, "tool_result");
  assert.deepEqual(extras[1].item.blocks[0].result, [{ type: "text", text: "data" }]);

  assert.equal(extras[2].item.kind, "assistant", "trailing text starts a fresh assistant entry");
  assert.deepEqual(extras[2].item.blocks.map((b) => b.type), ["text"]);
  assert.equal(extras[2].item.blocks[0].text, "Done.");
});

test("tool_result placeholder appears as its own top-level entry while still pending", () => {
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  onToolStart(s, "Read", { path: "/x" });
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 2, "assistant entry (with tool_call) + standalone tool_result placeholder");
  assert.equal(extras[0].item.kind, "assistant");
  assert.deepEqual(extras[0].item.blocks.map((b) => b.type), ["tool_call"]);
  assert.equal(extras[1].item.kind, "tool");
  assert.equal(extras[1].item.title, "Tool result: Read");
  assert.equal(extras[1].item.blocks[0].result, null);
});

test("text_delta after tool_end is ordered AFTER the tool blocks, even if contentIndex is reused", () => {
  // Repro: user reports that the assistant's response "ends up above the tool
  // calls as it streams in and then after it completes, it moves to after
  // the tool calls."
  //
  // Cause: liveTextBlocks maps contentIndex → block. When a text_delta at the
  // same contentIndex arrives after a tool_call/tool_result was appended, the
  // map still points at the *first* text block. applyDelta appends "Done." to
  // that earlier block, so the new text visually sits BEFORE the tool blocks.
  // The canonical SDK snapshot at agent_end has separate content blocks, so
  // the text "snaps" to its correct position below the tool blocks.
  const s = createChatState();
  submitUser(s, "hi");
  onAgentStart(s);
  setHistory(s, [userMsg("hi")]);
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "I'll check." });
  onToolStart(s, "Read", { path: "/x" });
  onToolEnd(s, "Read", [{ type: "text", text: "data" }]);
  // Trailing assistant commentary. The pi event stream may reuse contentIndex
  // 0 here (e.g. across turn boundaries in a single live entry, or because
  // upstream resets indexing). Logically it is a NEW text block — the
  // preceding text was terminated by the tool_use.
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "Done." });

  // Layout is now 3 top-level extras: assistant(text+tool_call), tool result,
  // assistant(text). The trailing "Done." must land in the 3rd entry, not be
  // absorbed by the first.
  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.equal(extras.length, 3);
  assert.deepEqual(extras.map((it) => it.item.kind), ["assistant", "tool", "assistant"]);
  assert.equal(extras[0].item.blocks[0].text, "I'll check.", "first text must not absorb later deltas");
  assert.equal(extras[2].item.blocks[0].text, "Done.", "trailing text lands in its own assistant entry");
});


test("no marker strings ever appear in user-facing block text", () => {
  // Regression guard: the old protocol leaked literal "---THINKING---" markers
  // into rendered output if upstream emitted that string. Structured blocks
  // make this impossible by construction.
  const s = createChatState();
  submitUser(s, "talk about ---THINKING--- markers please");
  applyDelta(s, { type: "text_delta", contentIndex: 0, delta: "the user said ---END--- which is fine" });
  applyDelta(s, { type: "thinking_delta", contentIndex: 1, delta: "no ---TOOL: prefix issues" });
  const live = s.streamExtras.find((e) => e.kind === "assistant");
  // Each block stores raw text and renderer treats it as plain content; we only
  // assert the data shape — that markers are never used as in-band signaling.
  assert.equal(live.blocks[0].type, "text");
  assert.equal(live.blocks[0].text, "the user said ---END--- which is fine");
  assert.equal(live.blocks[1].type, "thinking");
  assert.equal(live.blocks[1].text, "no ---TOOL: prefix issues");
  // pendingUser similarly preserves the literal text.
  assert.equal(s.pendingUser.blocks[0].text, "talk about ---THINKING--- markers please");
});

// Reproduces a real captured pi.dev sequence: the assistant emitted three
// tool_use blocks (Read, Read, Bash) and pi ran the two Reads in parallel.
// Two tool_execution_starts arrive back-to-back before any end, so only the
// second placeholder is held in pendingToolResults; the first is stranded.
// onToolEnd matched by name, filling the wrong placeholder and pushing an
// orphan duplicate. Result: a phantom "Read" tool_result entry between the
// bash tool_call (in the assistant) and the bash tool_result.
test("parallel tools with same name don't produce a duplicate tool_result entry", () => {
  const s = createChatState();
  submitUser(s, "what is this project?");
  onAgentStart(s);
  setHistory(s, [userMsg("what is this project?")]);

  // LLM streams three tool_use blocks. Each toolcall_end nests a tool_call
  // into the live assistant.
  applyDelta(s, { type: "toolcall_end", toolCall: { id: "A", name: "Read", arguments: { path: "README.md" } } });
  applyDelta(s, { type: "toolcall_end", toolCall: { id: "B", name: "Read", arguments: { path: "package.json" } } });
  applyDelta(s, { type: "toolcall_end", toolCall: { id: "C", name: "Bash", arguments: { command: "ls -la" } } });

  // Pi runs the two Reads in parallel: both starts fire before either end.
  onToolStart(s, "Read", { path: "README.md" }, "A");
  onToolStart(s, "Read", { path: "package.json" }, "B");
  onToolEnd(s, "Read", [{ type: "text", text: "RESULT_A" }], "A");
  onToolEnd(s, "Read", [{ type: "text", text: "RESULT_B" }], "B");

  // Bash runs sequentially after the parallel batch.
  onToolStart(s, "Bash", { command: "ls -la" }, "C");
  onToolEnd(s, "Bash", [{ type: "text", text: "RESULT_C" }], "C");

  const extras = selectItems(s).filter((it) => it.source === "extra");
  assert.deepEqual(
    extras.map((it) => it.item.kind),
    ["assistant", "tool", "tool", "tool"],
    "exactly 3 tool entries for 3 tool calls — no orphan duplicate",
  );

  const toolItems = extras.filter((it) => it.item.kind === "tool").map((it) => it.item);
  assert.deepEqual(toolItems[0].blocks[0].result, [{ type: "text", text: "RESULT_A" }]);
  assert.deepEqual(toolItems[1].blocks[0].result, [{ type: "text", text: "RESULT_B" }]);
  assert.deepEqual(toolItems[2].blocks[0].result, [{ type: "text", text: "RESULT_C" }]);
});

