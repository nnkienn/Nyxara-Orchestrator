export interface BoundedText {
  readonly value: string;
  readonly truncated: boolean;
}

/**
 * Truncates on a character boundary so the result stays valid UTF-8 and never
 * exceeds the byte budget the caller was given.
 */
export function truncateUtf8(value: string, maxBytes: number): BoundedText {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return { value: output, truncated: true };
}
