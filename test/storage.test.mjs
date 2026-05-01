import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSessionFileFromState } from "../public/storage.mjs";

test("returns null for missing or non-object payloads", () => {
  assert.equal(extractSessionFileFromState(null), null);
  assert.equal(extractSessionFileFromState(undefined), null);
  assert.equal(extractSessionFileFromState("nope"), null);
});

test("returns null when no session file is present", () => {
  assert.equal(extractSessionFileFromState({}), null);
  assert.equal(extractSessionFileFromState({ sessionFile: null }), null);
});

// Regression: server.mjs serializeState() returns the active file under
// the field name `sessionFile`. The earlier implementation read
// `currentSessionFile` (the field used on the `sessions` packet, not
// `session_state`), so storage always saved null and reload never
// resumed. This test pins the correct field for the session_state
// payload shape.
test("session_state payload uses field 'sessionFile'", () => {
  const payload = {
    sessionFile: "/home/u/.pi/sessions/abc.jsonl",
    sessionId: "abc",
    sessionName: "demo",
  };
  assert.equal(
    extractSessionFileFromState(payload),
    "/home/u/.pi/sessions/abc.jsonl",
  );
});
