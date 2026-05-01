// State machine for "stick to the bottom while content streams in".
//
// Two kinds of scroll events reach the listener:
//   1. user-initiated  — wheel, keydown (PageUp/Down/arrows), touch.
//                        These reflect intent: if the user scrolls away
//                        from the bottom, stop following.
//   2. layout-induced  — the browser fires a scroll event when scrollTop
//                        is clamped because scrollHeight shrank (e.g. a
//                        DOM mutation removed a child or the streaming
//                        markdown re-rendered to a shorter pre-block).
//                        These should NOT flip the follow flag — the
//                        user didn't ask for a stop, and the event's
//                        observed distance-from-bottom can briefly be
//                        misleading mid-mutation.
//
// Today's wiring observes only the (distance, threshold) pair and ignores
// origin, so a single layout-induced event with an off-by-padding distance
// disables follow until the user manually scrolls back to the bottom.
//
// Pure module so we can drive it with synthetic event sequences in tests.

const FOLLOW_BOTTOM_PX = 40;

export function createFollowState() {
  return { followBottom: true };
}

export function onScrollEvent(state, { distanceFromBottom, origin }) {
  // Only user-originated scrolls (wheel, keys, touch) reflect intent.
  // Layout-induced events fire from DOM mutations and are unreliable —
  // the observed distance can briefly exceed the threshold mid-render
  // even though the user is still pinned to the bottom.
  if (origin !== "user") return state;
  state.followBottom = distanceFromBottom < FOLLOW_BOTTOM_PX;
  return state;
}

export function shouldAutoScroll(state) {
  return state.followBottom;
}
