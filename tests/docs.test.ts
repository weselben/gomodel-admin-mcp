/**
 * Live docs tools against the real GitHub repo. Skipped unless DOCS_E2E=1 —
 * the default run stays offline; `DOCS_E2E=1 bun test` opts in.
 */
import { describe, expect, test } from "bun:test";

import { startMcp } from "./helpers.mjs";

const LIVE = process.env.DOCS_E2E === "1";

describe.skipIf(!LIVE)("live docs tools (DOCS_E2E=1)", () => {
  test("docs_index lists pages", async () => {
    const mcp = await startMcp();
    try {
      const result = await mcp.call("docs_index", {});
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/\d+ pages/);
      expect(result.text).toContain('"path"');
    } finally {
      await mcp.close();
    }
  });

  test("docs_search finds ripgrep-style matches", async () => {
    const mcp = await startMcp();
    try {
      const result = await mcp.call("docs_search", { query: "model", max_results: 5 });
      expect(result.isError).toBe(false);
      expect(result.text).toMatch(/^docs\/\S+:\d+: /m);
    } finally {
      await mcp.close();
    }
  });

  test("docs_get fetches one page from the index", async () => {
    const mcp = await startMcp();
    try {
      const index = await mcp.call("docs_index", {});
      const first = JSON.parse(index.text.split("\n").slice(1).join("\n"))[0];
      expect(first.path).toBeTruthy();
      const page = await mcp.call("docs_get", { path: first.path });
      expect(page.isError).toBe(false);
      expect(page.text).toContain(`docs/${first.path}`);
    } finally {
      await mcp.close();
    }
  });
});
