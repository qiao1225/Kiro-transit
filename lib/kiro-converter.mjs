import crypto from "node:crypto";
import { normalizeModelName } from "./kiro-model-resolver.mjs";



function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text") return item.text || "";
        if (item?.text) return item.text;
        return "";
      })
      .join("");
  }
  return String(content);
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value) && value.length === 0) continue;
    if (key === "additionalProperties") continue;
    if (key === "properties" && value && typeof value === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, typeof v === "object" ? sanitizeSchema(v) : v])
      );
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = sanitizeSchema(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => (typeof item === "object" ? sanitizeSchema(item) : item));
    } else {
      result[key] = value;
    }
  }
  return result;
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_REASONING_EFFORT = normalizeReasoningEffort(process.env.KIRO_DEFAULT_REASONING_EFFORT || "high");

function normalizeReasoningEffort(effort) {
  if (!effort) return "";
  const normalized = String(effort).trim().toLowerCase();
  if (normalized === "off" || normalized === "disabled" || normalized === "false") return "none";
  if (normalized === "min") return "minimal";
  if (normalized === "extra-high" || normalized === "extra_high") return "xhigh";
  if (REASONING_EFFORTS.has(normalized)) return normalized;
  return "";
}

function reasoningEffortToBudget(maxTokens, effort) {
  const normalized = normalizeReasoningEffort(effort) || DEFAULT_REASONING_EFFORT;
  if (normalized === "none") return 0;

  const tokenLimit = Math.max(1, Number(maxTokens) || 4096);
  const percent = {
    minimal: 0.05,
    low: 0.12,
    medium: 0.28,
    high: 0.45,
    xhigh: 0.65,
    max: 0.8,
  };
  const cap = {
    minimal: 256,
    low: 768,
    medium: 2048,
    high: 4096,
    xhigh: 8192,
    max: 12000,
  };

  const calculated = Math.floor(tokenLimit * (percent[normalized] ?? percent.low));
  return Math.max(0, Math.min(calculated, cap[normalized] ?? cap.low));
}

function injectThinkingTags(content, reasoningEffort, maxTokens) {
  const effort = normalizeReasoningEffort(reasoningEffort) || DEFAULT_REASONING_EFFORT;
  const budget = reasoningEffortToBudget(maxTokens || 4096, effort);
  if (!budget || budget < 64) return content;

  const instruction =
    "Think briefly and only when useful. Wrap private reasoning in <thinking>...</thinking>, then give the final answer.";
  return `<thinking_mode>enabled</thinking_mode>\n<reasoning_effort>${effort}</reasoning_effort>\n<max_thinking_length>${budget}</max_thinking_length>\n<thinking_instruction>${instruction}</thinking_instruction>\n\n${content}`;
}

function convertOpenAiMessages(messages) {
  let systemPrompt = "";
  const processed = [];
  let pendingToolResults = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += `${extractText(msg.content)}\n`;
      continue;
    }

    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: extractText(msg.content) || "(empty result)",
      });
      continue;
    }

    if (pendingToolResults.length) {
      processed.push({ role: "user", content: "", tool_results: [...pendingToolResults] });
      pendingToolResults = [];
    }

    if (msg.role === "assistant") {
      processed.push({
        role: "assistant",
        content: extractText(msg.content),
        tool_calls: msg.tool_calls || null,
      });
    } else if (msg.role === "user") {
      processed.push({
        role: "user",
        content: extractText(msg.content),
        tool_results: msg.tool_results || null,
      });
    }
  }

  if (pendingToolResults.length) {
    processed.push({ role: "user", content: "", tool_results: pendingToolResults });
  }

  return { systemPrompt: systemPrompt.trim(), messages: processed };
}

function convertTools(tools) {
  if (!tools?.length) return [];
  return tools
    .map((tool) => {
      const fn = tool.function || tool;
      const name = fn?.name || tool.name;
      if (!name) return null;
      const description = fn?.description || tool.description || `Tool: ${name}`;
      const parameters = sanitizeSchema(fn?.parameters || tool.input_schema || {});
      return {
        toolSpecification: {
          name,
          description,
          inputSchema: { json: parameters },
        },
      };
    })
    .filter(Boolean);
}

