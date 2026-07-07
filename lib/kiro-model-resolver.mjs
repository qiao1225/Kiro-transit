export function normalizeModelName(name) {
  if (!name) return name;

  let normalized = String(name).replace(/\[\d+[mk]\]$/i, "").toLowerCase();

  const standard = /^(claude-(?:haiku|sonnet|opus)-\d+)-(\d{1,2})(?:-(?:\d{8}|latest|\d+))?$/;
  let match = normalized.match(standard);
  if (match) return `${match[1]}.${match[2]}`;

  const noMinor = /^(claude-(?:haiku|sonnet|opus)-\d+)(?:-\d{8})?$/;
  match = normalized.match(noMinor);
  if (match) return match[1];

  const legacy = /^claude-(\d+)-(\d+)-(haiku|sonnet|opus)(?:-(?:\d{8}|latest|\d+))?$/;
  match = normalized.match(legacy);
  if (match) return `claude-${match[1]}.${match[2]}-${match[3]}`;

  const dotDate = /^(claude-(?:\d+\.\d+-)?(?:haiku|sonnet|opus)(?:-\d+\.\d+)?)-\d{8}$/;
  match = normalized.match(dotDate);
  if (match) return match[1];

  const inverted = /^claude-(\d+)\.(\d+)-(haiku|sonnet|opus)-(.+)$/;
  match = normalized.match(inverted);
  if (match) return `claude-${match[3]}-${match[1]}.${match[2]}`;

  return name;
}

export function toAnthropicModelId(kiroModelId) {
  if (!kiroModelId) return kiroModelId;
  if (kiroModelId === "auto" || kiroModelId === "auto-kiro") return "auto-kiro";
  return kiroModelId.replace(/(claude-(?:haiku|sonnet|opus)-\d+)\.(\d+)/g, "$1-$2");
}