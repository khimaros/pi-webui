// Pure dispatch of session_event payloads → chat-state mutations.
// Kept separate from app.js so the wiring is unit-testable without DOM.

import {
  applyDelta,
  onAgentEnd,
  onAgentStart,
  onToolEnd,
  onToolStart,
} from "./chat-state.mjs";

export function dispatchSessionEvent(state, event) {
  switch (event?.type) {
    case "agent_start":
      onAgentStart(state);
      return;
    case "agent_end":
      onAgentEnd(state);
      return;
    case "message_update":
      applyDelta(state, event.assistantMessageEvent || {});
      return;
    case "tool_execution_start":
      onToolStart(state, event.toolName, event.args, event.toolCallId);
      return;
    case "tool_execution_end":
      onToolEnd(state, event.toolName, event.result, event.toolCallId);
      return;
    default:
      return;
  }
}
