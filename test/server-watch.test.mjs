import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SELF_WRITE_WINDOW_MS,
  isSelfEcho,
  canRefreshNow,
} from "../server-watch.mjs";

const idleSession = {
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  refreshing: false,
};

function ctx(extra = {}) {
  return { now: 10_000, lastSelfActivity: 0, ...idleSession, ...extra };
}

test("isSelfEcho: zero lastSelfActivity (initial state) is never an echo", () => {
  assert.equal(isSelfEcho(10_000, 0), false);
});

test("isSelfEcho: within window returns true", () => {
  assert.equal(isSelfEcho(10_000, 9_500), true);
});

test("isSelfEcho: outside window returns false", () => {
  assert.equal(isSelfEcho(10_000, 9_000), false);
});

test("isSelfEcho: at exact window boundary is treated as outside (>=)", () => {
  // window is "< windowMs", so equal is NOT an echo
  assert.equal(isSelfEcho(10_000, 10_000 - SELF_WRITE_WINDOW_MS), false);
});

test("isSelfEcho: 1ms inside boundary is an echo", () => {
  assert.equal(isSelfEcho(10_000, 10_000 - SELF_WRITE_WINDOW_MS + 1), true);
});

test("isSelfEcho: custom windowMs is honored", () => {
  assert.equal(isSelfEcho(10_000, 9_900, 50), false);
  assert.equal(isSelfEcho(10_000, 9_990, 50), true);
});

test("canRefreshNow: idle session with no recent self activity is allowed", () => {
  assert.equal(canRefreshNow(ctx()), true);
});

test("canRefreshNow: blocked while streaming", () => {
  assert.equal(canRefreshNow(ctx({ isStreaming: true })), false);
});

test("canRefreshNow: blocked while compacting", () => {
  assert.equal(canRefreshNow(ctx({ isCompacting: true })), false);
});

test("canRefreshNow: blocked while retrying", () => {
  assert.equal(canRefreshNow(ctx({ isRetrying: true })), false);
});

test("canRefreshNow: blocked when another refresh is in flight", () => {
  assert.equal(canRefreshNow(ctx({ refreshing: true })), false);
});

test("canRefreshNow: blocked when watcher event is our own echo", () => {
  assert.equal(canRefreshNow(ctx({ lastSelfActivity: 9_500 })), false);
});

test("canRefreshNow: allowed once self-write window has elapsed", () => {
  assert.equal(canRefreshNow(ctx({ lastSelfActivity: 9_000 })), true);
});

test("canRefreshNow: streaming overrides 'far past' self activity", () => {
  // even if self activity was long ago, streaming alone should block.
  assert.equal(canRefreshNow(ctx({ lastSelfActivity: 0, isStreaming: true })), false);
});

test("canRefreshNow: every flag set composes to false", () => {
  assert.equal(
    canRefreshNow(ctx({
      isStreaming: true,
      isCompacting: true,
      isRetrying: true,
      refreshing: true,
      lastSelfActivity: 9_999,
    })),
    false,
  );
});

test("canRefreshNow: custom window respected", () => {
  // 100ms ago but window is 50ms => allowed
  assert.equal(
    canRefreshNow(ctx({ lastSelfActivity: 9_900 }), 50),
    true,
  );
  // 10ms ago and window is 50ms => blocked
  assert.equal(
    canRefreshNow(ctx({ lastSelfActivity: 9_990 }), 50),
    false,
  );
});
