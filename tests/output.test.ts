import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_BYTES, MAX_BYTES, normalizeOutput, resolveMaxBytes, truncate } from "../src/output.js";

describe("truncate", () => {
  test("returns input unchanged when it fits", () => {
    expect(truncate("hello", 1024)).toBe("hello");
  });

  test("measures the cap in UTF-8 bytes, not JavaScript string length", () => {
    const snowmen = "☃".repeat(10); // 10 chars, 30 bytes
    expect(truncate(snowmen, 100)).toBe(snowmen);
    const cut = truncate("☃".repeat(100), 50); // 50 chars but 300 bytes
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(50);
    expect(cut).toContain("[truncated: response exceeded 50 bytes");
  });

  test("never splits a multibyte character", () => {
    const cut = truncate("ab" + "☃".repeat(100), 120);
    expect(cut.endsWith("�")).toBe(false);
    expect(cut.startsWith("ab")).toBe(true);
  });

  test("prefix + marker stays within the cap", () => {
    const input = "x".repeat(MAX_BYTES * 2);
    const cut = truncate(input);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });

  test("caps smaller than the marker still bound the result", () => {
    for (const cap of [0, 1, 10, 39]) {
      const cut = truncate("x".repeat(100), cap);
      expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(cap);
    }
  });

  test("the truncation marker points at pagination", () => {
    const cut = truncate("x".repeat(200), 120);
    expect(cut).toContain("limit/offset");
  });
});

describe("resolveMaxBytes", () => {
  test("defaults to 256 KiB when unset", () => {
    expect(resolveMaxBytes("")).toBe(DEFAULT_MAX_BYTES);
    expect(resolveMaxBytes(undefined)).toBe(DEFAULT_MAX_BYTES);
  });

  test("garbage input falls back to the default", () => {
    expect(resolveMaxBytes("abc")).toBe(DEFAULT_MAX_BYTES);
  });

  test("clamps into the sane range", () => {
    expect(resolveMaxBytes("1")).toBe(1024);
    expect(resolveMaxBytes("-5")).toBe(1024);
    expect(resolveMaxBytes("1.5")).toBe(1024);
    expect(resolveMaxBytes("4096")).toBe(4096);
    expect(resolveMaxBytes("999999999")).toBe(8 * 1024 * 1024);
  });
});

describe("normalizeOutput", () => {
  test("minifies pretty-printed JSON", () => {
    const pretty = JSON.stringify([{ a: 1 }, { a: 2 }], null, 2);
    expect(normalizeOutput(pretty)).toBe(JSON.stringify([{ a: 1 }, { a: 2 }]));
  });

  test("homogenizes sparse object arrays while minifying", () => {
    const pretty = JSON.stringify([{ a: 1 }, { b: 2 }], null, 2);
    expect(normalizeOutput(pretty)).toBe(
      JSON.stringify([
        { a: 1, b: null },
        { a: null, b: 2 },
      ]),
    );
  });

  test("passes non-JSON text through unchanged", () => {
    expect(normalizeOutput("plain text")).toBe("plain text");
  });

  test("passes JSON with unsafe numbers through unminified", () => {
    const input = '{\n  "id": 9007199254740993\n}';
    expect(normalizeOutput(input)).toBe(input);
  });

  test("keeps the original when padding would cross the byte cap", () => {
    const input = JSON.stringify([{ a: 1 }, { b: 2 }]);
    expect(normalizeOutput(input, input.length)).toBe(input);
  });
});
