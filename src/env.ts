/** Parse a numeric env var; garbage input falls back instead of becoming NaN. */
export function parseIntInRange(raw: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** Parse a numeric process env var; unset or garbage falls back. */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  return parseIntInRange(process.env[name] ?? "", fallback, min, max);
}
