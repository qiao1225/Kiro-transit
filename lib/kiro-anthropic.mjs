import crypto from "node:crypto";
import { normalizeModelName, toAnthropicModelId } from "./kiro-model-resolver.mjs";

function extractAnthropicText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text || "";
        return "";
      })
      .join("");
  }
  return String(content);
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
      },
    }));
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: extractAnthropicText(block.content) || "(empty result)",
      is_error: Boolean(block.is_error),
    }));
}

function extractSystemPrompt(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (block?.type === "text" ? block.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(system);
}

function normalizeReasoningEffort(effort) {
  if (!effort) return "";
  const normalized = String(effort).trim().toLowerCase();
  if (normalized === "off" || normalized === "disabled" || normalized === "false") return "none";
  if (normalized === "min") return "minimal";
  if (normalized === "extra-high" || normalized === "extra_high") return "xhigh";
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)) return normalized;
  return "";
}

function inferReasoningEffortFromThinking(thinking, maxTokens) {
  if (!thinking || typeof thinking !== "object") return "";
  if (thinking.type === "disabled") return "none";
  if (thinking.type !== "enabled") return "";

  const budget = Number(thinking.budget_tokens || thinking.budgetTokens || 0);
  if (!Number.isFinite(budget) || budget <= 0) return "low";

  const limit = Math.max(1, Number(maxTokens) || 4096);
  const ratio = budget / limit;
  if (ratio <= 0.07) return "minimal";
  if (ratio <= 0.18) return "low";
  if (ratio <= 0.35) return "medium";
  if (ratio <= 0.6) return "high";
  if (ratio <= 0.8) return "xhigh";
  return "max";
}

export function anthropicRequestToOpenAi(body) {
  const messages = [];
  const systemPrompt = extractSystemPrompt(body.system);
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });

  for (const msg of body.messages || []) {
    const text = extractAnthropicText(msg.content);
    const entry = { role: msg.role, content: text };

    if (msg.role === "assistant") {
      const toolCalls = extractToolUses(msg.content);
      if (toolCalls.length) entry.tool_calls = toolCalls;
    }

    if (msg.role === "user") {
      const toolResults = extractToolResults(msg.content);
      if (toolResults.length) entry.tool_results = toolResults;
    }

    messages.push(entry);
  }

  const openAi = {
    model: normalizeModelName(body.model),
    messages,
    max_tokens: body.max_tokens,
    stream: Boolean(body.stream),
  };

  if (body.tools?.length) {
    openAi.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || {},
      },
    }));
  }

  const explicitEffort = normalizeReasoningEffort(body.reasoning_effort || body.reasoningEffort || body.effort);
  const thinkingEffort = inferReasoningEffortFromThinking(body.thinking, body.max_tokens || body.max_completion_tokens);
  if (explicitEffort || thinkingEffort) openAi.reasoning_effort = explicitEffort || thinkingEffort;

  return openAi;
}

export function generateAnthropicMessageId() {
  return `msg_${crypto.randomBytes(12).toString("hex")}`;
}

export function buildAnthropicMessageResponse({
  model,
  text = "",
  thinking = "",
  toolCalls = [],
  inputTokens = 0,
  outputTokens = 0,
}) {
  const content = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  for (const tool of toolCalls) {
    content.push({
      type: "tool_use",
      id: tool.id,
      name: tool.function?.name,
      input: tryParseJson(tool.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: generateAnthropicMessageId(),
    type: "message",
    role: "assistant",
    model: toAnthropicModelId(model),
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

function tryParseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

export function writeAnthropicStreamEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function startAnthropicStream(res, model) {
  const messageId = generateAnthropicMessageId();
  const anthropicModel = toAnthropicModelId(model);

  writeAnthropicStreamEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: anthropicModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  writeAnthropicStreamEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  return { messageId, anthropicModel };
}

// Emit a full tool_use content block over SSE. Kiro delivers tool calls fully
// formed (not incrementally), so we open the block, push the complete arguments
// as a single input_json_delta, then close it. This is spec-valid: Anthropic
// allows "one or more" content_block_delta events per block.
export function writeAnthropicToolUseBlock(res, index, tool) {
  const name = tool.function?.name || tool.name || "";
  const rawArgs = tool.function?.arguments ?? tool.input ?? "";
  const input = tryParseJson(rawArgs);
  writeAnthropicStreamEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: tool.id, name, input: {} },
  });
  writeAnthropicStreamEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  });
  writeAnthropicStreamEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

export function finishAnthropicStream(
  res,
  { anthropicModel, outputTokens = 0, inputTokens = 0, stopReason = "end_turn", toolCalls = [] } = {}
) {
  // Close the text content block opened at index 0.
  writeAnthropicStreamEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });

  // Emit any tool_use blocks at subsequent indices so agentic clients
  // (Claude Code) can actually invoke tools over a streamed response.
  toolCalls.forEach((tool, i) => {
    writeAnthropicToolUseBlock(res, i + 1, tool);
  });

  const finalStopReason = toolCalls.length ? "tool_use" : stopReason;
  const usage = { output_tokens: outputTokens };
  if (inputTokens) usage.input_tokens = inputTokens;

  writeAnthropicStreamEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: finalStopReason, stop_sequence: null },
    usage,
  });
  writeAnthropicStreamEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}
