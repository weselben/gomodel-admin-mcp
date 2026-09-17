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
 */

type JsonObject = Record<string, unknown>;

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

/** Parse, homogenize, and re-stringify compactly; passthrough on non-JSON. */
export function homogenizeJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(homogenizeValue(parsed));
}
