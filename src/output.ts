/**
 * Shared output boundary for MCP text results. `normalizeOutput` is the one
 * normalizer for every complete-JSON tool payload: detect valid JSON, keep
 * invalid JSON and unsafe numbers untouched, homogenize object arrays, minify,
 * then apply the UTF-8 byte cap. Free text, errors, and SSE streams must go
 * through `truncate` only — never the JSON normalizer.
 */

import { homogenizeJsonWithinLimit } from "./homogenize.js";

export const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Parse `GOMODEL_MAX_OUTPUT_BYTES`. Only bare digits are accepted — empty,
 * negative, decimal, suffixed (`8MB`), or formatted (`1,048,576`) values
 * fall back to DEFAULT_MAX_BYTES so a typo can never zero the budget.
 * Valid numbers are clamped to 1024–8 MiB. Lets users on harnesses with
 * smaller tool-result caps get the clean marker instead of a mid-JSON cut
 * from their client.
 */
export function resolveMaxBytes(raw = process.env.GOMODEL_MAX_OUTPUT_BYTES ?? ""): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_BYTES;
  const value = Number.parseInt(trimmed, 10);
  return Math.min(Math.max(value, 1024), 8 * 1024 * 1024);
}

export const MAX_BYTES = resolveMaxBytes();

export function truncate(text: string, maxBytes: number = MAX_BYTES): string {
  // Measure in UTF-8 bytes: multibyte JSON must honor the cap even when its
  // JavaScript length fits, and the cut must never split a multibyte
  // character. The marker's own bytes are reserved so prefix + marker stays
  // within the cap; a cap smaller than the marker yields a UTF-8-safe marker
  // prefix so the guarantee holds for every cap. The marker itself stays
  // generic — pagination advice lives in the README, where there is room
  // to say which operations actually support limit/offset.
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = `\n\n[truncated: response exceeded ${maxBytes} bytes — narrow the query]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > maxBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(text, maxBytes - markerBytes)}${marker}`;
}

/** UTF-8-safe prefix of `text` within `maxBytes`, never splitting a character. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i) as number;
    const chLen = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (bytes + chLen > maxBytes) break;
    bytes += chLen;
    end = i + (cp > 0xffff ? 2 : 1);
    if (cp > 0xffff) i += 1;
  }
  return text.slice(0, end);
}

/** Normalize (homogenize + minify) a JSON payload, then bound it to `maxBytes`. */
export function normalizeOutput(text: string, maxBytes: number = MAX_BYTES): string {
  return truncate(homogenizeJsonWithinLimit(text, maxBytes), maxBytes);
}
