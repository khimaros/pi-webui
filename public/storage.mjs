// Pure helpers for the active-session localStorage key. Extracted from
// app.js so the field-mapping between server payloads and storage can be
// tested without a DOM.
//
// Two server packet shapes carry the active session file:
//   - session_state.payload  → { sessionFile, sessionId, ... }
//   - sessions.payload       → { currentSessionFile, sessions: {...} }
// Storage updates today happen on session_state, so we read sessionFile.

export const ACTIVE_SESSION_KEY = "pi-webui:session-file";

export function extractSessionFileFromState(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.sessionFile || null;
}
