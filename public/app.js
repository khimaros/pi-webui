const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const log = document.getElementById("log");
const toastLayer = document.getElementById("toast-layer");
const slashMenu = document.getElementById("slash-menu");
const modal = document.getElementById("modal");
const modalSearch = document.getElementById("modal-search");
const modalBody = document.getElementById("modal-body");
const modalTitle = document.getElementById("modal-title");
const modalDialog = modal.querySelector(".modal");
const statusLeft = document.getElementById("status-left");
const statusRight = document.getElementById("status-right");
const statusCwd = document.getElementById("status-cwd");
const statusError = document.getElementById("status-error");

import {
  createChatState,
  submitUser as csSubmitUser,
  setHistory as csSetHistory,
  resetHistory as csResetHistory,
  setError as csSetError,
  selectItems as csSelectItems,
} from "./chat-state.mjs";
import { dispatchSessionEvent } from "./session-dispatch.mjs";
import { decideExtraItemRender } from "./render-decision.mjs";
import {
  extractTextFromResult,
  extractResultParts,
  stripCatNLinePrefixes,
} from "./tool-result.mjs";
import { ACTIVE_SESSION_KEY, extractSessionFileFromState } from "./storage.mjs";
import { formatMessage, sdkContentToBlocks } from "./format-message.mjs";
import { shouldHighlightCodeBlock } from "./highlight.mjs";
import { planBlockRenders, reconcileChildrenInPlace } from "./render-blocks.mjs";
import { createFollowState, onScrollEvent, shouldAutoScroll } from "./scroll-follow.mjs";
import { log as logger } from "./log.mjs";

let socket;
let currentSessionState = null;
const chatState = createChatState();
let slashCommands = [];
let slashFiltered = [];
let slashIndex = 0;
// Cursor into the server's session-event log. The server tags each
// session_event with a seq; we send our latest one back on (re)connect via
// `ready` so the server can replay missed events without a full reset.
let lastSeq = null;

