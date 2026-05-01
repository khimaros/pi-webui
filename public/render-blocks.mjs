// Per-block render planning for streaming assistant entries.
//
// Today: updateMessageBody replaces the entire .message-body innerHTML on
// every delta, so any tool_call or tool_result block inside the live
// assistant gets re-rendered (and eventually re-highlighted) repeatedly,
// causing layout jank during streaming.
//
// Goal: tool_call / tool_result blocks should be drawn exactly once.
// Their input is final at creation (toolcall_end / tool_execution_end),
// the block reference in chat-state never changes after that point, so
// once we've built the DOM for them we should keep the existing nodes.
//
// planBlockRenders returns a per-index plan:
//   { block, action: "build" | "keep" }
// "keep" means the caller can reuse the previously-rendered node;
// "build" means re-render from scratch.
// Reconcile a parent's children in place to match `desired`. Must NEVER
// transiently empty the parent — doing so shrinks scrollHeight and can
// clamp the scroll container's scrollTop, firing a scroll event that flips
// the "follow bottom" flag off (see followBottom in app.js).
//
// `parent` is any object exposing a DOM-Node-like interface:
//   childNodes (array-like), insertBefore(node, ref), removeChild(node),
//   lastChild.
export function reconcileChildrenInPlace(parent, desired) {
  // Move/insert each desired node to its target index, then trim trailing
  // children. Never empties the parent transiently, so a scroll container
  // observing this parent won't see scrollHeight shrink past scrollTop.
  for (let i = 0; i < desired.length; i += 1) {
    const want = desired[i];
    if (!want) continue;
    const cur = parent.childNodes[i];
    if (cur === want) continue;
    parent.insertBefore(want, cur || null);
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.lastChild);
  }
}

export function planBlockRenders(blocks, prevBlocks) {
  return blocks.map((block, i) => {
    const prev = prevBlocks ? prevBlocks[i] : undefined;
    // tool_call / tool_result are immutable once chat-state pushes them
    // (their input/result is final at creation), so a stable reference
    // means we can safely keep the previously-rendered DOM.
    if (
      prev === block &&
      (block.type === "tool_call" || block.type === "tool_result")
    ) {
      return { block, action: "keep" };
    }
    return { block, action: "build" };
  });
}
