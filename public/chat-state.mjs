// pure state management for the chat log. no DOM.
// app.js renders selectItems(state) to the DOM after each mutation.
//
// Streaming is modeled to match the canonical SDK shape: a single live
// assistant entry whose blocks[] interleaves text, thinking, tool_call, and
// tool_result blocks. This keeps the visual layout stable when the canonical
// snapshot lands at agent_end — nothing "snaps" between top-level sections.
//
// Block shapes:
//   { type: "text", text }
//   { type: "thinking", text }
//   { type: "tool_call", name, input }
//   { type: "tool_result", name, result }   // result is null while pending
//   { type: "image", mimeType }

export function createChatState() {
  return {
    canonical: [],         // server-snapshot messages (each is a raw SDK message)
    pendingUser: null,     // optimistic user entry; cleared once canonical contains it
    streamExtras: [],      // streaming-derived items (live assistant only, today)
    showTyping: false,
    isRunning: false,
    liveAssistant: null,   // pointer into streamExtras for current streaming entry
    liveTextBlocks: null,  // Map<contentIndex, block> for text/thinking dedup
    lastError: null,
    // Map<key, placeholder>. Key is toolCallId when available, else a unique
    // Symbol. A Map (not a single pointer) is required because pi runs tools
    // in parallel — multiple placeholders may be in flight at once, and each
    // tool_execution_end must land on the placeholder with the matching id.
    pendingToolResults: new Map(),
  };
}

export function setError(state, message) {
  state.lastError = message ? String(message) : null;
}

export function clearError(state) {
  state.lastError = null;
}

export function submitUser(state, text) {
  state.pendingUser = {
    kind: "user",
    title: "You",
    blocks: [{ type: "text", text }],
  };
  state.showTyping = true;
  state.isRunning = true;
  resetLiveAssistant(state);
  state.streamExtras = [];
}

// Routine snapshot from the server. Preserves streamed extras — they own
// the visible tail of the conversation since the last user message, and
// selectItems hides any canonical messages past that point to avoid
// duplicates. Use resetHistory for cold start / session switch / replay miss.
export function setHistory(state, messages) {
  state.canonical = Array.isArray(messages) ? messages.slice() : [];
  const pendingText = state.pendingUser?.blocks?.[0]?.text ?? null;
  if (pendingText !== null && lastUserText(state.canonical) === pendingText) {
    state.pendingUser = null;
  }
  if (!state.isRunning) state.showTyping = false;
}

// Authoritative snapshot. Throws away any streamed UI state — used on
// initial connect, session switch, and reconnect when the server's event
// log can't cover the gap (replay miss).
export function resetHistory(state, messages) {
  state.canonical = Array.isArray(messages) ? messages.slice() : [];
  state.streamExtras = [];
  state.pendingUser = null;
  resetLiveAssistant(state);
  state.showTyping = false;
}

function resetLiveAssistant(state) {
  state.liveAssistant = null;
  state.liveTextBlocks = null;
  state.pendingToolResults = new Map();
}

function ensureLiveAssistant(state) {
  if (state.liveAssistant) return state.liveAssistant;
  const live = { kind: "assistant", title: "Assistant", blocks: [] };
  state.liveAssistant = live;
  state.liveTextBlocks = new Map();
  state.streamExtras.push(live);
  return live;
}

function lastUserText(canonical) {
  for (let i = canonical.length - 1; i >= 0; i--) {
    const m = canonical[i];
    if (m && m.role === "user") return userMessageText(m);
  }
  return null;
}

export function applyDelta(state, delta) {
  if (delta.type === "text_delta" || delta.type === "thinking_delta") {
    state.showTyping = false;
    const live = ensureLiveAssistant(state);
    const kind = delta.type === "thinking_delta" ? "thinking" : "text";
    const idx = delta.contentIndex;
    let block = idx !== undefined ? state.liveTextBlocks.get(idx) : null;
    if (!block || block.type !== kind) {
      block = { type: kind, text: "" };
      live.blocks.push(block);
      if (idx !== undefined) state.liveTextBlocks.set(idx, block);
    }
    block.text += delta.delta || "";
    return;
  }
  if (delta.type === "toolcall_end") {
    // The LLM has finished generating a tool_use block. Render it now —
    // before pi fires tool_execution_start — so users see the call (and its
    // arguments) as soon as the model decides them, not after pi runs it.
    const tc = delta.toolCall;
    if (!tc) return;
    state.showTyping = false;
    const live = ensureLiveAssistant(state);
    live.blocks.push({ type: "tool_call", id: tc.id, name: tc.name, input: tc.arguments });
    // Following text/thinking is a fresh block, even if contentIndex is reused.
    state.liveTextBlocks = new Map();
    return;
  }
  // toolcall_start / toolcall_delta carry no name and only partial JSON, so
  // they're not useful to render — wait for toolcall_end.
}

