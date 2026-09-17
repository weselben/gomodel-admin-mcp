/**
 * Homogenize JSON tool output so gateway-side prompt compression (GoModel
 * Pro's reversible JSON-table encoding) can fire on list responses. The
 * encoder only rewrites arrays of objects with a uniform key set; upstream
 * handlers emit sparse rows (optional fields omitted), which disqualifies
 * whole lists like /admin/usage/log entries.
 *
 * For every array of plain objects, rows are rewritten to the sorted union
 * of all keys, missing keys padded with null. Values are never changed, but
 * absent and null become indistinguishable. Non-JSON input passes through.
 *
 * Two lossless-by-abstention guards: input containing integers outside
 * JavaScript's exact range passes through untouched (JSON.parse would round
 * them), and homogenizeJsonWithinLimit falls back to the original text when
 * null padding would push an in-limit body over the byte cap, so downstream
 * truncation never slices JSON that previously fit.
 */

type JsonObject = Record<string, unknown>;

/** Matches a string literal or a number, so digit runs inside strings are ignored. */
const STRING_OR_NUMBER = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** True when the text holds an integer JSON.parse cannot represent exactly. */
function hasUnsafeInteger(text: string): boolean {
  for (const [token] of text.matchAll(STRING_OR_NUMBER)) {
    if (token.startsWith('"') || token.includes(".") || token.includes("e") || token.includes("E")) {
      continue;
    }
    if (token.replace(/^-/, "").length > 15 && BigInt(token) !== BigInt(Number(token))) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homogenizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(homogenizeValue);
    if (items.length > 1 && items.every(isPlainObject)) {
      const keys = [...new Set(items.flatMap((item) => Object.keys(item)))].sort();
      return items.map((item) => Object.fromEntries(keys.map((key) => [key, item[key] ?? null])));
    }
    return items;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, homogenizeValue(v)]));
  }
  return value;
}

/** Parse, homogenize, and re-stringify compactly; passthrough on non-JSON
 *  and on any input holding an integer beyond the exact range. */
export function homogenizeJson(text: string): string {
  if (hasUnsafeInteger(text)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(homogenizeValue(parsed));
}

/** Homogenize, but keep the original text when it fits maxBytes and the
 *  padded form does not — truncation after this must not break valid JSON
 *  that fit before padding. Oversized input stays the caller's problem. */
export function homogenizeJsonWithinLimit(text: string, maxBytes: number): string {
  const homogenized = homogenizeJson(text);
  if (homogenized.length > maxBytes && text.length <= maxBytes) return text;
  return homogenized;
}
