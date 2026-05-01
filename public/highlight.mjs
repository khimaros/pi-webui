// Decide whether `highlightCodeBlocks` should run hljs on a given <code>
// element. Pure predicate so it can be unit-tested without a real DOM —
// callers pass any object with `dataset` and `classList.contains`.
export function shouldHighlightCodeBlock(block) {
  if (!block) return false;
  if (block.dataset && block.dataset.highlighted === "yes") return false;
  // Skip blocks that carry our own pre-formatted structure (e.g. the diff
  // view's per-line <div> children) — hljs would replace innerHTML and wipe
  // the structure on initial render.
  if (block.classList && block.classList.contains("diff-content")) return false;
  return true;
}
