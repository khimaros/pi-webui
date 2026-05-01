import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFollowState,
  onScrollEvent,
  shouldAutoScroll,
} from "../public/scroll-follow.mjs";

test("starts in follow mode", () => {
  const s = createFollowState();
  assert.equal(shouldAutoScroll(s), true);
});

test("user scroll away from bottom disables follow", () => {
  const s = createFollowState();
  onScrollEvent(s, { distanceFromBottom: 500, origin: "user" });
  assert.equal(shouldAutoScroll(s), false);
});

test("user scroll back near bottom re-enables follow", () => {
  const s = createFollowState();
  onScrollEvent(s, { distanceFromBottom: 500, origin: "user" });
  onScrollEvent(s, { distanceFromBottom: 5, origin: "user" });
  assert.equal(shouldAutoScroll(s), true);
});

// Regression: scroll auto-follow stops working as the streaming response
// approaches the end of the markdown — specifically when a fenced code
// block (e.g. the "### Running It" section in the latest pi session)
// transitions from streaming-paragraph to a fully-rendered <pre> block,
// or when hljs runs at freeze and adds 1em padding via the .hljs theme
// class. Both mutate the message body's height; the browser fires a
// layout-induced scroll event whose observed distance-from-bottom can
// briefly exceed the 40px threshold, and the listener mistakes that
// for the user scrolling away.
//
// Layout-induced scroll events should NEVER disable follow. Only events
// the user actually originated (wheel / keydown / touch) should.
test("layout-induced scroll past threshold does NOT disable follow", () => {
  const s = createFollowState();
  // Mid-render: distance briefly looks like 60px because a wrap was
  // inserted before its sibling was trimmed. The user did nothing.
  onScrollEvent(s, { distanceFromBottom: 60, origin: "layout" });
  assert.equal(
    shouldAutoScroll(s),
    true,
    "follow must persist across layout-induced scroll events",
  );
});

test("layout-induced scroll cannot re-enable follow on its own either", () => {
  const s = createFollowState();
  onScrollEvent(s, { distanceFromBottom: 500, origin: "user" });
  // Layout-induced "near bottom" event shouldn't silently re-enable
  // follow — the user is still scrolled away, the layout just shifted.
  onScrollEvent(s, { distanceFromBottom: 5, origin: "layout" });
  assert.equal(shouldAutoScroll(s), false);
});
