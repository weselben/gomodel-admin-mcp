import { describe, test, expect } from "bun:test";
import { startMock, startMcp } from "./helpers.mjs";

describe("error handling", () => {
  test("fault 500 on usage summary", async () => {
    const mock = await startMock();
    try {
      process.env.MOCK_FAULT = "GET /admin/usage/summary=500";
      const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
      try {
        const res = await mcp.call("admin_usage", { operation: "get_usage_summary" });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("admin API 500");
        expect(res.text).toContain('"type":"internal_error"');
        expect(res.text).toContain('"code":"internal"');
      } finally {
        delete process.env.MOCK_FAULT;
        await mcp.close();
      }
    } finally {
      await mock.close();
    }
  });

  test("fault 503 on cache overview", async () => {
    const mock = await startMock();
    try {
      process.env.MOCK_FAULT = "GET /admin/cache/overview=503";
      const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
      try {
        const res = await mcp.call("admin_cache", { operation: "get_cache_overview" });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("feature_unavailable");
      } finally {
        delete process.env.MOCK_FAULT;
        await mcp.close();
      }
    } finally {
      await mock.close();
    }
  });

  test("401 with wrong API key", async () => {
    const mock = await startMock();
    try {
      const mcp1 = await startMcp({ GOMODEL_BASE_URL: mock.url });
      const mcp2 = await startMcp({
        GOMODEL_BASE_URL: mock.url,
        GOMODEL_ADMIN_API_KEY: "sk_gom_wrong",
      });
      try {
        await mcp1.call("admin_usage", { operation: "get_usage_summary" });
        const res = await mcp2.call("admin_usage", { operation: "get_usage_summary" });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("401");
        expect(res.text).toContain("authentication_error");
      } finally {
        await mcp1.close();
        await mcp2.close();
      }
    } finally {
      await mock.close();
    }
  });

  test("scoped key 403 on global route, non-error on user-path route", async () => {
    const mock = await startMock();
    try {
      const mcp = await startMcp({
        GOMODEL_BASE_URL: mock.url,
        GOMODEL_ADMIN_API_KEY: "sk_gom_up_scoped",
      });
      try {
        const globalRes = await mcp.call("admin_cache", {
          operation: "get_cache_overview",
        });
        expect(globalRes.isError).toBe(true);
        expect(globalRes.text).toContain("admin_scope_denied");
        expect(globalRes.text).toContain("403");

        const userRes = await mcp.call("admin_usage", {
          operation: "get_usage_summary",
        });
        expect(userRes.isError).toBe(false);
        expect(userRes.text).toBeTruthy();
      } finally {
        await mcp.close();
      }
    } finally {
      await mock.close();
    }
  });

  test("truncation with huge response", async () => {
    const mock = await startMock();
    try {
      process.env.MOCK_HUGE = "1";
      const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
      try {
        const res = await mcp.call("admin_usage", { operation: "get_usage_summary" });
        expect(res.isError).toBe(false);
        expect(res.text).toContain("[truncated: response exceeded 262144 bytes]");
      } finally {
        delete process.env.MOCK_HUGE;
        await mcp.close();
      }
    } finally {
      await mock.close();
    }
  });

  test("mock down — connection refused", async () => {
    const mcp = await startMcp({ GOMODEL_BASE_URL: "http://127.0.0.1:9" });
    try {
      const res = await mcp.call("admin_usage", { operation: "get_usage_summary" });
      expect(res.isError).toBe(true);
      expect(res.text.startsWith("Error:")).toBe(true);
      expect(res.text.toLowerCase()).not.toContain("stack trace");
      expect(res.text.toLowerCase()).not.toContain("unhandled");
    } finally {
      await mcp.close();
    }
  });

  test("404 unknown resource via workflows", async () => {
    const mock = await startMock();
    try {
      const mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });
      try {
        const res = await mcp.call("admin_workflows", {
          operation: "get_workflow",
          params: { id: "missing" },
        });
        expect(res.isError).toBe(true);
        expect(res.text).toContain("404");
        expect(res.text).toContain("not_found");
      } finally {
        await mcp.close();
      }
    } finally {
      await mock.close();
    }
  });
});
