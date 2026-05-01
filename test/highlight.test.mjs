import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldHighlightCodeBlock } from "../public/highlight.mjs";

function mockBlock({ highlighted = false, classes = [] } = {}) {
  return {
    dataset: { highlighted: highlighted ? "yes" : undefined },
    classList: { contains: (c) => classes.includes(c) },
  };
}

test("plain <code> block should be highlighted", () => {
  assert.equal(shouldHighlightCodeBlock(mockBlock()), true);
});

test("already-highlighted block is skipped", () => {
  assert.equal(shouldHighlightCodeBlock(mockBlock({ highlighted: true })), false);
});

test("null/undefined block returns false", () => {
  assert.equal(shouldHighlightCodeBlock(null), false);
  assert.equal(shouldHighlightCodeBlock(undefined), false);
});

// Regression: hljs.highlightElement replaces innerHTML with its own tokenized
// span structure, which destroys the per-line <div class="diff-line"> nodes
// that formatDiffHtml emits — leaving the diff view rendered as one inline
// run on initial load until the user toggles text↔diff (which bypasses hljs).
// The fix is to skip highlighting when the <code> already carries our diff
// structure, identified by the `diff-content` class.
test("diff-content block should NOT be highlighted (would mangle <div class=diff-line>)", () => {
  assert.equal(
    shouldHighlightCodeBlock(mockBlock({ classes: ["diff-content"] })),
    false,
  );
});
