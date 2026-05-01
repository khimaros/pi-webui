#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, watch as fsWatch } from "node:fs";
import { extname, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

// The package's `exports` field doesn't expose the slash-commands list.
// Resolve the package's `import` entry via import.meta.resolve and load the
// sibling file by URL — dynamic file-URL imports bypass exports validation.
const piIndexUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
const piDistDir = dirname(fileURLToPath(piIndexUrl));
const { BUILTIN_SLASH_COMMANDS } = await import(
  pathToFileURL(resolve(piDistDir, "core/slash-commands.js")).href
);

let piChangelog = "";
try {
  piChangelog = readFileSync(resolve(piDistDir, "..", "CHANGELOG.md"), "utf8");
} catch {
  /* changelog not available */
}

import {
  SELF_WRITE_WINDOW_MS,
  EXTERNAL_REFRESH_DEBOUNCE_MS,
  isSelfEcho,
  canRefreshNow,
} from "./server-watch.mjs";
import { createEventLog } from "./server-event-log.mjs";
import { log as logger } from "./server-log.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

// parses "host:port", ":port", or "port"; ipv6 hosts must be bracketed: "[::1]:8787"
function parseListen(spec) {
  const s = String(spec).trim();
  if (!s) throw new Error("--listen requires host:port");
  const m = s.startsWith("[")
    ? s.match(/^\[([^\]]+)\]:(\d+)$/)
    : s.match(/^([^:]*):(\d+)$/);
  if (m) return { host: m[1] || DEFAULT_HOST, port: Number(m[2]) };
  if (/^\d+$/.test(s)) return { host: DEFAULT_HOST, port: Number(s) };
  throw new Error(`invalid --listen value: ${spec}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--listen") out.listen = argv[++i];
    else if (a.startsWith("--listen=")) out.listen = a.slice("--listen=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const listenFromArg = args.listen ? parseListen(args.listen) : null;
const host = listenFromArg?.host ?? process.env.HOST ?? DEFAULT_HOST;
const port = listenFromArg?.port ?? Number(process.env.PORT || DEFAULT_PORT);
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const appCwd = resolve(process.env.PI_PROJECT_CWD || process.cwd());
const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
const sessionDir = process.env.PI_SESSION_DIR;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Mirrors the TUI's /scoped-models selection persisted via SettingsManager.
// The TUI saves enabled model IDs as "provider/id" strings, so exact matching
// against the registry is sufficient.
function resolveScopedModelsFromSettings(services) {
  const patterns = services.settingsManager.getEnabledModels();
  if (!patterns || patterns.length === 0) return [];
  const available = services.modelRegistry.getAvailable();
  const matched = [];
  for (const pattern of patterns) {
    const found = available.find(
      (m) => `${m.provider}/${m.id}` === pattern || m.id === pattern,
    );
    if (found && !matched.find((sm) => sm.model === found)) {
      matched.push({ model: found });
    }
  }
  return matched;
}

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir });
  const scopedModels = resolveScopedModelsFromSettings(services);
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      scopedModels,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendFile(res, filePath) {
  const type = mimeTypes[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache, no-store, must-revalidate",
  });
  createReadStream(filePath).pipe(res);
}

function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(join(publicDir, pathname));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  sendFile(res, filePath);
}

// Built-in slash commands that map cleanly to SDK calls. Commands that require
// interactive UI (settings, login, model selector, fork picker, etc.) are not
// here — the client handles them with a "not supported" toast.
const SLASH_HANDLERS = {
  new: async (ctrl) => {
    const result = await ctrl.runtime.newSession();
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  compact: async (ctrl, arg) => {
    const result = await ctrl.session.compact(arg || undefined);
    await ctrl.sendState();
    await ctrl.sendMessages();
    return result;
  },
  name: async (ctrl, arg) => {
    ctrl.session.setSessionName(String(arg || "").trim());
    await ctrl.sendState();
    await ctrl.sendSessions();
    return { name: ctrl.session.sessionName };
  },
  reload: async (ctrl) => {
    await ctrl.session.reload();
    await ctrl.sendState();
    return { reloaded: true };
  },
  session: async (ctrl) => {
    await ctrl.sendState();
    const s = ctrl.serializeState();
    const stats = ctrl.session.getSessionStats?.() || {};
    const lines = [
      `id:        ${s.sessionId}`,
      `name:      ${s.sessionName || "(unnamed)"}`,
      `file:      ${s.sessionFile || "(ephemeral)"}`,
      `cwd:       ${s.cwd}`,
      `model:     ${s.model ? `${s.model.provider}/${s.model.id}` : "(none)"}`,
      `thinking:  ${s.thinkingLevel}`,
      `streaming: ${s.isStreaming ? "yes" : "no"}`,
      `compact:   ${s.autoCompactionEnabled ? "auto" : "off"}`,
      `messages:  ${s.messageCount}`,
      `tools:     ${s.activeTools.length} active / ${s.toolCount} total`,
    ];
    if (stats.tokens) {
      lines.push(
        `tokens:    in ${stats.tokens.input} · out ${stats.tokens.output} · cache r/w ${stats.tokens.cacheRead}/${stats.tokens.cacheWrite}`,
      );
    }
    if (typeof stats.cost === "number") lines.push(`cost:      $${stats.cost.toFixed(4)}`);
    return { showText: { title: "Session", body: lines.join("\n") } };
  },
  settings: async (ctrl) => {
    const sm = ctrl.session.settingsManager;
    const enabledModels = sm.getEnabledModels?.() ?? null;
    const lines = [
      `auto-compaction:   ${ctrl.session.autoCompactionEnabled ? "on" : "off"}`,
      `thinking level:    ${ctrl.session.thinkingLevel}`,
      `enabled models:    ${enabledModels && enabledModels.length > 0 ? enabledModels.join(", ") : "(all)"}`,
      `default model:     ${sm.getDefaultProvider?.() || "?"}/${sm.getDefaultModelId?.() || "?"}`,
      `agent dir:         ${agentDir}`,
      `cwd:               ${ctrl.runtime.cwd}`,
    ];
    return {
      showText: {
        title: "Settings",
        body: lines.join("\n") + "\n\nManage settings with /scoped-models, /model, etc., or via the CLI.",
      },
    };
  },
  login: async (ctrl, arg) => {
    const parts = String(arg || "").trim().split(/\s+/);
    const [provider, apiKey] = parts;
    if (!provider || !apiKey) {
      throw new Error("Usage: /login <provider> <api-key>");
    }
    ctrl.runtime.services.authStorage.set(provider, { type: "api_key", key: apiKey });
    ctrl.runtime.services.modelRegistry.refresh?.();
    await ctrl.sendState();
    return { provider };
  },
  logout: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const auth = ctrl.runtime.services.authStorage;
    if (target) {
      auth.remove(target);
      ctrl.runtime.services.modelRegistry.refresh?.();
      await ctrl.sendState();
      return { provider: target };
    }
    const providers = auth.list();
    if (providers.length === 0) throw new Error("No providers configured");
    return {
      needsPicker: "logout",
      providers,
    };
  },
  share: async () => {
    throw new Error("/share is not supported in the web UI; use the CLI");
  },
  copy: async (ctrl) => {
    const text = ctrl.session.getLastAssistantText?.() || "";
    if (!text) throw new Error("No assistant message to copy");
    return { copyText: text };
  },
  quit: async (ctrl) => {
    setTimeout(() => ctrl.ws.close(), 100);
    return { closed: true };
  },
  hotkeys: async () => ({ showHotkeys: true }),
  changelog: async () => ({
    showText: { title: "Changelog", body: piChangelog || "No changelog available" },
  }),
  export: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const isJsonl = target.toLowerCase().endsWith(".jsonl");
    const path = isJsonl
      ? ctrl.session.exportToJsonl(target || undefined)
      : await ctrl.session.exportToHtml(target || undefined);
    return { exportedTo: path, format: isJsonl ? "jsonl" : "html" };
  },
  import: async (ctrl, arg) => {
    const path = String(arg || "").trim();
    if (!path) throw new Error("Usage: /import <path-to-jsonl>");
    const result = await ctrl.runtime.importFromJsonl(path);
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  clone: async (ctrl) => {
    const leafId = ctrl.session.sessionManager.getLeafId();
    if (!leafId) throw new Error("Nothing to clone yet");
    const result = await ctrl.runtime.fork(leafId, { position: "at" });
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  fork: async (ctrl, arg) => {
    const entryId = String(arg || "").trim();
    if (entryId) {
      const result = await ctrl.runtime.fork(entryId, { position: "before" });
      if (!result?.cancelled) {
        await ctrl.bindSession();
        await ctrl.sendBootstrap();
      }
      return result;
    }
    const messages = ctrl.session.getUserMessagesForForking();
    if (messages.length === 0) throw new Error("No user messages to fork from");
    return {
      needsPicker: "fork",
      messages: messages.map((m) => ({ entryId: m.entryId, text: m.text })),
    };
  },
  tree: async (ctrl, arg) => {
    const targetId = String(arg || "").trim();
    if (targetId) {
      const result = await ctrl.session.navigateTree(targetId);
      await ctrl.sendBootstrap();
      return result;
    }
    const tree = ctrl.session.sessionManager.getTree();
    const leafId = ctrl.session.sessionManager.getLeafId();

    const flattened = [];
    const walk = (nodes) => {
      for (const node of nodes || []) {
        if (!node) continue;
        const entry = node.entry || {};
        const id = node.id || entry.id || entry.entryId || "";
        const msg = entry.message || {};
        let summary = node.label || entry.text || "";
        if (!summary) {
          const content = entry.content || msg.content;
          if (Array.isArray(content)) {
            summary = content.find((c) => c && c.type === "text")?.text || "";
          } else if (typeof content === "string") {
            summary = content;
          }
        }
        if (!summary && entry.type === "compaction") summary = entry.summary || "";
        if (!summary && entry.type === "branch_summary") summary = entry.summary || "";
        flattened.push({
          id,
          summary: String(summary || entry.type || msg.role || entry.role || id || "Unknown")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200),
          role: msg.role || entry.role,
          kind: entry.type,
        });
        if (node.children) walk(node.children);
      }
    };
    walk(Array.isArray(tree) ? tree : tree ? [tree] : []);

    return { needsPicker: "tree", tree: flattened, leafId };
  },
  "scoped-models": async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const all = ctrl.session.modelRegistry.getAvailable();
    if (target) {
      const patterns = target.split(/[,\s]+/).filter(Boolean);
      ctrl.session.settingsManager.setEnabledModels(patterns.length > 0 ? patterns : undefined);
      const scoped = resolveScopedModelsFromSettings(ctrl.runtime.services);
      ctrl.session.setScopedModels(scoped);
      await ctrl.sendState();
      return { saved: patterns };
    }
    const enabled = ctrl.session.settingsManager.getEnabledModels() || [];
    return {
      needsPicker: "scoped-models",
      models: all.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
      })),
      enabled,
    };
  },
  model: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const scoped = ctrl.session.scopedModels;
    const available = scoped.length > 0
      ? scoped.map((s) => s.model)
      : ctrl.session.modelRegistry.getAvailable();
    if (target) {
      const match = available.find(
        (m) => `${m.provider}/${m.id}` === target || m.id === target,
      );
      if (!match) throw new Error(`Model not found: ${target}`);
      await ctrl.session.setModel(match);
      await ctrl.sendState();
      return { provider: match.provider, id: match.id };
    }
    const current = ctrl.session.model;
    return {
      needsPicker: "model",
      currentModel: current ? `${current.provider}/${current.id}` : null,
      models: available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow,
      })),
    };
  },
  resume: async (ctrl, arg) => {
    const path = String(arg || "").trim();
    if (path) {
      const result = await ctrl.runtime.switchSession(path);
      if (!result?.cancelled) {
        await ctrl.bindSession();
        await ctrl.sendBootstrap();
      }
      return result;
    }
    const [currentProject, allProjects] = await Promise.all([
      SessionManager.list(ctrl.runtime.cwd, sessionDir),
      SessionManager.listAll(),
    ]);
    return {
      needsPicker: "session",
      currentSessionFile: ctrl.session.sessionFile || null,
      sessions: {
        currentProject: currentProject.map(serializeSessionInfo),
        allProjects: allProjects.map(serializeSessionInfo),
      },
    };
  },
};

function shouldRefreshState(eventType) {
  return new Set([
    "agent_start",
    "agent_end",
    "turn_end",
    "queue_update",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "tool_execution_end",
    "context_update",
  ]).has(eventType);
}

function shouldRefreshMessages(eventType) {
  return new Set([
    "agent_start",
    "agent_end",
    "compaction_end",
  ]).has(eventType);
}

function serializeSessionInfo(info) {
  return {
    ...info,
    created: info.created instanceof Date ? info.created.toISOString() : info.created,
    modified: info.modified instanceof Date ? info.modified.toISOString() : info.modified,
  };
}

class NativePiSessionController {
  constructor(ws) {
    this.ws = ws;
    this.runtime = undefined;
    this.unsubscribe = undefined;
    this.fileWatcher = undefined;
    this.watchedFile = undefined;
    this.lastSelfActivity = 0;
    this.refreshTimer = undefined;
    this.refreshing = false;
    this.eventLog = createEventLog();
    this.ready = this.init().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(this.ws, { type: "server_error", payload: message });
      throw error;
    });
  }

  async init() {
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: appCwd,
      agentDir,
      sessionManager: SessionManager.create(appCwd, sessionDir),
    });

    await this.bindSession();

    sendJson(this.ws, {
      type: "connected",
      payload: {
        appCwd,
        agentDir,
        diagnostics: this.runtime.diagnostics,
        slashCommands: this.collectSlashCommands(),
      },
    });
    // Bootstrap is now driven by the client's `ready` message — they tell us
    // their lastSeq and we either replay missed events or send a reset +
    // fresh bootstrap. This lets reconnecting clients keep their UI state
    // when the buffer covers the gap (cross-WS replay still requires the
    // shared-controller refactor; today the buffer is per-WS so a reconnect
    // always falls through to reset, but the wire protocol is in place).
  }

  async bindSession() {
    this.unsubscribe?.();
    const session = this.runtime.session;
    await session.bindExtensions({});
    this.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(event);
    });
    this.startFileWatch();
    logger.info("session bound", {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile || null,
      model: session.model ? `${session.model.provider}/${session.model.id}` : null,
    });
  }

  onSessionEvent(event) {
    // Mark self-activity so the file watcher can ignore writes we caused.
    this.lastSelfActivity = Date.now();

    const seq = this.eventLog.append(event);
    this.logSessionEvent(event, seq);
    sendJson(this.ws, { type: "session_event", payload: event, seq });

    if (shouldRefreshState(event.type)) {
      this.sendState();
    }

    if (shouldRefreshMessages(event.type)) {
      this.sendMessages();
    }

    // Once a turn has ended, the canonical snapshot we just sent encodes
    // everything before this point — we no longer need to be able to replay
    // it, so drop those events from the buffer.
    if (event.type === "agent_end") {
      this.eventLog.trimSettled();
    }
  }

  // Map noteworthy session events to log lines. Frequent/streaming events
  // (message_update, context_update, queue_update, …) only fire at debug.
  logSessionEvent(event, seq) {
    const t = event?.type;
    switch (t) {
      case "agent_start":
        logger.info("turn start", { seq, model: event.model ? `${event.model.provider}/${event.model.id}` : undefined });
        return;
      case "agent_end": {
        const stats = this.session.getSessionStats?.() || {};
        logger.info("turn end", {
          seq,
          tokensIn: stats.tokens?.input,
          tokensOut: stats.tokens?.output,
          cost: typeof stats.cost === "number" ? Number(stats.cost.toFixed(4)) : undefined,
        });
        return;
      }
      case "tool_execution_start":
        logger.info("tool start", { seq, tool: event.toolName || event.name });
        return;
      case "tool_execution_end": {
        const ok = event.error ? false : true;
        const fields = { seq, tool: event.toolName || event.name, ok };
        if (!ok) fields.error = event.error?.message || String(event.error);
        (ok ? logger.info : logger.warn)("tool end", fields);
        return;
      }
      case "compaction_start":
        logger.info("compaction start", { seq });
        return;
      case "compaction_end":
        logger.info("compaction end", { seq });
        return;
      case "auto_retry_start":
        logger.warn("auto retry", { seq, attempt: event.attempt, error: event.error?.message });
        return;
      case "auto_retry_end":
        logger.info("auto retry end", { seq });
        return;
      case "extension_error":
        logger.error("extension error", { seq, error: event.error?.message || String(event.error) });
        return;
      case "turn_end":
      case "context_update":
      case "queue_update":
      case "message_update":
        logger.debug(`event ${t}`, { seq });
        return;
      default:
        logger.debug(`event ${t}`, { seq });
    }
  }

  startFileWatch() {
    const sessionFile = this.runtime?.session?.sessionFile;
    if (this.watchedFile === sessionFile) return;
    this.stopFileWatch();
    if (!sessionFile) return;
    try {
      this.fileWatcher = fsWatch(sessionFile, () => this.onSessionFileChange());
      this.watchedFile = sessionFile;
    } catch {
      // file may not yet exist for unpersisted sessions; ignore.
    }
  }

  stopFileWatch() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    try { this.fileWatcher?.close(); } catch { /* ignore */ }
    this.fileWatcher = undefined;
    this.watchedFile = undefined;
  }

  onSessionFileChange() {
    if (isSelfEcho(Date.now(), this.lastSelfActivity)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    logger.info("external session file change detected", { sessionFile: this.watchedFile });
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshFromFile();
    }, EXTERNAL_REFRESH_DEBOUNCE_MS);
  }

  // Reload the session JSONL from disk to pick up changes from another pi
  // instance. Skipped while we are streaming or otherwise busy — the next
  // external write will retrigger it.
  async refreshFromFile() {
    const session = this.runtime?.session;
    const sessionFile = session?.sessionFile;
    if (!sessionFile) return;
    const ok = canRefreshNow({
      now: Date.now(),
      lastSelfActivity: this.lastSelfActivity,
      isStreaming: !!session.isStreaming,
      isCompacting: !!session.isCompacting,
      isRetrying: !!session.isRetrying,
      refreshing: this.refreshing,
    });
    if (!ok) {
      logger.info("external refresh skipped (busy)", { sessionFile });
      return;
    }
    this.refreshing = true;
    logger.info("external refresh begin", { sessionFile });
    try {
      const result = await this.runtime.switchSession(sessionFile);
      if (!result?.cancelled) {
        await this.bindSession();
        await this.sendBootstrap();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("external refresh failed", { sessionFile, error: message });
      sendJson(this.ws, { type: "server_error", payload: `External refresh failed: ${message}` });
    } finally {
      this.refreshing = false;
    }
  }

  get session() {
    if (!this.runtime) throw new Error("Pi runtime is not initialized");
    return this.runtime.session;
  }

  serializeState() {
    const session = this.session;
    let contextUsage = null;
    try {
      contextUsage = session.getContextUsage() ?? null;
    } catch {
      contextUsage = null;
    }
    return {
      cwd: this.runtime.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      autoCompactionEnabled: session.autoCompactionEnabled,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      activeTools: session.getActiveToolNames(),
      toolCount: session.getAllTools().length,
      messageCount: session.messages.length,
      contextUsage,
      model: session.model
        ? {
            provider: session.model.provider,
            id: session.model.id,
            name: session.model.name,
            reasoning: session.model.reasoning,
            contextWindow: session.model.contextWindow,
            maxTokens: session.model.maxTokens,
          }
        : null,
    };
  }

  async sendState() {
    sendJson(this.ws, { type: "session_state", payload: this.serializeState() });
  }

  async sendMessages() {
    sendJson(this.ws, { type: "message_history", payload: this.session.messages });
  }

  async sendSessions() {
    const [currentProject, allProjects] = await Promise.all([
      SessionManager.list(this.runtime.cwd, sessionDir),
      SessionManager.listAll(),
    ]);

    sendJson(this.ws, {
      type: "sessions",
      payload: {
        currentProject: currentProject.map(serializeSessionInfo),
        allProjects: allProjects.map(serializeSessionInfo),
      },
    });
  }

  collectSlashCommands() {
    const commands = BUILTIN_SLASH_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description,
      source: "builtin",
      supported: SLASH_HANDLERS[c.name] !== undefined,
    }));

    for (const tpl of this.session.promptTemplates ?? []) {
      commands.push({
        name: tpl.name,
        description: tpl.description || "",
        source: "template",
        supported: true,
        argumentHint: tpl.argumentHint,
      });
    }

    const runner = this.session.extensionRunner;
    if (runner?.getRegisteredCommands) {
      const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
      for (const cmd of runner.getRegisteredCommands()) {
        if (builtinNames.has(cmd.name)) continue;
        commands.push({
          name: cmd.invocationName ?? cmd.name,
          description: cmd.description || "",
          source: "extension",
          supported: true,
        });
      }
    }

    return commands;
  }

  // Tell the client to discard any streamed UI state. Sent before a fresh
  // bootstrap on cold start, session switch, or replay miss.
  sendSessionReset() {
    sendJson(this.ws, {
      type: "session_reset",
      payload: { currentSeq: this.eventLog.currentSeq() },
    });
  }

  async sendBootstrap({ reset = true } = {}) {
    if (reset) this.sendSessionReset();
    await this.sendState();
    await this.sendMessages();
    await this.sendSessions();
  }

  // Handle the client's resume request. If we can replay missed events,
  // do so without disturbing UI state. Otherwise fall back to a reset +
  // fresh bootstrap.
  async handleReady(lastSeq, sessionFile) {
    if (sessionFile && sessionFile !== (this.session.sessionFile || null)) {
      try {
        logger.info("client requested session", { sessionFile });
        const switched = await this.runtime.switchSession(sessionFile);
        if (!switched?.cancelled) await this.bindSession();
      } catch (error) {
        logger.warn("client requested session unavailable", {
          sessionFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const result = this.eventLog.eventsAfter(lastSeq);
    if (result.miss) {
      logger.info("client resume miss, full bootstrap", { lastSeq });
      await this.sendBootstrap({ reset: true });
      return;
    }
    if (result.events.length > 0) {
      logger.info("client resume replay", { from: lastSeq, count: result.events.length });
    }
    for (const { seq, event } of result.events) {
      sendJson(this.ws, { type: "session_event", payload: event, seq });
    }
    sendJson(this.ws, {
      type: "replay_done",
      payload: { currentSeq: this.eventLog.currentSeq() },
    });
  }

  async runCommand(command, handler) {
    try {
      const data = await handler();
      sendJson(this.ws, { type: "command_result", payload: { command, ok: true, data } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("command failed", { command, error: message });
      sendJson(this.ws, { type: "command_result", payload: { command, ok: false, error: message } });
    }
  }

  async handle(payload) {
    await this.ready;

    const inboundType = payload?.type === "slash_command"
      ? `slash_command:${payload?.name || "?"}`
      : (payload?.type || "unknown");
    logger.debug("ws inbound", { type: inboundType });

    switch (payload?.type) {
      case "ready": {
        const lastSeq = typeof payload.lastSeq === "number" ? payload.lastSeq : null;
        const sessionFile = typeof payload.sessionFile === "string" && payload.sessionFile ? payload.sessionFile : null;
        await this.handleReady(lastSeq, sessionFile);
        return;
      }
      case "refresh":
        await this.runCommand("refresh", async () => {
          await this.sendBootstrap({ reset: true });
          return { refreshed: true };
        });
        return;

      case "prompt": {
        const message = String(payload.message || "").trim();
        if (!message) {
          sendJson(this.ws, {
            type: "command_result",
            payload: { command: "prompt", ok: false, error: "Message cannot be empty" },
          });
          return;
        }

        const streamingBehavior = this.session.isStreaming ? payload.streamingBehavior || "followUp" : undefined;
        logger.info("prompt accepted", {
          length: message.length,
          streaming: this.session.isStreaming,
          streamingBehavior,
        });
        void this.runCommand("prompt", async () => {
          await this.session.prompt(message, {
            streamingBehavior,
            preflightResult: (success) => {
              if (!success) logger.warn("prompt preflight rejected");
              sendJson(this.ws, { type: "prompt_preflight", payload: { success } });
            },
          });
          await this.sendState();
          await this.sendMessages();
          await this.sendSessions();
          return { accepted: true };
        });
        return;
      }

      case "abort":
        logger.info("abort requested");
        await this.runCommand("abort", async () => {
          await this.session.abort();
          await this.sendState();
          return { aborted: true };
        });
        return;

      case "new_session":
        logger.info("new session requested");
        await this.runCommand("new_session", async () => {
          const result = await this.runtime.newSession();
          if (!result.cancelled) {
            await this.bindSession();
            await this.sendBootstrap();
          }
          return result;
        });
        return;

      case "switch_session":
        await this.runCommand("switch_session", async () => {
          const sessionPath = String(payload.sessionPath || "").trim();
          if (!sessionPath) {
            throw new Error("sessionPath is required");
          }
          logger.info("switch session", { sessionPath });
          const result = await this.runtime.switchSession(sessionPath);
          if (!result.cancelled) {
            await this.bindSession();
            await this.sendBootstrap();
          }
          return result;
        });
        return;

      case "cycle_model":
        await this.runCommand("cycle_model", async () => {
          const result = await this.session.cycleModel();
          const m = this.session.model;
          logger.info("model cycled", { model: m ? `${m.provider}/${m.id}` : null });
          await this.sendState();
          return result || { changed: false };
        });
        return;

      case "set_session_name":
        await this.runCommand("set_session_name", async () => {
          const name = String(payload.name || "").trim();
          this.session.setSessionName(name);
          await this.sendState();
          await this.sendSessions();
          return { name };
        });
        return;

      case "bash":
        await this.runCommand("bash", async () => {
          const command = String(payload.command || "").trim();
          if (!command) throw new Error("Empty bash command");
          logger.info("bash exec", { command });
          const result = await this.session.executeBash(command);
          const exitCode = result?.exitCode ?? 0;
          (exitCode === 0 ? logger.info : logger.warn)("bash done", { exitCode });
          await this.sendState();
          await this.sendMessages();
          return { exitCode };
        });
        return;

      case "slash_command": {
        const name = String(payload.name || "").trim();
        const arg = typeof payload.arg === "string" ? payload.arg : "";
        logger.info("slash command", { name, hasArg: arg.length > 0 });
        const handler = SLASH_HANDLERS[name];
        if (handler) {
          await this.runCommand(`slash:${name}`, () => handler(this, arg));
          return;
        }
        // Fall through to extension/template dispatch via session.prompt — it
        // detects "/cmd ..." text and routes to the registered handler.
        const runner = this.session.extensionRunner;
        const isExtension = runner?.getCommand && runner.getCommand(name);
        const isTemplate = (this.session.promptTemplates ?? []).some((t) => t.name === name);
        if (isExtension || isTemplate) {
          const text = arg ? `/${name} ${arg}` : `/${name}`;
          await this.runCommand(`slash:${name}`, async () => {
            await this.session.prompt(text);
            await this.sendState();
            await this.sendMessages();
            return { dispatched: true };
          });
          return;
        }
        sendJson(this.ws, {
          type: "command_result",
          payload: {
            command: `slash:${name}`,
            ok: false,
            error: `/${name} is not supported in the web UI`,
          },
        });
        return;
      }

      default:
        sendJson(this.ws, {
          type: "command_result",
          payload: { command: payload?.type || "unknown", ok: false, error: "Unknown command" },
        });
    }
  }

  async close() {
    try {
      this.stopFileWatch();
      this.unsubscribe?.();
      await this.runtime?.dispose();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

const server = createServer((req, res) => {
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  logger.info("ws connect", { remote });
  const controller = new NativePiSessionController(ws);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      void controller.handle(data).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("ws handler error", { error: message });
        sendJson(ws, { type: "server_error", payload: message });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("ws parse error", { error: message });
      sendJson(ws, { type: "server_error", payload: message });
    }
  });

  ws.on("close", () => {
    logger.info("ws disconnect", { remote });
    void controller.close();
  });
});

server.listen(port, host, () => {
  logger.info("listening", { url: `http://${host}:${port}`, appCwd, agentDir, sessionDir: sessionDir || undefined });
});
