import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventLog } from "../server-event-log.mjs";

test("append assigns monotonic, gap-free seq starting at 1", () => {
  const log = createEventLog();
  assert.equal(log.append({ type: "agent_start" }), 1);
  assert.equal(log.append({ type: "message_update" }), 2);
  assert.equal(log.append({ type: "agent_end" }), 3);
});

test("eventsAfter(cursor) returns subsequent events in order", () => {
  const log = createEventLog();
  log.append({ type: "agent_start" });
  log.append({ type: "x" });
  log.append({ type: "y" });
  log.append({ type: "agent_end" });
  const out = log.eventsAfter(2);
  assert.equal(out.miss, false);
  assert.deepEqual(
    out.events.map((e) => e.event.type),
    ["y", "agent_end"],
  );
  assert.deepEqual(
    out.events.map((e) => e.seq),
    [3, 4],
  );
});

test("eventsAfter(cursor) returns empty array when cursor is current head", () => {
  const log = createEventLog();
  log.append({ type: "x" });
  const out = log.eventsAfter(1);
  assert.equal(out.miss, false);
  assert.deepEqual(out.events, []);
});

test("eventsAfter(null) is treated as a miss (forces full reset on the client)", () => {
  const log = createEventLog();
  log.append({ type: "x" });
  const out = log.eventsAfter(null);
  assert.equal(out.miss, true);
});

test("eventsAfter(cursor) before the buffer's oldest seq is a miss", () => {
  const log = createEventLog();
  log.append({ type: "a" }); // seq 1
  log.append({ type: "b" }); // seq 2
  log.append({ type: "agent_end" }); // seq 3 — triggers trim
  log.trimSettled();
  // Buffer is now empty (everything ≤ 3 has been settled).
  log.append({ type: "agent_start" }); // seq 4
  const out = log.eventsAfter(1); // client thinks it's at seq 1; we've trimmed past that
  assert.equal(out.miss, true, "cursor older than oldest buffered seq must miss");
});

test("eventsAfter(cursor) AT or AFTER the trim point with nothing newer is not a miss", () => {
  const log = createEventLog();
  log.append({ type: "a" });
  log.append({ type: "agent_end" });
  log.trimSettled();
  // Current head is 2; client at 2 is up-to-date, not a miss.
  const out = log.eventsAfter(2);
  assert.equal(out.miss, false);
  assert.deepEqual(out.events, []);
});

test("trimSettled keeps only events newer than the most recent agent_end", () => {
  const log = createEventLog();
  log.append({ type: "agent_start" });   // 1
  log.append({ type: "message_update" }); // 2
  log.append({ type: "agent_end" });     // 3
  log.append({ type: "agent_start" });   // 4
  log.append({ type: "message_update" }); // 5
  log.trimSettled();
  // Everything ≤ 3 is settled (canonical reflects it). Buffer should hold 4, 5.
  const out = log.eventsAfter(3);
  assert.equal(out.miss, false);
  assert.deepEqual(out.events.map((e) => e.seq), [4, 5]);
  // And a cursor at 2 (before the trim point) should now miss.
  assert.equal(log.eventsAfter(2).miss, true);
});

test("currentSeq exposes the latest assigned seq", () => {
  const log = createEventLog();
  assert.equal(log.currentSeq(), 0);
  log.append({ type: "x" });
  assert.equal(log.currentSeq(), 1);
  log.append({ type: "y" });
  assert.equal(log.currentSeq(), 2);
});
