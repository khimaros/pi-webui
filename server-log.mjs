// tiny logger: ISO timestamp + level + [pi-webui] prefix, one-line output.
// extra fields are stringified compactly so logs stay greppable.
// debug level is opt-in via PI_WEBUI_DEBUG=1.

const PREFIX = "[pi-webui]";
const debugEnabled = process.env.PI_WEBUI_DEBUG === "1";

function fmt(level, msg, fields) {
  const ts = new Date().toISOString();
  let line = `${ts} ${level} ${PREFIX} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
    if (parts.length) line += ` ${parts.join(" ")}`;
  }
  return line;
}

export const log = {
  debug: (msg, fields) => { if (debugEnabled) console.log(fmt("DEBUG", msg, fields)); },
  info: (msg, fields) => console.log(fmt("INFO", msg, fields)),
  warn: (msg, fields) => console.warn(fmt("WARN", msg, fields)),
  error: (msg, fields) => console.error(fmt("ERROR", msg, fields)),
};
