import { describe, expect, test } from "bun:test";

import { homogenizeJson, homogenizeJsonWithinLimit } from "../src/homogenize.js";

describe("homogenizeJson", () => {
  test("pads missing keys with null and sorts the union of keys", () => {
    const input = JSON.stringify({
      entries: [
        { b: 2, a: 1 },
        { a: 3, c: 4 },
      ],
      total: 2,
    });
    expect(homogenizeJson(input)).toBe(
      JSON.stringify({
        entries: [
          { a: 1, b: 2, c: null },
          { a: 3, b: null, c: 4 },
        ],
        total: 2,
      }),
    );
  });

  test("recurses into nested arrays of objects", () => {
    const input = JSON.stringify([{ items: [{ x: 1 }, { y: 2 }] }]);
    expect(homogenizeJson(input)).toBe(
      JSON.stringify([{ items: [{ x: 1, y: null }, { x: null, y: 2 }] }]),
    );
  });

  test("leaves uniform rows byte-identical", () => {
    const input = JSON.stringify([{ a: 1 }, { a: 2 }]);
    expect(homogenizeJson(input)).toBe(input);
  });

  test("leaves scalar arrays, empty arrays, and single rows untouched", () => {
    for (const input of ["[1,2,3]", "[]", '[{"a":1}]', '[{"a":1},2]']) {
      expect(homogenizeJson(input)).toBe(input);
    }
  });

  test("preserves explicit null values", () => {
    const input = JSON.stringify([{ a: null, b: 1 }, { b: 2 }]);
    expect(homogenizeJson(input)).toBe(
      JSON.stringify([
        { a: null, b: 1 },
        { a: null, b: 2 },
      ]),
    );
  });

  test("passes non-JSON text through unchanged", () => {
    expect(homogenizeJson("not json at all")).toBe("not json at all");
    expect(homogenizeJson("{broken")).toBe("{broken");
  });

  test("output stays valid parseable JSON", () => {
    const input = JSON.stringify({ entries: [{ a: 1 }, { b: 2, c: [3] }] });
    expect(() => JSON.parse(homogenizeJson(input))).not.toThrow();
  });

  test("passes through input with integers beyond the exact range", () => {
    const input = '[{"id":9007199254740993,"a":1},{"id":9007199254740993,"b":2}]';
    expect(homogenizeJson(input)).toBe(input);
  });

  test("passes through non-array responses with unsafe integers", () => {
    const input = '{"total_tokens": 9007199254740993}';
    expect(homogenizeJson(input)).toBe(input);
  });

  test("digit runs inside strings do not trigger the unsafe-integer guard", () => {
    const input = '[{"id":"9007199254740993","a":1},{"id":"9007199254740993","b":2}]';
    expect(homogenizeJson(input)).toBe(
      JSON.stringify([
        { a: 1, b: null, id: "9007199254740993" },
        { a: null, b: 2, id: "9007199254740993" },
      ]),
    );
  });

  test("passes through exponent-form numbers that overflow to Infinity", () => {
    const input = '[{"usage":1e400,"a":1},{"usage":1e400,"b":2}]';
    expect(homogenizeJson(input)).toBe(input);
  });

  test("passes through ~309-digit integers without throwing", () => {
    const big = "1".repeat(309);
    const input = `[{"v":${big},"a":1},{"v":${big},"b":2}]`;
    expect(homogenizeJson(input)).toBe(input);
  });

  test("passes through raw_data payloads containing overflowing exponents", () => {
    const input =
      '[{"raw_data":{"latency":1e400,"name":"x"}},{"raw_data":{"latency":2.5,"name":"y"}}]';
    expect(homogenizeJson(input)).toBe(input);
  });
});

describe("homogenizeJsonWithinLimit", () => {
  const input = JSON.stringify([{ a: 1 }, { b: 2 }]);

  test("returns the homogenized form when it fits", () => {
    expect(homogenizeJsonWithinLimit(input, 1024)).toBe(homogenizeJson(input));
  });

  test("keeps the original when padding would cross the limit", () => {
    const homogenized = homogenizeJson(input);
    expect(homogenizeJsonWithinLimit(input, input.length)).toBe(input);
    expect(homogenized.length).toBeGreaterThan(input.length);
  });

  test("homogenizes even when both forms exceed the limit", () => {
    expect(homogenizeJsonWithinLimit(input, 4)).toBe(homogenizeJson(input));
  });

  test("measures the limit in UTF-8 bytes, not JavaScript string length", () => {
    const mb = JSON.stringify([{ a: "☃".repeat(7) }, { b: 1 }]);
    const homogenized = homogenizeJson(mb);
    // The homogenized JavaScript length fits 50, its UTF-8 bytes do not;
    // the original fits both — the byte cap must win.
    expect(homogenized.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(homogenized, "utf8")).toBeGreaterThan(50);
    expect(Buffer.byteLength(mb, "utf8")).toBeLessThanOrEqual(50);
    expect(homogenizeJsonWithinLimit(mb, 50)).toBe(mb);
  });
});
