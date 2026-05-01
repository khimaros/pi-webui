// browser-side logger mirroring server-log.mjs. routes through console.* so
// devtools level filters still work; prefix makes it easy to grep/filter.
// debug level is opt-in: localStorage.setItem("pi-webui:debug", "1").

const PREFIX = "[pi-webui]";

function debugEnabled() {
  try { return localStorage.getItem("pi-webui:debug") === "1"; } catch { return false; }
}

function fmt(msg, fields) {
  if (!fields) return `${PREFIX} ${msg}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.length ? `${PREFIX} ${msg} ${parts.join(" ")}` : `${PREFIX} ${msg}`;
}

export const log = {
  debug: (msg, fields) => { if (debugEnabled()) console.debug(fmt(msg, fields)); },
  info: (msg, fields) => console.info(fmt(msg, fields)),
  warn: (msg, fields) => console.warn(fmt(msg, fields)),
  error: (msg, fields) => console.error(fmt(msg, fields)),
};
