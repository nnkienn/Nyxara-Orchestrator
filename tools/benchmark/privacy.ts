const blockedKey = /(secret|api.?key|token.?value|prompt|response|source.?code|tool.?args|output.?body|file.?contents?)/i;
const credentialValues = () => Object.entries(process.env).filter(([key, value]) => value && /(secret|api.?key|credential|password|auth.?token)/i.test(key)).map(([, value]) => value!).filter(value => value.length >= 6);
export function sanitizeForReport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForReport);
  if (value && typeof value === "object") { const out: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) { if (!blockedKey.test(key)) out[key] = sanitizeForReport(item); } return out; }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string") { let safe = value; for (const credential of credentialValues()) safe = safe.replaceAll(credential, "[redacted]"); return safe; }
  return value;
}
