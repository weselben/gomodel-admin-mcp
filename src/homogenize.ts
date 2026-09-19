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
 * Two lossless-by-abstention guards: input containing numbers JSON cannot
 * round-trip — integers outside JavaScript's exact range (would round) or
 * exponent forms that overflow to Infinity (would serialize as null) —
 * passes through untouched, and homogenizeJsonWithinLimit falls back to the
 * original text when null padding would push an in-limit body over the byte
 * cap, so downstream truncation never slices JSON that previously fit.
 */

type JsonObject = Record<string, unknown>;

/** Matches a string literal or a number, so digit runs inside strings are ignored. */
const STRING_OR_NUMBER = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * True when the text holds a number JSON.parse cannot represent safely:
 * either an integer outside JavaScript's exact range (would round silently)
 * or an exponent form parsed as Infinity (would serialize as null).
 */
function hasUnsafeNumeric(text: string): boolean {
  for (const [token] of text.matchAll(STRING_OR_NUMBER)) {
    if (token.startsWith('"')) continue;
    const n = Number(token);
    // Exponent forms like 1e400 or a ~309-digit integer overflow to Infinity;
    // JSON.stringify would then emit null — a silent value change.
    if (!Number.isFinite(n)) return true;
    if (token.includes(".") || token.includes("e") || token.includes("E")) continue;
    if (token.replace(/^-/, "").length > 15 && BigInt(token) !== BigInt(n)) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively align multi-item object arrays to a sorted key union, padding missing values with null. */
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

/**
 * Parse and compactly reserialize JSON after recursively aligning multi-item
 * object arrays. Invalid JSON and input containing a number that cannot be
 * represented safely — an integer outside JavaScript's exact range, or an
 * exponent form that overflows to Infinity — passes through unchanged.
 */
export function homogenizeJson(text: string): string {
  if (hasUnsafeNumeric(text)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(homogenizeValue(parsed));
}

/**
 * Homogenize unless the original string fits `maxBytes` and the homogenized
 * string does not. Length is measured in UTF-8 bytes to match the caller's
 * truncation check; input already over the limit remains homogenized.
 */
export function homogenizeJsonWithinLimit(text: string, maxBytes: number): string {
  const homogenized = homogenizeJson(text);
  if (
    Buffer.byteLength(homogenized, "utf8") > maxBytes &&
    Buffer.byteLength(text, "utf8") <= maxBytes
  ) {
    return text;
  }
  return homogenized;
}
