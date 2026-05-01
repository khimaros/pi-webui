// Pure decision helpers for the session-file watcher in server.mjs.
// Exported separately so they can be unit-tested without booting the SDK.

// Treat a watcher event as our own write echoing back if it lands within this
// window after the last session event we received.
export const SELF_WRITE_WINDOW_MS = 750;

// Coalesce burst writes from another pi instance before triggering a refresh.
export const EXTERNAL_REFRESH_DEBOUNCE_MS = 250;

// True iff a watcher event at `now` should be ignored as our own echo.
export function isSelfEcho(now, lastSelfActivity, windowMs = SELF_WRITE_WINDOW_MS) {
  if (!lastSelfActivity) return false;
  return now - lastSelfActivity < windowMs;
}

// True iff we can safely run switchSession+bootstrap right now. Caller passes
// a snapshot of session flags; we never inspect the live session object so the
// helper stays pure.
export function canRefreshNow({ now, lastSelfActivity, isStreaming, isCompacting, isRetrying, refreshing }, windowMs = SELF_WRITE_WINDOW_MS) {
  if (refreshing) return false;
  if (isStreaming || isCompacting || isRetrying) return false;
  if (isSelfEcho(now, lastSelfActivity, windowMs)) return false;
  return true;
}
