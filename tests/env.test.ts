import { describe, expect, test } from "bun:test";

import { envInt, parseIntInRange } from "../src/env.js";

describe("parseIntInRange", () => {
  test("empty and non-numeric input falls back", () => {
    for (const raw of ["", "abc"]) {
      expect(parseIntInRange(raw, 1800, 60, 86400)).toBe(1800);
    }
  });

  test("numeric prefixes parse, then clamp", () => {
    expect(parseIntInRange("300x", 1800, 60, 86400)).toBe(300);
    expect(parseIntInRange("1.5", 1800, 60, 86400)).toBe(60);
  });

  test("numbers clamp into range", () => {
    expect(parseIntInRange("0", 1800, 60, 86400)).toBe(60);
    expect(parseIntInRange("-5", 1800, 60, 86400)).toBe(60);
    expect(parseIntInRange("1800", 1800, 60, 86400)).toBe(1800);
    expect(parseIntInRange("999999999", 1800, 60, 86400)).toBe(86400);
  });
});

describe("envInt", () => {
  test("reads, falls back, and restores the env var", () => {
    const name = "GOMODEL_TEST_ENV_INT";
    const saved = process.env[name];
    delete process.env[name];
    try {
      expect(envInt(name, 42, 1, 100)).toBe(42);
      process.env[name] = "77";
      expect(envInt(name, 42, 1, 100)).toBe(77);
      process.env[name] = "garbage";
      expect(envInt(name, 42, 1, 100)).toBe(42);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});