function loadStoredSessionFile() {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function saveStoredSessionFile(file) {
  try {
    if (file) localStorage.setItem(ACTIVE_SESSION_KEY, file);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

const INPUT_HISTORY_KEY = "pi-webui:input-history";
const INPUT_HISTORY_LIMIT = 200;
let inputHistory = loadInputHistory();
let inputHistoryIndex = inputHistory.length;
let inputHistoryDraft = "";

function loadInputHistory() {
  try {
    const raw = localStorage.getItem(INPUT_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function saveInputHistory() {
  try {
    localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(inputHistory));
  } catch {
    /* ignore quota */
  }
}

function pushInputHistory(text) {
  if (!text) return;
  if (inputHistory[inputHistory.length - 1] === text) {
    inputHistoryIndex = inputHistory.length;
    return;
  }
  inputHistory.push(text);
  if (inputHistory.length > INPUT_HISTORY_LIMIT) {
    inputHistory.splice(0, inputHistory.length - INPUT_HISTORY_LIMIT);
  }
  inputHistoryIndex = inputHistory.length;
  saveInputHistory();
}

function resizeInput() {
  input.style.height = "36px";
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

// rows to jump per Page Up / Page Down inside a modal picker.
const MODAL_PAGE_SIZE = 10;
let modalItems = [];
let modalFiltered = [];
let modalIndex = 0;
let modalOnSelect = null;
let modalOnCommit = null;
let modalMulti = false;
let modalSelected = new Set();

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  try {
    return openLinksInNewTab(marked.parse(text, { gfm: true, breaks: true }));
  } catch {
    return escapeHtml(text);
  }
}

function openLinksInNewTab(html) {
  // Inject target="_blank" + rel for any <a> that doesn't already have target.
  return html.replace(
    /<a\b(?![^>]*\btarget=)([^>]*)>/gi,
    '<a$1 target="_blank" rel="noopener noreferrer">',
  );
}

function highlightCodeBlocks(root) {
  if (typeof hljs === "undefined" || !root) return;
  for (const block of root.querySelectorAll("pre code")) {
    if (!shouldHighlightCodeBlock(block)) continue;
    try {
      hljs.highlightElement(block);
      block.dataset.highlighted = "yes";
    } catch {
      /* ignore */
    }
  }
}

/* ── Block renderers ─────────────────────────────── */

function renderTextBlockHtml(text) {
  return renderMarkdown(text);
}

function renderThinkingBlockHtml(text) {
  return `<div class="thinking-block">${escapeHtml(text)}</div>`;
}

function renderToolCallBlockHtml(name, input) {
  const json = JSON.stringify(input ?? {}, null, 2);
  return `<details class="tool-block" open><summary class="tool-label">${escapeHtml(name)}</summary><pre><code class="language-json">${escapeHtml(json)}</code></pre></details>`;
}

function formatDiffHtml(diff) {
  // Render each diff line as its own block element so per-line backgrounds
  // fill the line. When hljs is available we also syntax-highlight each
  // line — language is detected once across the whole body so per-line calls
  // share a consistent grammar.
  const lines = diff.split("\n");
  let lang = null;
  if (typeof hljs !== "undefined") {
    const sample = lines.filter((l) => l.length > 0).join("\n");
    try {
      if (sample) lang = hljs.highlightAuto(sample).language || null;
    } catch {
      lang = null;
    }
  }
  return lines
    .map((line) => {
      const kind = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx";
      let body;
      if (line.length === 0) {
        body = "&nbsp;";
      } else if (lang) {
        try {
          body = hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
        } catch {
          body = escapeHtml(line);
        }
      } else {
        body = escapeHtml(line);
      }
      return `<div class="diff-line ${kind}">${body}</div>`;
    })
    .join("");
}

function renderToolResultBlockHtml(name, result) {
  if (result === null || result === undefined) {
    // Pending placeholder — keep the entry empty until tool_execution_end fills
    // it in. The surrounding section's <h3> still shows so the user sees the
    // tool was invoked.
    return "";
  }

  // For the "edit" tool, extract details (which may contain a diff) so we can
  // offer a toggle between the text output and the diff view.
  const { text: rawText, details } = extractResultParts(result);
  const isEdit = name === "edit";
  const diff = isEdit && details && details.diff ? details.diff : null;

  const text = isEdit
    ? rawText
    : rawText !== null
      ? (name === "Read" ? stripCatNLinePrefixes(rawText) : rawText)
      : null;

  let toggleBtns = "";
  let contentHtml;
  let dataAttrs = "";

  if (isEdit && text && diff) {
    // Default to the diff view — that's the useful one for an edit result.
    toggleBtns = `<span class="tool-result-toggles">`
      + `<button type="button" class="toggle-btn active" data-view="diff" title="Show diff output">diff</button>`
      + `<button type="button" class="toggle-btn" data-view="text" title="Show text output">text</button>`
      + `</span>`;
    contentHtml = `<code class="diff-content">${formatDiffHtml(diff)}</code>`;
    dataAttrs = ` data-view="diff" data-has-diff="1"`;
  } else {
    if (text) {
      contentHtml = `<code>${escapeHtml(text)}</code>`;
    } else if (typeof result === "string") {
      contentHtml = `<code>${escapeHtml(result)}</code>`;
    } else {
      contentHtml = `<code class="language-json">${escapeHtml(JSON.stringify(result, null, 2))}</code>`;
    }
    dataAttrs = ` data-view="single" data-has-diff="0"`;
  }

  // Store raw text/diff in data attributes so the toggle handler can swap
  // between the two views without re-rendering the whole block.
  const dataTextAttr = text
    ? ` data-text="${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
    : "";
  const dataDiffAttr = diff
    ? ` data-diff="${diff.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
    : "";
  const body = `<pre${dataAttrs}${dataTextAttr}${dataDiffAttr}>${toggleBtns}<button type="button" class="copy-btn" title="Copy">copy</button>${contentHtml}</pre>`;
  return `<details class="tool-result-block" open><summary class="tool-result-label">${escapeHtml(name)}</summary>${body}</details>`;
}

function renderBlocksHtml(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (!b) continue;
    switch (b.type) {
      case "text":
        parts.push(renderTextBlockHtml(b.text || ""));
        break;
      case "thinking":
        parts.push(renderThinkingBlockHtml(b.text || ""));
        break;
      case "tool_call":
        parts.push(renderToolCallBlockHtml(b.name, b.input));
        break;
      case "tool_result":
        parts.push(renderToolResultBlockHtml(b.name, b.result));
        break;
      case "image":
        parts.push(escapeHtml(`[image ${b.mimeType || ""}]`));
        break;
      default:
        parts.push(`<pre><code class="language-json">${escapeHtml(JSON.stringify(b, null, 2))}</code></pre>`);
    }
  }
  return parts.join("");
}

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastLayer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function syncRunningButton() {
  const running = chatState.isRunning;
  sendButton.classList.toggle("is-running", running);
  sendButton.setAttribute("aria-label", running ? "Stop" : "Send");
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isLogAtBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

// sticky follow flag: once the user scrolls away from the bottom we stop
// auto-scrolling until they return. We distinguish user-initiated scrolls
// (wheel / key / touch) from layout-induced ones (DOM mutation clamping
// scrollTop) — only the former reflect intent. Layout-induced events fire
// from the browser when scrollHeight shrinks past scrollTop and would
// otherwise mistake mid-render heights for "user scrolled away".
const followState = createFollowState();
let lastUserInputAt = 0;
const USER_INPUT_WINDOW_MS = 250;
function markUserInput() { lastUserInputAt = performance.now(); }
log.addEventListener("wheel", markUserInput, { passive: true });
log.addEventListener("touchstart", markUserInput, { passive: true });
log.addEventListener("touchmove", markUserInput, { passive: true });
window.addEventListener("keydown", (e) => {
  if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) {
    markUserInput();
  }
});
log.addEventListener("scroll", () => {
  const isUser = performance.now() - lastUserInputAt < USER_INPUT_WINDOW_MS;
  onScrollEvent(followState, {
    distanceFromBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
    origin: isUser ? "user" : "layout",
  });
});

function scrollLogToBottom() {
  requestAnimationFrame(() => {
    if (!shouldAutoScroll(followState)) return;
    log.scrollTop = log.scrollHeight;
  });
}

function buildBlockNode(block, { highlightText }) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  wrap.innerHTML = renderBlocksHtml([block]);
  // tool_call / tool_result are complete at build time and stable thereafter
  // (planBlockRenders will keep them on subsequent ticks), so highlight them
  // synchronously now — this is the only chance. Text/thinking blocks may
  // still be streaming; defer highlighting until they freeze.
  const isToolBlock = block?.type === "tool_call" || block?.type === "tool_result";
  if (isToolBlock || highlightText) highlightCodeBlocks(wrap);
  return wrap;
}

function reconcileBlocks(body, blocks, prevBlocks, { highlightText }) {
  const plan = planBlockRenders(blocks, prevBlocks);
  const existing = Array.from(body.children);
  const desired = plan.map((entry, i) => {
    if (entry.action === "keep" && existing[i]) return existing[i];
    return buildBlockNode(entry.block, { highlightText });
  });
  reconcileChildrenInPlace(body, desired);
}

function buildMessageElement(kind, title, blocks, { highlight = true } = {}) {
  const el = document.createElement("section");
  el.className = `message ${kind}`;
  el.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="message-body"></div>`;
  reconcileBlocks(el.querySelector(".message-body"), blocks, null, { highlightText: highlight });
  return el;
}

function updateMessageBody(el, blocks, prevBlocks, { highlight = true } = {}) {
  reconcileBlocks(el.querySelector(".message-body"), blocks, prevBlocks, { highlightText: highlight });
}

function buildTypingElement() {
  const el = document.createElement("section");
  el.className = "message assistant";
  el.innerHTML = `<h3>Assistant</h3><div class="message-body"><span class="thinking-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
  return el;
}

// ── Keyed incremental rendering ───────────────────────────────────────────
// Per render we compute a desired array of DOM nodes and reconcile log's
// children against it. Element identity is preserved across renders so:
//   - <details> open/closed state survives mutations elsewhere in the log,
//   - text selection inside frozen messages is not blown away on each delta,
//   - syntax highlighting is not redone on every keystroke.

const extraEls = new WeakMap(); // chat-state extra item -> { el, blocks }
let canonicalEls = [];          // index-aligned [{ el, message }, ...]
let typingEl = null;

function reconcileChildren(parent, desired) {
  // Walk desired list; ensure each element sits at the matching index.
  // insertBefore moves an existing child rather than cloning.
  for (let i = 0; i < desired.length; i++) {
    const want = desired[i];
    const cur = parent.childNodes[i];
    if (cur === want) continue;
    parent.insertBefore(want, cur || null);
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.lastChild);
  }
}

function renderLog() {
  const items = csSelectItems(chatState);

  // Items whose blocks may still mutate in place — we always re-render them
  // and skip syntax highlighting (partial code/JSON) until they freeze.
  // Today this is just the live assistant entry; tool_call and tool_result
  // are nested blocks inside it rather than separate items.
  const liveItems = new Set();
  if (chatState.liveAssistant) liveItems.add(chatState.liveAssistant);

  const newCanonicalEls = [];
  let canonicalIdx = 0;
  const desired = [];

  for (const it of items) {
    let el;
    if (it.source === "canonical") {
      const r = formatMessage(it.message);
      const prev = canonicalEls[canonicalIdx];
      if (prev && prev.message === it.message) {
        // Same SDK message reference — reuse the DOM node as-is. The SDK
        // replaces the messages array wholesale on each snapshot, so this
        // path is taken only when selectItems is called twice without an
        // intervening setHistory (cheap re-render).
        el = prev.el;
      } else {
        el = buildMessageElement(r.kind, r.title, r.blocks);
      }
      newCanonicalEls.push({ el, message: it.message });
      canonicalIdx += 1;
    } else if (it.source === "extra") {
      const item = it.item;
      const cached = extraEls.get(item);
      const isLive = liveItems.has(item);
      if (!cached) {
        el = buildMessageElement(item.kind, item.title, item.blocks, { highlight: !isLive });
        extraEls.set(item, {
          el,
          blocks: item.blocks,
          // Snapshot per-block refs so planBlockRenders can detect which
          // positions are stable across deltas (chat-state mutates the
          // blocks array in place, so the array reference alone is
          // useless for change detection).
          blocksSnapshot: item.blocks.slice(),
          wasLive: isLive,
        });
      } else {
        el = cached.el;
        const { rerender, highlight } = decideExtraItemRender(cached, item, isLive);
        if (rerender) {
          updateMessageBody(el, item.blocks, cached.blocksSnapshot, { highlight });
          cached.blocks = item.blocks;
          cached.blocksSnapshot = item.blocks.slice();
        }
        cached.wasLive = isLive;
      }
    } else { // typing
      if (!typingEl) typingEl = buildTypingElement();
      el = typingEl;
    }
    desired.push(el);
  }

  canonicalEls = newCanonicalEls;
  reconcileChildren(log, desired);
  syncRunningButton();
  scrollLogToBottom();
}

function handleSessionEvent(event) {
  // Side-effect-free chat-state mutations go through the dispatcher so they
  // can be unit-tested without DOM. UI-only effects (toasts, status bar,
  // ad-hoc error entries) stay here.
  switch (event?.type) {
    case "agent_start":
      logger.info("turn start");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "agent_end":
      logger.info("turn end");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "tool_execution_start":
      logger.info("tool start", { tool: event.toolName || event.name });
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "tool_execution_end":
      logger.info("tool end", {
        tool: event.toolName || event.name,
        ok: !event.error,
        error: event.error?.message,
      });
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "message_update":
      logger.debug("message update");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "compaction_start":
      logger.info("compaction start");
      showToast("Compaction started", "info");
      return;
    case "compaction_end":
      logger.info("compaction end");
      showToast("Compaction complete", "info");
      return;
    case "extension_error": {
      const msg = event.error?.message || JSON.stringify(event, null, 2);
      logger.error("extension error", { error: event.error?.message });
      csSetError(chatState, event.error?.message || "Extension error");
      chatState.streamExtras.push({
        kind: "error",
        title: "Extension error",
        blocks: [{ type: "text", text: msg }],
      });
      renderLog();
      renderStatusBar();
      return;
    }
    case "auto_retry_start":
      logger.warn("auto retry", { attempt: event.attempt, error: event.error?.message });
      csSetError(chatState, `retrying (attempt ${event.attempt ?? "?"}): ${event.error?.message || "model error"}`);
      renderStatusBar();
      return;
    default:
      logger.debug(`event ${event?.type}`);
      return;
  }
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${location.host}/ws`;
  logger.info("ws connecting", { url });
  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    logger.info("ws open", { lastSeq });
    // Tell the server where our event-log cursor is. If it can replay missed
    // events, we keep all streamed UI state. Otherwise it'll send a
    // session_reset followed by a fresh bootstrap.
    send({ type: "ready", lastSeq, sessionFile: loadStoredSessionFile() });
  });

  socket.addEventListener("message", (message) => {
    const packet = JSON.parse(message.data);

    switch (packet.type) {
      case "connected":
        slashCommands = packet.payload.slashCommands || [];
        logger.info("connected", {
          appCwd: packet.payload.appCwd,
          agentDir: packet.payload.agentDir,
          slashCommandCount: slashCommands.length,
        });
        if (packet.payload.diagnostics?.length) {
          for (const d of packet.payload.diagnostics) {
            logger.warn("startup diagnostic", { diagnostic: d });
          }
          showToast(`${packet.payload.diagnostics.length} startup diagnostic(s)`, "warning");
        }
        return;
      case "session_state": {
        const prev = currentSessionState;
        const next = packet.payload;
        const prevModel = prev?.model ? `${prev.model.provider}/${prev.model.id}` : null;
        const nextModel = next?.model ? `${next.model.provider}/${next.model.id}` : null;
        if (prevModel !== nextModel) {
          logger.info("model changed", { from: prevModel, to: nextModel });
        }
        if (prev?.sessionId !== next?.sessionId) {
          logger.info("session changed", {
            sessionId: next?.sessionId,
            sessionFile: next?.sessionFile || null,
          });
        }
        currentSessionState = next;
        saveStoredSessionFile(extractSessionFileFromState(next));
        renderStatusBar();
        return;
      }
      case "message_history":
        csSetHistory(chatState, packet.payload || []);
        renderLog();
        return;
      case "session_reset":
        // Server is telling us to drop streamed UI state — cold start,
        // session switch, or replay miss.
        logger.info("session reset", { currentSeq: packet.payload?.currentSeq ?? null });
        csResetHistory(chatState, []);
        if (typeof packet.payload?.currentSeq === "number") {
          lastSeq = packet.payload.currentSeq;
        } else {
          lastSeq = null;
        }
        renderLog();
        return;
      case "replay_done":
        logger.info("replay done", { currentSeq: packet.payload?.currentSeq ?? null });
        if (typeof packet.payload?.currentSeq === "number") {
          lastSeq = packet.payload.currentSeq;
        }
        return;
      case "session_event":
        if (typeof packet.seq === "number") lastSeq = packet.seq;
        handleSessionEvent(packet.payload);
        return;
      case "command_result":
        if (!packet.payload.ok) {
          const msg = packet.payload.error || `${packet.payload.command} failed`;
          logger.warn("command failed", { command: packet.payload.command, error: msg });
          showToast(msg, "error");
          csSetError(chatState, msg);
          renderStatusBar();
        } else {
          handleSlashResult(packet.payload.data);
        }
        return;
      case "prompt_preflight":
        if (!packet.payload.success) {
          showToast("Prompt was rejected before execution", "warning");
        }
        return;
      case "server_error":
        logger.error("server error", { message: String(packet.payload) });
        showToast(packet.payload, "error");
        csSetError(chatState, String(packet.payload));
        renderStatusBar();
        return;
      default:
        return;
    }
  });

  socket.addEventListener("close", (event) => {
    logger.warn("ws close", { code: event.code, reason: event.reason || undefined });
    csSetError(chatState, "disconnected from server");
    dispatchSessionEvent(chatState, { type: "agent_end" });
    renderLog();
    renderStatusBar();
    // Auto-reconnect after a short delay
    logger.info("ws reconnect scheduled", { delayMs: 1000 });
    setTimeout(connect, 1000);
  });

  socket.addEventListener("error", () => {
    logger.error("ws error");
    csSetError(chatState, "websocket error");
    dispatchSessionEvent(chatState, { type: "agent_end" });
    renderLog();
    renderStatusBar();
  });
}

function openModal(items, opts = {}) {
  if (typeof opts === "function") opts = { onSelect: opts };
  modalItems = items;
  modalMulti = !!opts.multi;
  modalOnSelect = opts.onSelect || null;
  modalOnCommit = opts.onCommit || null;
  modalSelected = new Set(opts.initiallySelected || []);
  modalSearch.value = "";
  modalIndex = 0;
  filterModal();
  modal.hidden = false;
  modalSearch.focus();
}

function closeModal() {
  modal.hidden = true;
  modalDialog.classList.remove("text-mode");
  modalDialog.classList.remove("prompt-mode");
  modalTitle.textContent = "";
  modalItems = [];
  modalFiltered = [];
  modalOnSelect = null;
  modalOnCommit = null;
  modalMulti = false;
  modalSelected = new Set();
  input.focus();
}

function filterModal() {
  const q = modalSearch.value.trim().toLowerCase();
  modalFiltered = q
    ? modalItems.filter((it) => it.search.toLowerCase().includes(q))
    : modalItems.slice();
  if (modalIndex >= modalFiltered.length) modalIndex = 0;
  renderModal();
}

function renderModal() {
  modalBody.innerHTML = "";
  if (modalFiltered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "modal-empty";
    empty.textContent = "No matches";
    modalBody.appendChild(empty);
    return;
  }
  let activeEl = null;
  modalFiltered.forEach((item, i) => {
    const row = document.createElement("div");
    const isSelected = modalMulti && modalSelected.has(item.target);
    const cls = [
      "session-row",
      i === modalIndex ? "active" : "",
      item.current ? "current" : "",
      isSelected ? "selected" : "",
    ].filter(Boolean).join(" ");
    row.className = cls;
    const checkbox = modalMulti ? `<span class="modal-check">${isSelected ? "[x]" : "[ ]"}</span>` : "";
    row.innerHTML = checkbox + item.html;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      modalIndex = i;
      if (modalMulti) {
        toggleSelected();
      } else {
        commitModal();
      }
    });
    modalBody.appendChild(row);
    if (i === modalIndex) activeEl = row;
  });
  activeEl?.scrollIntoView({ block: "nearest" });
}

function toggleSelected() {
  const item = modalFiltered[modalIndex];
  if (!item) return;
  if (modalSelected.has(item.target)) modalSelected.delete(item.target);
  else modalSelected.add(item.target);
  renderModal();
}

function commitModal() {
  if (modalMulti) {
    const cb = modalOnCommit;
    const selected = [...modalSelected];
    closeModal();
    cb?.(selected);
    return;
  }
  const item = modalFiltered[modalIndex];
  if (!item) return;
  const cb = modalOnSelect;
  closeModal();
  cb?.(item);
}

modalSearch.addEventListener("input", filterModal);

modalSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = (modalIndex + 1) % modalFiltered.length;
      renderModal();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = (modalIndex - 1 + modalFiltered.length) % modalFiltered.length;
      renderModal();
    }
  } else if (event.key === "PageDown") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = Math.min(modalFiltered.length - 1, modalIndex + MODAL_PAGE_SIZE);
      renderModal();
    }
  } else if (event.key === "PageUp") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = Math.max(0, modalIndex - MODAL_PAGE_SIZE);
      renderModal();
    }
  } else if (event.key === " " && modalMulti) {
    event.preventDefault();
    toggleSelected();
  } else if (event.key === "Enter") {
    event.preventDefault();
    commitModal();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
  }
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closeModal();
    input.focus();
  }
});

function formatRelativeTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

function showSessionPicker(payload) {
  const merged = [];
  const seen = new Set();
  const lists = [payload.sessions?.currentProject || [], payload.sessions?.allProjects || []];
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      merged.push(s);
    }
  }
  merged.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));

  const items = merged.map((s) => {
    const title = s.name || s.firstMessage || `${(s.id || "").slice(0, 8)}…`;
    const time = formatRelativeTime(s.modified);
    return {
      path: s.path,
      current: s.path === payload.currentSessionFile,
      search: `${title} ${s.cwd || ""} ${s.id || ""}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(title)}</div>
          <div class="session-cwd">${escapeHtml(s.cwd || "")}</div>
        </div>
        <div class="session-meta">${escapeHtml(time)} · ${escapeHtml(String(s.messageCount ?? 0))} msg</div>
      `,
    };
  });

  if (items.length === 0) {
    showToast("No sessions to resume", "info");
    return;
  }

  openModal(items, (item) => {
    send({ type: "slash_command", name: "resume", arg: item.path });
  });
}

function renderStatusBar() {
  statusError.textContent = chatState.lastError || "";
  statusError.title = chatState.lastError || "";
  const s = currentSessionState;
  if (!s) {
    statusLeft.textContent = "";
    statusRight.textContent = "";
    statusCwd.textContent = "";
    return;
  }
  statusCwd.textContent = s.cwd || "";
  const ctx = s.contextUsage;
  const pct = ctx?.percent ?? 0;
  const window = ctx?.contextWindow || s.model?.contextWindow || 0;
  const windowK = window ? `${Math.round(window / 1000)}k` : "?";
  const mode = s.autoCompactionEnabled ? "auto" : "off";
  const pctClass = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  statusLeft.innerHTML =
    `<span class="status-pct ${pctClass}">${pct.toFixed(1)}%</span>` +
    `<span class="status-mode">/${windowK} (${escapeHtml(mode)})</span>`;

  const name = s.sessionName ? `(${s.sessionName})` : "";
  const model = s.model ? `${s.model.provider}/${s.model.id}` : "(no model)";
  const think = s.thinkingLevel || "off";
  statusRight.innerHTML =
    `<span class="status-name">${escapeHtml(name)}</span> ` +
    `<span class="status-model">${escapeHtml(model)}</span> ` +
    `<span class="status-mode">•</span> ` +
    `<span class="status-thinking">${escapeHtml(think)}</span>`;
}

function showForkPicker(payload) {
  const messages = payload.messages || [];
  if (messages.length === 0) {
    showToast("No user messages to fork from", "info");
    return;
  }
  const items = messages.map((m, i) => ({
    target: m.entryId,
    search: m.text,
    html: `
      <div>
        <div class="session-title">${escapeHtml(`#${i + 1} ${m.text.slice(0, 80)}`)}</div>
        <div class="session-cwd">${escapeHtml(m.entryId)}</div>
      </div>
      <div class="session-meta">fork before</div>
    `,
  }));
  openModal(items, (item) => {
    send({ type: "slash_command", name: "fork", arg: item.target });
  });
}

function showTreePicker(payload) {
  const tree = payload.tree || [];
  if (tree.length === 0) {
    showToast("No entries in session", "info");
    return;
  }
  const items = tree.map((node) => {
    const isLeaf = node.id === payload.leafId;
    const summary = node.summary || node.text || node.role || node.kind || node.id;
    return {
      target: node.id,
      current: isLeaf,
      search: `${node.id} ${summary || ""}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(String(summary || node.id).slice(0, 100))}</div>
          <div class="session-cwd">${escapeHtml(node.id)}</div>
        </div>
        <div class="session-meta">${escapeHtml(node.kind || node.role || "")}</div>
      `,
    };
  });
  openModal(items, (item) => {
    send({ type: "slash_command", name: "tree", arg: item.target });
  });
}

function showScopedModelsPicker(payload) {
  const models = payload.models || [];
  const enabled = payload.enabled || [];
  const items = models.map((m) => {
    const id = `${m.provider}/${m.id}`;
    return {
      target: id,
      search: `${id} ${m.name}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(m.name)}</div>
          <div class="session-cwd">${escapeHtml(id)}</div>
        </div>
      `,
    };
  });
  openModal(items, {
    multi: true,
    initiallySelected: enabled,
    onCommit: (selected) => {
      send({ type: "slash_command", name: "scoped-models", arg: selected.join(",") });
    },
  });
}

function showHotkeysModal() {
  const items = [
    { keys: "Enter", desc: "Send / accept slash completion" },
    { keys: "Shift+Enter", desc: "Newline in input" },
    { keys: "Tab", desc: "Complete slash command" },
    { keys: "↑ / ↓", desc: "Navigate slash menu / picker" },
    { keys: "Esc", desc: "Abort running session / close picker" },
    { keys: "/", desc: "Open slash command list" },
  ].map((h) => ({
    target: h.keys,
    search: `${h.keys} ${h.desc}`,
    html: `
      <div>
        <div class="session-title">${escapeHtml(h.desc)}</div>
      </div>
      <div class="session-meta">${escapeHtml(h.keys)}</div>
    `,
  }));
  openModal(items, () => {});
}

function showTextModal(title, body) {
  modalDialog.classList.add("text-mode");
  modalTitle.textContent = title || "";
  modalBody.innerHTML = `<pre style="margin:0;padding:0.75rem;white-space:pre-wrap;word-break:break-word;color:var(--text);">${escapeHtml(body || "")}</pre>`;
  modal.hidden = false;
  modalDialog.tabIndex = -1;
  modalDialog.focus();
}

function showPromptModal(title, initialValue, onSubmit) {
  modalDialog.classList.add("prompt-mode");
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  const field = document.createElement("input");
  field.type = "text";
  field.className = "modal-prompt-input";
  field.value = initialValue ?? "";
  modalBody.appendChild(field);
  modal.hidden = false;
  field.focus();
  field.select();
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = field.value;
      closeModal();
      onSubmit?.(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    }
  });
}

async function handleSlashResult(data) {
  if (!data) return;
  if (data.copyText) {
    try {
      await navigator.clipboard.writeText(data.copyText);
      showToast("Copied to clipboard", "info");
    } catch {
      showToast("Clipboard write blocked by browser", "error");
    }
    return;
  }
  if (data.exportedTo) {
    showToast(`Exported (${data.format}): ${data.exportedTo}`, "info");
    return;
  }
  if (data.showHotkeys) {
    showHotkeysModal();
    return;
  }
  if (data.showText) {
    showTextModal(data.showText.title, data.showText.body);
    return;
  }
  if (typeof data.editorText === "string" && data.editorText.length > 0) {
    input.value = data.editorText;
    input.style.height = "36px";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    input.focus();
  }
  if (data.needsPicker === "session") return showSessionPicker(data);
  if (data.needsPicker === "model") return showModelPicker(data);
  if (data.needsPicker === "fork") return showForkPicker(data);
  if (data.needsPicker === "tree") return showTreePicker(data);
  if (data.needsPicker === "scoped-models") return showScopedModelsPicker(data);
  if (data.needsPicker === "logout") return showLogoutPicker(data);
}

function showLogoutPicker(payload) {
  const items = (payload.providers || []).map((p) => ({
    target: p,
    search: p,
    html: `<div><div class="session-title">${escapeHtml(p)}</div></div><div class="session-meta">remove credential</div>`,
  }));
  if (items.length === 0) {
    showToast("No providers to log out", "info");
    return;
  }
  openModal(items, (item) => {
    send({ type: "slash_command", name: "logout", arg: item.target });
  });
}

function showModelPicker(payload) {
  const models = payload.models || [];
  if (models.length === 0) {
    showToast("No models available", "info");
    return;
  }
  const items = models.map((m) => {
    const id = `${m.provider}/${m.id}`;
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "";
    return {
      target: id,
      current: id === payload.currentModel,
      search: `${id} ${m.name}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(m.name)}</div>
          <div class="session-cwd">${escapeHtml(id)}</div>
        </div>
        <div class="session-meta">${escapeHtml(ctx)}</div>
      `,
    };
  });
  openModal(items, (item) => {
    send({ type: "slash_command", name: "model", arg: item.target });
  });
}

function parseSlash(text) {
  const match = text.match(/^\/([^\s]*)(?:\s+(.*))?$/);
  if (!match) return null;
  return { name: match[1] || "", arg: match[2] ?? "" };
}

function renderSlashMenu() {
  slashMenu.innerHTML = "";
  let activeEl = null;
  slashFiltered.forEach((cmd, i) => {
    const el = document.createElement("div");
    el.className = `slash-item${i === slashIndex ? " active" : ""}${cmd.supported === false ? " unsupported" : ""}`;
    el.dataset.index = String(i);
    el.innerHTML = `<span class="name">/${escapeHtml(cmd.name)}</span><span class="desc">${escapeHtml(cmd.description || "")}</span>`;
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      slashIndex = i;
      applySlashSelection();
    });
    slashMenu.appendChild(el);
    if (i === slashIndex) activeEl = el;
  });
  slashMenu.hidden = slashFiltered.length === 0;
  activeEl?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const parsed = parseSlash(input.value);
  if (!parsed || parsed.arg) {
    slashFiltered = [];
    slashMenu.hidden = true;
    return;
  }
  const prefix = parsed.name.toLowerCase();
  slashFiltered = slashCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
  slashIndex = 0;
  renderSlashMenu();
}

function applySlashSelection() {
  const cmd = slashFiltered[slashIndex];
  if (!cmd) return;
  input.value = `/${cmd.name} `;
  slashFiltered = [];
  slashMenu.hidden = true;
  input.focus();
}

input.addEventListener("keydown", (event) => {
  if (event.key === "!" && input.value === "" && !event.isComposing) {
    event.preventDefault();
    setBashMode(!bashMode);
    return;
  }
  if (event.key === "Backspace" && input.value === "" && bashMode) {
    event.preventDefault();
    setBashMode(false);
    return;
  }
  if (!slashMenu.hidden && slashFiltered.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      slashIndex = (slashIndex + 1) % slashFiltered.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applySlashSelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      slashMenu.hidden = true;
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      const cmd = slashFiltered[slashIndex];
      if (cmd) {
        input.value = `/${cmd.name}`;
      }
      slashMenu.hidden = true;
      composer.requestSubmit();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
    return;
  }
  if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    if (input.selectionStart !== 0 || input.selectionEnd !== 0) return;
    event.preventDefault();
    if (inputHistory.length === 0 || inputHistoryIndex === 0) return;
    if (inputHistoryIndex === inputHistory.length) {
      inputHistoryDraft = input.value;
    }
    inputHistoryIndex -= 1;
    input.value = inputHistory[inputHistoryIndex] ?? "";
    resizeInput();
    input.setSelectionRange(0, 0);
    updateSlashMenu();
    return;
  }
  if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
    event.preventDefault();
    if (inputHistoryIndex >= inputHistory.length) return;
    inputHistoryIndex += 1;
    input.value =
      inputHistoryIndex >= inputHistory.length ? inputHistoryDraft : inputHistory[inputHistoryIndex];
    resizeInput();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    updateSlashMenu();
    return;
  }
});

let bashMode = false;
function setBashMode(on) {
  bashMode = on;
  composer.classList.toggle("bash-mode", on);
}

input.addEventListener("input", () => {
  resizeInput();
  inputHistoryIndex = inputHistory.length;
  updateSlashMenu();
});

const TEXT_MODAL_SCROLL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
]);

document.addEventListener("keydown", (event) => {
  if (!modal.hidden && modalDialog.classList.contains("text-mode")) {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (TEXT_MODAL_SCROLL_KEYS.has(event.key)) {
      const lineHeight = parseFloat(getComputedStyle(modalBody).lineHeight) || 18;
      const page = modalBody.clientHeight - lineHeight * 2;
      let dy = 0;
      switch (event.key) {
        case "ArrowDown": dy = lineHeight; break;
        case "ArrowUp":   dy = -lineHeight; break;
        case "PageDown":
        case " ":         dy = page; break;
        case "PageUp":    dy = -page; break;
        case "Home":      modalBody.scrollTop = 0; event.preventDefault(); return;
        case "End":       modalBody.scrollTop = modalBody.scrollHeight; event.preventDefault(); return;
      }
      modalBody.scrollTop += dy;
      event.preventDefault();
      return;
    }
  }
  // Page up/down scroll the chat log even when the input has focus.
  if ((event.key === "PageUp" || event.key === "PageDown") && modal.hidden) {
    const lineHeight = parseFloat(getComputedStyle(log).lineHeight) || 18;
    const page = log.clientHeight - lineHeight * 2;
    log.scrollTop += event.key === "PageDown" ? page : -page;
    event.preventDefault();
    return;
  }
  if (event.key !== "Escape") return;
  if (!modal.hidden) return;
  if (!slashMenu.hidden) return;
  if (chatState.isRunning) {
    event.preventDefault();
    send({ type: "abort" });
  }
});

// Refocus on mouseup, never mousedown. mousedown fires before the browser
// has resolved whether this is a click or the start of a drag-select; calling
// input.focus() at that point aborts an in-progress drag. mouseup fires after
// the selection range is finalized, and refocusInputIfIdle's selection-guard
// then preserves any text the user just selected.
document.addEventListener("mouseup", () => {
  refocusInputIfIdle();
});

input.addEventListener("blur", () => {
  slashMenu.hidden = true;
});

log.addEventListener("click", async (event) => {
  // Toggle button — switch between text and diff views.
  const toggleBtn = event.target.closest?.(".toggle-btn");
  if (toggleBtn && log.contains(toggleBtn)) {
    event.preventDefault();
    event.stopPropagation();
    const pre = toggleBtn.closest?.("pre");
    if (!pre) return;
    const currentView = pre.dataset.view;
    if (currentView === "single") return;
    const newView = currentView === "text" ? "diff" : "text";
    pre.dataset.view = newView;
    // Update active button styling.
    const toggles = pre.querySelector(".tool-result-toggles");
    if (toggles) {
      for (const btn of toggles.querySelectorAll(".toggle-btn")) {
        btn.classList.toggle("active", btn.dataset.view === newView);
      }
    }
    // Swap the code content. Diff view uses HTML so per-line color spans
    // render; text view is plain text.
    const codeEl = pre.querySelector("code");
    if (!codeEl) return;
    if (newView === "diff" && pre.dataset.diff) {
      codeEl.classList.add("diff-content");
      codeEl.innerHTML = formatDiffHtml(pre.dataset.diff);
    } else if (pre.dataset.text) {
      codeEl.classList.remove("diff-content");
      codeEl.textContent = pre.dataset.text;
    }
    return;
  }

  const btn = event.target.closest?.(".copy-btn");
  if (!btn || !log.contains(btn)) return;
  event.preventDefault();
  event.stopPropagation();

  const pre = btn.parentElement;
  const code = pre?.querySelector("code");
  if (!code) return;
  // Prefer the raw text/diff stored on the pre — when in diff view the code
  // contains <div> per-line elements whose textContent loses newlines.
  const view = pre?.dataset.view;
  const raw = view === "diff" ? pre?.dataset.diff : view === "text" ? pre?.dataset.text : null;
  const payload = raw ?? code.textContent ?? "";
  try {
    await navigator.clipboard.writeText(payload);
    showToast("Copied to clipboard", "info");
  } catch {
    showToast("Clipboard write blocked by browser", "error");
  }
});

function refocusInputIfIdle() {
  if (!modal.hidden) return;
  const active = document.activeElement;
  if (active === input) return;
  if (active && active.matches?.("input, textarea, select, [contenteditable]")) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
  input.focus();
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (chatState.isRunning) {
    logger.info("abort sent");
    send({ type: "abort" });
    return;
  }
  const raw = input.value;
  const message = raw.trim();
  if (!message || socket?.readyState !== WebSocket.OPEN) return;
  pushInputHistory(message);
  inputHistoryDraft = "";
  input.value = "";
  input.style.height = "36px";
  slashMenu.hidden = true;

  if (bashMode) {
    setBashMode(false);
    logger.info("bash sent", { length: message.length });
    appendOptimisticUserMessage(`!${message}`);
    send({ type: "bash", command: message });
    return;
  }

  const slash = parseSlash(message);
  if (slash) {
    if (slash.name === "name" && !slash.arg.trim()) {
      const current = currentSessionState?.sessionName || "";
      showPromptModal("Session name", current, (value) => {
        logger.info("slash sent", { name: "name" });
        send({ type: "slash_command", name: "name", arg: value });
      });
      return;
    }
    logger.info("slash sent", { name: slash.name, hasArg: slash.arg.length > 0 });
    send({ type: "slash_command", name: slash.name, arg: slash.arg });
    return;
  }

  logger.info("prompt sent", { length: message.length });
  appendOptimisticUserMessage(message);
  send({ type: "prompt", message });
});

function appendOptimisticUserMessage(text) {
  csSubmitUser(chatState, text);
  renderLog();
}

input.focus();
connect();