function toKiroToolResults(toolResults) {
  return (toolResults || [])
    .filter((tr) => tr?.tool_use_id)
    .map((tr) => ({
      content: [{ text: tr.content || "(empty result)" }],
      status: tr.is_error ? "error" : "success",
      toolUseId: tr.tool_use_id,
    }));
}

function toKiroToolUses(toolCalls) {
  const byId = new Map();

  for (const tc of toolCalls || []) {
    const fn = tc.function || {};
    const name = fn.name || tc.name || "";
    const toolUseId = tc.id || tc.toolUseId || "";
    if (!name || !toolUseId) continue;

    let input = {};
    try {
      input = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      input = {};
    }

    const current = {
      name,
      input,
      toolUseId,
    };

    const existing = byId.get(toolUseId);
    if (!existing || JSON.stringify(current.input).length > JSON.stringify(existing.input).length) {
      byId.set(toolUseId, current);
    }
  }

  return [...byId.values()];
}

function buildHistoryEntry(msg, modelId) {
  if (msg.role === "user") {
    const entry = {
      content: msg.content || (msg.tool_results?.length ? "(tool result)" : "(empty placeholder)"),
      modelId,
      origin: "AI_EDITOR",
    };
    const ctx = {};
    const toolResults = toKiroToolResults(msg.tool_results);
    if (toolResults.length) ctx.toolResults = toolResults;
    if (Object.keys(ctx).length) entry.userInputMessageContext = ctx;
    return { userInputMessage: entry };
  }

  const entry = { content: msg.content || (msg.tool_calls?.length ? "(tool request)" : "(empty placeholder)") };
  const toolUses = toKiroToolUses(msg.tool_calls);
  if (toolUses.length) entry.toolUses = toolUses;
  return { assistantResponseMessage: entry };
}

function ensureAlternating(messages) {
  if (messages.length < 2) return messages;
  const result = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const cur = messages[i];
    if (prev.role === "user" && cur.role === "user") {
      result.push({ role: "assistant", content: "(empty placeholder)" });
    }
    result.push(cur);
  }
  return result;
}

export function resolveModelId(model) {
  if (!model) return "claude-sonnet-4.5";
  if (model === "auto-kiro") return "auto";
  return normalizeModelName(model);
}

export function buildKiroPayload(request, profileArn) {
  const modelId = resolveModelId(request.model);
  const { systemPrompt, messages } = convertOpenAiMessages(request.messages || []);
  let merged = ensureAlternating(messages);

  if (!merged.length) throw new Error("No messages to send");
  if (merged[0].role !== "user") {
    merged = [{ role: "user", content: "(empty placeholder)" }, ...merged];
  }

  const historySource = merged.slice(0, -1);
  const current = merged[merged.length - 1];

  if (systemPrompt && historySource.length && historySource[0].role === "user") {
    historySource[0].content = `${systemPrompt}\n\n${historySource[0].content || ""}`.trim();
  }

  const history = historySource.map((m) => buildHistoryEntry(m, modelId));

  let currentContent = current.content || (current.tool_results?.length ? "(tool result)" : "(empty placeholder)");
  if (systemPrompt && history.length === 0) {
    currentContent = `${systemPrompt}\n\n${currentContent}`.trim();
  }

  if (current.role === "assistant") {
    history.push(buildHistoryEntry({ ...current, content: currentContent }, modelId));
    currentContent = "(empty placeholder)";
  }

  if (current.role === "user" && !current.tool_results?.length) {
    currentContent = injectThinkingTags(
      currentContent,
      request.reasoning_effort,
      request.max_tokens || request.max_completion_tokens || 4096
    );
  }

  const userInputMessage = {
    content: currentContent,
    modelId,
    origin: "AI_EDITOR",
  };

  const ctx = {};
  const kiroTools = convertTools(request.tools);
  const toolResults = toKiroToolResults(current.tool_results);
  if (kiroTools.length) ctx.tools = kiroTools;
  if (toolResults.length) ctx.toolResults = toolResults;
  if (Object.keys(ctx).length) userInputMessage.userInputMessageContext = ctx;

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: crypto.randomUUID(),
      currentMessage: { userInputMessage },
    },
  };

  if (history.length) payload.conversationState.history = history;
  if (profileArn) payload.profileArn = profileArn;

  return payload;
}

export function generateCompletionId() {
  return `chatcmpl-${crypto.randomBytes(12).toString("hex")}`;
}
