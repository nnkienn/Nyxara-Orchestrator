const blockedKey = /(secret|api.?key|token.?value|prompt|response|source.?code|tool.?args|output.?body|file.?contents?)/i;
export function sanitizeForReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForReport);
  if (value && typeof value === "object") { const out: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { if (!blockedKey.test(key)) out[key] = sanitizeForReport(item); } return out; }
  return value;
}
