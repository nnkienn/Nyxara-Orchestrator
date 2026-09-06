import { ProviderError } from "@nyxara/provider-sdk";

const MAX_EVENT_BYTES = 1024 * 1024;

/** Reads bounded SSE data frames without exposing or persisting raw payloads. */
export async function consumeSse(response: Response, providerId: string, onData: (data: string) => void): Promise<void> {
  if (!response.body) throw invalid(providerId, "Provider returned an empty event stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (Buffer.byteLength(frame, "utf8") > MAX_EVENT_BYTES) throw invalid(providerId, "Provider event exceeded the safe limit");
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) onData(data);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) throw invalid(providerId, "Provider event exceeded the safe limit");
      if (done) break;
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) onData(data);
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseJson(data: string, providerId: string): Record<string, unknown> | undefined {
  if (data === "[DONE]") return undefined;
  let value: unknown;
  try { value = JSON.parse(data); }
  catch { throw invalid(providerId, "Provider returned invalid streaming JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(providerId, "Provider returned an invalid stream event");
  return value as Record<string, unknown>;
}

function invalid(providerId: string, message: string): ProviderError {
  return new ProviderError(message, { code: "invalid_response", providerId });
}
