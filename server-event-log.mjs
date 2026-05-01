// Per-session event log for buffer+replay reconnect.
//
// Each session_event the controller broadcasts is appended here with a
// monotonic seq. On reconnect, the client sends its lastSeq; if the buffer
// covers the gap we replay the missed events, otherwise we report a miss
// and the caller falls back to a full canonical reset.
//
// trimSettled is called after canonical-reflecting boundaries (agent_end):
// at those points the canonical snapshot already encodes everything below
// the most recent agent_end, so older events can be dropped from memory.

export function createEventLog() {
  let events = [];
  let nextSeq = 1;
  // Watermark: the seq of the most recent trimmed agent_end. Cursors strictly
  // below this are misses (we no longer have the events to replay).
  let settledSeq = 0;

  return {
    append(event) {
      const seq = nextSeq++;
      events.push({ seq, event });
      return seq;
    },

    eventsAfter(cursor) {
      if (cursor === null || cursor === undefined) {
        return { events: [], miss: true };
      }
      if (cursor < settledSeq) {
        return { events: [], miss: true };
      }
      return {
        events: events.filter((e) => e.seq > cursor),
        miss: false,
      };
    },

    trimSettled() {
      let latestEnd = -1;
      for (const { seq, event } of events) {
        if (event && event.type === "agent_end") latestEnd = seq;
      }
      if (latestEnd > 0) {
        settledSeq = latestEnd;
        events = events.filter((e) => e.seq > latestEnd);
      }
    },

    currentSeq() {
      return nextSeq - 1;
    },
  };
}
