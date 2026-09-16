import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startMock, startMcp } from "../tests/helpers.mjs";

describe("dispatch", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let mcp: Awaited<ReturnType<typeof startMcp>>;

  beforeAll(async () => {
    mock = await startMock();
    mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
  });

  afterAll(async () => {
    await mcp.close();
    await mock.close();
  });

  test("admin_usage with no operation lists all 8 ops", async () => {
    const result = await mcp.call("admin_usage");
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^Operations of admin_usage:/);
    for (const op of [
      "get_usage_summary",
      "get_usage_daily",
      "get_usage_by_model",
      "get_usage_by_user_path",
      "get_usage_by_label",
      "get_usage_by_session",
      "get_usage_log",
      "get_token_throughput",
    ]) {
      expect(result.text).toContain(op);
    }
  });

  test("unknown operation returns isError with valid op name", async () => {
    const result = await mcp.call("admin_usage", { operation: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown operation "nope"');
    expect(result.text).toContain("get_usage_summary");
  });

  test("field-level invalid params: required amount on upsert_budget", async () => {
    const result = await mcp.call("admin_governance_control", {
      operation: "upsert_budget",
      params: {},
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid params for upsert_budget");
    expect(result.text).toContain("amount");
  });

  test("strict unknown keys rejected", async () => {
    const result = await mcp.call("admin_governance_control", {
      operation: "upsert_budget",
      params: { amount: 1, bogus_key: "x" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("bogus_key");
  });

  test("cache_bypass is stripped, not validated", async () => {
    const result = await mcp.call("admin_cache", {
      operation: "get_cache_overview",
      params: { cache_bypass: true },
    });
    expect(result.isError).toBe(false);
  });

  test("get_live_logs SSE returns events", async () => {
    const result = await mcp.call("admin_audit", {
      operation: "get_live_logs",
      params: { seconds: "1" },
    });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/event: log|data:/);
  });

  test("path param op: get_workflow returns JSON", async () => {
    const result = await mcp.call("admin_workflows", {
      operation: "get_workflow",
      params: { id: "demo" },
    });
    expect(result.isError).toBe(false);
    JSON.parse(result.text);
  });
});
