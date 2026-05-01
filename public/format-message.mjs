// Convert SDK content array to structured blocks. The SDK uses camelCase types
// (toolCall/toolResult); we normalize to snake_case for our renderer.
export function sdkContentToBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(content, null, 2) }];
  }
  return content.map((b) => {
    if (!b || typeof b !== "object") return { type: "text", text: String(b ?? "") };
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text || "" };
      case "thinking":
        return { type: "thinking", text: b.thinking || "" };
      case "image":
        return { type: "image", mimeType: b.mimeType };
      case "toolCall":
        return { type: "tool_call", name: b.name, input: b.arguments };
      case "toolResult":
        return {
          type: "tool_result",
          name: b.toolName || "result",
          result: { content: b.content, details: b.details },
        };
      default:
        return b; // pass through; renderBlocksHtml has a fallback
    }
  });
}

export function formatMessage(message) {
  switch (message.role) {
    case "user":
      return { kind: "user", title: "You", blocks: sdkContentToBlocks(message.content) };
    case "assistant":
      return { kind: "assistant", title: "Assistant", blocks: sdkContentToBlocks(message.content) };
    case "toolResult": {
      const name = message.toolName || "result";
      return {
        kind: "tool",
        title: `Tool result: ${name}`,
        blocks: [
          {
            type: "tool_result",
            name,
            result: { content: message.content, details: message.details },
          },
        ],
      };
    }
    case "bashExecution": {
      const text = `${message.output || ""}${message.exitCode !== undefined ? `\n\nexitCode: ${message.exitCode}` : ""}`.trim();
      return { kind: "tool", title: `Bash: ${message.command}`, blocks: [{ type: "text", text }] };
    }
    case "custom":
      return { kind: "custom", title: `Custom: ${message.customType}`, blocks: sdkContentToBlocks(message.content) };
    case "branchSummary":
      return { kind: "system", title: "Branch summary", blocks: [{ type: "text", text: message.summary || "" }] };
    case "compactionSummary":
      return { kind: "system", title: "Compaction summary", blocks: [{ type: "text", text: message.summary || "" }] };
    default:
      return {
        kind: "system",
        title: message.role || "Message",
        blocks: [{ type: "text", text: JSON.stringify(message, null, 2) }],
      };
  }
}
