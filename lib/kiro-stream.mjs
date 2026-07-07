function findMatchingBrace(text, startPos) {
  if (startPos >= text.length || text[startPos] !== "{") return -1;
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

const EVENT_PATTERNS = [
  ['{"content":', "content"],
  ['{"name":', "tool_start"],
  ['{"input":', "tool_input"],
  ['{"stop":', "tool_stop"],
  ['{"usage":', "usage"],
  ['{"contextUsagePercentage":', "context_usage"],
];

export class AwsEventStreamParser {
  constructor() {
    this.buffer = "";
    this.byteBuffer = Buffer.alloc(0);
    this.decoder = new TextDecoder("utf-8");
    this.lastContent = null;
    this.currentToolCall = null;
    this.toolCalls = [];
  }

  feed(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.byteBuffer = Buffer.concat([this.byteBuffer, bytes]);
    this.buffer += this.decoder.decode(bytes, { stream: true });
    const events = [];

    while (true) {
      let earliestPos = -1;
      let earliestType = null;

      for (const [pattern, eventType] of EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(pattern);
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos;
          earliestType = eventType;
        }
      }

      if (earliestPos === -1) break;

      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break;

      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);

      try {
        const data = JSON.parse(jsonStr);
        const event = this.processEvent(data, earliestType);
        if (event) events.push(event);
      } catch {
        // ignore malformed chunk
      }
    }

    return events;
  }

  flush() {
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    const events = [];
    while (true) {
      let earliestPos = -1;
      let earliestType = null;
      for (const [pattern, eventType] of EVENT_PATTERNS) {
        const pos = this.buffer.indexOf(pattern);
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos;
          earliestType = eventType;
        }
      }
      if (earliestPos === -1) break;
      const jsonEnd = findMatchingBrace(this.buffer, earliestPos);
      if (jsonEnd === -1) break;
      const jsonStr = this.buffer.slice(earliestPos, jsonEnd + 1);
      this.buffer = this.buffer.slice(jsonEnd + 1);
      try {
        const data = JSON.parse(jsonStr);
        const event = this.processEvent(data, earliestType);
        if (event) events.push(event);
      } catch {
        // ignore malformed chunk
      }
    }
    return events;
  }

  processEvent(data, eventType) {
    switch (eventType) {
      case "content":
        return this.processContent(data);
      case "tool_start":
        return this.processToolStart(data);
      case "tool_input":
        return this.processToolInput(data);
      case "tool_stop":
        return this.processToolStop(data);
      case "usage":
        return { type: "usage", data: data.usage ?? 0 };
      case "context_usage":
        return { type: "context_usage", data: data.contextUsagePercentage ?? 0 };
      default:
        return null;
    }
  }

  processContent(data) {
    const content = data.content || "";
    if (data.followupPrompt) return null;
    return { type: "content", data: content };
  }

  processToolStart(data) {
    if (this.currentToolCall) this.finalizeToolCall();

    let inputStr = "";
    const inputData = data.input ?? "";
    if (typeof inputData === "object") {
      inputStr = Object.keys(inputData).length ? JSON.stringify(inputData) : "";
    } else {
      inputStr = inputData ? String(inputData) : "";
    }

    this.currentToolCall = {
      id: data.toolUseId || `call_${cryptoRandom()}`,
      type: "function",
      function: {
        name: data.name || "",
        arguments: inputStr,
      },
    };

    if (data.stop) this.finalizeToolCall();
    return null;
  }

  processToolInput(data) {
    if (!this.currentToolCall) return null;
    const inputData = data.input ?? "";
    if (typeof inputData === "object") {
      if (Object.keys(inputData).length) {
        this.currentToolCall.function.arguments += JSON.stringify(inputData);
      }
    } else if (inputData) {
      this.currentToolCall.function.arguments += String(inputData);
    }
    return null;
  }

  processToolStop(data) {
    if (this.currentToolCall && data.stop) this.finalizeToolCall();
    return null;
  }

  finalizeToolCall() {
    if (!this.currentToolCall) return;
    const args = this.currentToolCall.function.arguments;
    if (typeof args === "string") {
      if (args.trim()) {
        try {
          this.currentToolCall.function.arguments = JSON.stringify(JSON.parse(args));
        } catch {
          this.currentToolCall.function.arguments = "{}";
        }
      } else {
        this.currentToolCall.function.arguments = "{}";
      }
    }
    this.toolCalls.push(this.currentToolCall);
    this.currentToolCall = null;
  }

  getToolCalls() {
    if (this.currentToolCall) this.finalizeToolCall();
    return dedupeToolCalls(this.toolCalls);
  }
}