export function onToolStart(state, name, input, id) {
  // tool_call nests in the assistant that emitted it. tool_result, however,
  // is its own top-level entry — that mirrors the canonical SDK shape after
  // reload (an assistant message containing tool_use, then a separate
  // toolResult message).
  state.showTyping = false;
  // Dedup: if the LLM-side toolcall_end already added this tool_call to ANY
  // assistant entry in streamExtras (matched by SDK toolCallId), skip the
  // tool_call push entirely — and don't create a phantom empty assistant
  // just to hold it.
  const alreadyInExtras = id && findAssistantWithToolCallId(state, id);
  if (!alreadyInExtras) {
    // Fallback path: tool_execution_start arrived without a preceding
    // toolcall_end (e.g. on reconnect or for tools that bypass the LLM
    // streaming layer). Append the tool_call to the live assistant,
    // creating one if necessary.
    const live = ensureLiveAssistant(state);
    live.blocks.push({ type: "tool_call", id, name, input });
  }
  const placeholder = {
    kind: "tool",
    title: `Tool result: ${name}`,
    blocks: [{ type: "tool_result", id, name, result: null }],
  };
  state.streamExtras.push(placeholder);
  // Key by id so onToolEnd can find this exact placeholder when tools run
  // in parallel. Fall back to a unique Symbol when id is missing so each
  // placeholder still has its own slot.
  const key = id || Symbol("anon-tool");
  state.pendingToolResults.set(key, placeholder);
  // Following text/thinking deltas are a new content block — the preceding
  // text was terminated by the tool_use. Clear the contentIndex map so the
  // next delta creates a fresh block.
  state.liveTextBlocks = new Map();
}

function findAssistantWithToolCallId(state, id) {
  for (const item of state.streamExtras) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.type === "tool_call" && b.id === id) return item;
    }
  }
  return null;
}

export function onToolEnd(state, name, result, id) {
  const map = state.pendingToolResults;
  let key = null;
  let pending = null;
  // Prefer exact id match — required when parallel tools share a name.
  if (id && map.has(id)) {
    key = id;
    pending = map.get(id);
  } else {
    // Fallback for callers that don't pass an id (legacy/no-id flows): take
    // the first pending placeholder with the same name, in insertion order.
    for (const [k, p] of map) {
      if (p.blocks[0]?.name === name) { key = k; pending = p; break; }
    }
  }
  if (pending) {
    // Replace the blocks array (not just the inner block) so the renderer's
    // identity-based cache check (`cached.blocks !== item.blocks`) triggers
    // an update on this otherwise-frozen item.
    pending.blocks = [{ type: "tool_result", name, result }];
    map.delete(key);
  } else {
    // Orphan result — append a fresh top-level entry.
    state.streamExtras.push({
      kind: "tool",
      title: `Tool result: ${name}`,
      blocks: [{ type: "tool_result", name, result }],
    });
  }
  // Any assistant text that follows belongs to a new top-level section
  // below the tool result, matching canonical layout.
  state.liveAssistant = null;
  state.liveTextBlocks = null;
  if (state.isRunning) state.showTyping = true;
}

export function onAgentStart(state) {
  state.isRunning = true;
  state.lastError = null;
}

export function onAgentEnd(state) {
  state.isRunning = false;
  state.showTyping = false;
  // Clear the streaming pointers but KEEP pendingToolResults — the LLM turn
  // ended, but pi runs tools AFTER the assistant message is done. A
  // tool_execution_end may still arrive and needs to find its placeholder.
  state.liveAssistant = null;
  state.liveTextBlocks = null;
}

// Returns ordered render items.
//   { source: "canonical", message }
//   { source: "extra", item: { kind, title, blocks } }
//   { source: "typing" }
//
// When streamed extras exist, they own the visible tail since the last user
// message — canonical messages past that point are hidden so we don't render
// the same content twice (once via canonical, once via extras). This is the
// dedup half of the buffer+replay model.
export function selectItems(state) {
  const items = [];
  // When pendingUser is set, the new user message lives there (not yet in
  // canonical), so canonical's lastUser still points at the previous turn —
  // clipping to it would hide the previous assistant's content during the
  // next turn's streaming. Show all of canonical in that case.
  const lastUser = lastUserMessageIndex(state.canonical);
  const canonicalEnd =
    state.streamExtras.length > 0 && lastUser >= 0 && !state.pendingUser
      ? lastUser + 1
      : state.canonical.length;
  for (let i = 0; i < canonicalEnd; i++) {
    items.push({ source: "canonical", message: state.canonical[i] });
  }
  if (state.pendingUser) items.push({ source: "extra", item: state.pendingUser });
  for (const e of state.streamExtras) items.push({ source: "extra", item: e });
  if (state.showTyping) items.push({ source: "typing" });
  return items;
}

function lastUserMessageIndex(canonical) {
  for (let i = canonical.length - 1; i >= 0; i--) {
    if (canonical[i]?.role === "user") return i;
  }
  return -1;
}

export function userMessageText(message) {
  if (!message || message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const t = message.content.find((c) => c && c.type === "text");
    return t ? t.text : null;
  }
  return null;
}
