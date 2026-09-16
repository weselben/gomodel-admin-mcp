import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startMock, startMcp } from "./helpers.mjs";

const SUMMARY_KEY = "GET /admin/usage/summary";

describe("read cache", () => {
  let mock, mcp;

  beforeAll(async () => {
    mock = await startMock();
    mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
  });

  afterAll(async () => {
    await Promise.all([mcp?.close(), mock?.close()]);
  });

  test("cache sequence", async () => {
    // Step 1: two calls -> second should be cache hit, count=1
    const r1 = await mcp.call("admin_usage", { operation: "get_usage_summary" });
    expect(r1.isError).toBe(false);

    const r2 = await mcp.call("admin_usage", { operation: "get_usage_summary" });
    expect(r2.isError).toBe(false);
    expect(r2.text).toContain("[cache hit: 30s TTL]");
    expect(mock.requests.get(SUMMARY_KEY)).toBe(1);

    // Step 2: third call with cache_bypass -> count becomes 2, no cache hit
    const r3 = await mcp.call("admin_usage", {
      operation: "get_usage_summary",
      params: { cache_bypass: true },
    });
    expect(r3.isError).toBe(false);
    expect(mock.requests.get(SUMMARY_KEY)).toBe(2);
    expect(r3.text).not.toContain("[cache hit:");

    // Step 3: write invalidates, then call -> count becomes 3, no cache hit
    const wp = await mcp.call("admin_virtual_models", {
      operation: "upsert_virtual_model",
      params: { source: "demo", target_model: "openai/gpt-4o" },
    });
    expect(wp.isError).toBe(false);

    const r4 = await mcp.call("admin_usage", { operation: "get_usage_summary" });
    expect(r4.isError).toBe(false);
    expect(mock.requests.get(SUMMARY_KEY)).toBe(3);
    expect(r4.text).not.toContain("[cache hit:");
  });
});