function cryptoRandom() {
  return Math.random().toString(16).slice(2, 10);
}

function dedupeToolCalls(toolCalls) {
  const byIdentity = new Map();
  for (const tc of toolCalls) {
    const id = tc.id || "";
    const key = id ? `id:${id}` : `shape:${tc.function?.name || ""}:${tc.function?.arguments || "{}"}`;
    const existing = byIdentity.get(key);
    if (!existing || toolCallArgumentScore(tc) > toolCallArgumentScore(existing)) {
      byIdentity.set(key, tc);
    }
  }
  return [...byIdentity.values()];
}

function toolCallArgumentScore(toolCall) {
  const args = toolCall?.function?.arguments;
  if (!args || args === "{}") return 0;
  if (typeof args !== "string") return 1;
  return args.trim() && args.trim() !== "{}" ? args.length : 0;
}

const THINKING_OPEN = ["<thinking>", "<think>", "<reasoning>", "<thought>"];
const THINKING_CLOSE = {
  "<thinking>": "</thinking>",
  "<think>": "</think>",
  "<reasoning>": "</reasoning>",
  "<thought>": "</thought>",
};

export class ThinkingParser {
  constructor() {
    this.mode = "detect";
    this.openTag = null;
    this.buffer = "";
    this.thinking = "";
    this.regular = "";
  }

  feed(text) {
    const out = { thinking: "", regular: "" };
    let remaining = text;

    while (remaining) {
      if (this.mode === "detect") {
        this.buffer += remaining;
        const trimmed = this.buffer.trimStart();
        for (const tag of THINKING_OPEN) {
          if (trimmed.startsWith(tag)) {
            this.mode = "thinking";
            this.openTag = tag;
            this.buffer = trimmed.slice(tag.length);
            remaining = "";
            break;
          }
        }
        if (this.mode === "detect") {
          if (this.buffer.length > 80 || !this.looksLikeThinkingStart(this.buffer)) {
            out.regular += this.buffer;
            this.buffer = "";
            remaining = "";
          } else {
            remaining = "";
          }
        }
      } else if (this.mode === "thinking") {
        const closeTag = THINKING_CLOSE[this.openTag];
        const idx = remaining.indexOf(closeTag);
        if (idx === -1) {
          this.thinking += remaining;
          remaining = "";
        } else {
          this.thinking += remaining.slice(0, idx);
          out.thinking += this.thinking;
          this.thinking = "";
          remaining = remaining.slice(idx + closeTag.length);
          this.mode = "regular";
          this.openTag = null;
        }
      } else {
        out.regular += remaining;
        remaining = "";
      }
    }

    return out;
  }

  finalize() {
    const out = { thinking: "", regular: "" };
    if (this.mode === "thinking" && this.thinking) out.thinking = this.thinking;
    if (this.buffer) out.regular += this.buffer;
    this.buffer = "";
    return out;
  }

  looksLikeThinkingStart(buf) {
    const t = buf.trimStart();
    return THINKING_OPEN.some((tag) => tag.startsWith(t) || t.startsWith(tag.slice(0, Math.min(t.length, tag.length))));
  }
}

export async function* parseKiroStream(response) {
  const parser = new AwsEventStreamParser();
  const thinkingParser = new ThinkingParser();
  const body = response.body;
  const reader = body?.getReader ? body.getReader() : null;

  async function* readChunks() {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
      return;
    }
    for await (const chunk of body) {
      yield chunk;
    }
  }

  for await (const chunk of readChunks()) {
    for (const event of parser.feed(chunk)) {
      if (event.type === "content") {
        const parsed = thinkingParser.feed(event.data);
        if (parsed.thinking) yield { type: "thinking", content: parsed.thinking };
        if (parsed.regular) yield { type: "content", content: parsed.regular };
      } else if (event.type === "usage") {
        yield { type: "usage", usage: event.data };
      } else if (event.type === "context_usage") {
        yield { type: "context_usage", percentage: event.data };
      }
    }
  }

  for (const event of parser.flush()) {
    if (event.type === "content") {
      const parsed = thinkingParser.feed(event.data);
      if (parsed.thinking) yield { type: "thinking", content: parsed.thinking };
      if (parsed.regular) yield { type: "content", content: parsed.regular };
    }
  }

  const final = thinkingParser.finalize();
  if (final.thinking) yield { type: "thinking", content: final.thinking };
  if (final.regular) yield { type: "content", content: final.regular };

  for (const tc of parser.getToolCalls()) {
    yield { type: "tool_use", tool: tc };
  }
}
