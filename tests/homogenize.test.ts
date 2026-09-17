import { describe, expect, test } from "bun:test";

import { homogenizeJson } from "../src/homogenize.js";

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
});
