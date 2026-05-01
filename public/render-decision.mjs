// Pure helper deciding whether an "extra" stream item's body should be
// re-rendered on a given tick, and whether the result should be syntax-
// highlighted. Extracted from app.js so it can be tested without a DOM.
//
// Inputs:
//   cached  — { blocks, wasLive } from previous render (caller updates).
//   item    — current { blocks, ... } from chat-state.
//   isLive  — true if the item is still the live assistant entry.
//
// Returns { rerender, highlight }. Highlighting is skipped while live
// (partial JSON / streaming code) since hljs would re-tokenize on every
// delta and the input is incomplete anyway. On the freeze transition we
// force one final re-render so nested tool_call/tool_result blocks —
// whose blocks reference does not change when the live entry stops being
// live — still get highlighted.
export function decideExtraItemRender(cached, item, isLive) {
  const blocksChanged = cached.blocks !== item.blocks;
  const justFroze = cached.wasLive && !isLive;
  const rerender = blocksChanged || isLive || justFroze;
  const highlight = !isLive;
  return { rerender, highlight };
}
