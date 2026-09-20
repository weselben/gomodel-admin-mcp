/**
 * Shared output boundary for MCP text results. `normalizeOutput` is the one
 * normalizer for every complete-JSON tool payload: detect valid JSON, keep
 * invalid JSON and unsafe numbers untouched, homogenize object arrays, minify,
 * then apply the UTF-8 byte cap. Free text, errors, and SSE streams must go
 * through `truncate` only — never the JSON normalizer.
 */

import { homogenizeJsonWithinLimit } from "./homogenize.js";

export const MAX_BYTES = 256 * 1024;

export function truncate(text: string, maxBytes: number = MAX_BYTES): string {
  // Measure in UTF-8 bytes: multibyte JSON must honor the cap even when its
  // JavaScript length fits, and the cut must never split a multibyte
  // character. The marker's own bytes are reserved so prefix + marker stays
  // within the cap.
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = `\n\n[truncated: response exceeded ${maxBytes} bytes]`;
  const limit = maxBytes - Buffer.byteLength(marker, "utf8");
  let bytes = 0;
  let end = 0;
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i) as number;
    const chLen = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (bytes + chLen > limit) break;
    bytes += chLen;
    end = i + (cp > 0xffff ? 2 : 1);
    if (cp > 0xffff) i += 1;
  }
  return `${text.slice(0, end)}${marker}`;
}

/** Normalize (homogenize + minify) a JSON payload, then bound it to `maxBytes`. */
export function normalizeOutput(text: string, maxBytes: number = MAX_BYTES): string {
  return truncate(homogenizeJsonWithinLimit(text, maxBytes), maxBytes);
}
