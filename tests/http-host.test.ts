/**
 * HTTP host mode tests.
 *
 * Verifies the streamable-HTTP transport path in src/index.ts:
 *  (1) Wrong / missing bearer → 401
 *  (2) Off-path → 404
 *  (3) Authorized: initialize succeeds, tools/call on a _separate_ request
 *      works (stateless mode — fresh server per request).
 *  (4) No GOMODEL_HTTP_TOKEN → no port opened, child still running (stdio mode).
 *
 * Stateless SDK note: the MCP SDK's StreamableHTTPServerTransport builds a
 * fresh McpServer per request.  In stateless mode initialize() must complete
 * in one request; tools/call in a separate request works because the SDK
 * registers tools eagerly (not lazily on init).  A batched [initialize,
 * notification, tools/call] fails with -32600 because the SDK marks itself
 * _initialized mid-batch and then rejects the remaining methods.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { spawn, ChildProcess } from "node:child_process";
import { startMock, httpRpc } from "./helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

describe("HTTP host mode", () => {
  const children: ChildProcess[] = [];

  /** Kill + await a spawned child so no MCP process outlives its test.
   *  Note: a signal-killed child keeps exitCode null — check signalCode too. */
  async function stopChild(process_: ChildProcess | null) {
    if (!process_ || process_.exitCode !== null || process_.signalCode !== null) return;
    process_.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((r) => process_.on("exit", () => r())),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }

  /** Spawn the MCP server in HTTP host mode and wait for its port. */
  async function startHost(mockUrl: string, port: number, httpToken: string | null = "test_http_token") {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GOMODEL_BASE_URL: mockUrl,
      GOMODEL_ADMIN_API_KEY: "sk_gom_test",
      HOST: "127.0.0.1",
      PORT: String(port),
    };
    if (httpToken !== null) env.GOMODEL_HTTP_TOKEN = httpToken;
    const child = spawn("bun", ["dist/index.js"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", () => {}); // discard startup banner
    children.push(child);
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/mcp`);
        break;
      } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    return child;
  }

  afterAll(async () => {
    for (const child of children) await stopChild(child);
  });

  /* ---------------------------------------------------------------- */
  /* (1) No / wrong bearer -> 401 (from the MCP host, not the mock)   */
  /* ---------------------------------------------------------------- */

  test("wrong bearer token -> 401 unauthorized", async () => {
    const mock = await startMock();
    const port = 3955 + (process.pid || 0) % 100;
    let child: ChildProcess | null = null;
    try {
      child = await startHost(mock.url, port);
      const res = await httpRpc(`http://127.0.0.1:${port}`, "initialize", {}, "wrong_token");
      expect(res.status).toBe(401);
    } finally {
      await stopChild(child);
      mock.close();
    }
  });

  /* ---------------------------------------------------------------- */
  /* (2) Off-path -> 404 (fetch without auth on MCP server endpoint) */
  /* ---------------------------------------------------------------- */

  test("off-path -> 404", async () => {
    const mock = await startMock();
    const port = 3960 + (process.pid || 0) % 100;
    let child: ChildProcess | null = null;
    try {
      child = await startHost(mock.url, port);
      // GET /other without auth → 404 (path check is before auth check)
      const res = await fetch(`http://127.0.0.1:${port}/other`);
      expect(res.status).toBe(404);
    } finally {
      await stopChild(child);
      mock.close();
    }
  });

  /* ---------------------------------------------------------------- */
  /* (3) Authorized: initialize + tools/call (stateless mode)        */
  /* ---------------------------------------------------------------- */

  test("authorized: initialize -> server info, tools/call on separate request works", async () => {
    const mock = await startMock();
    const port = 3965 + (process.pid || 0) % 100;
    let child: ChildProcess | null = null;
    try {
      child = await startHost(mock.url, port);
      // 1) initialize -> server name
      const initRes = await httpRpc(
        `http://127.0.0.1:${port}`,
        "initialize",
        { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
      );
      expect(initRes.status).toBe(200);
      expect(initRes.payload.result?.serverInfo?.name).toBe("gomodel-admin-mcp");

      // 2) tools/call on a SEPARATE request (stateless mode: fresh server each request).
      //    Since the MCP server is stateless (new McpServer + transport per HTTP request),
      //    the tools are eagerly registered by buildServer(). The SDK does NOT require
      //    a prior initialize() for tools/call to succeed in stateless mode — tools are
      //    available immediately.  However, the batched [initialize, tools/call] pattern
      //    fails (-32600) because the SDK marks itself _initialized mid-batch and then
      //    rejects subsequent methods.  Separate requests work fine.
      const callRes = await httpRpc(
        `http://127.0.0.1:${port}`,
        "tools/call",
        { name: "admin_usage", arguments: { operation: "get_usage_summary" } },
      );
      expect(callRes.status).toBe(200);
      expect(callRes.payload?.result?.content).toBeDefined();
      expect(callRes.payload?.result?.content?.[0]?.type).toBe("text");
      const callText = callRes.payload?.result?.content?.[0]?.text ?? "";
      expect(callText).not.toContain("Error");
      // Response contains usage summary fields
      expect(callText).toContain("total_requests");

      // 3) get_server_info also works
      const infoRes = await httpRpc(
        `http://127.0.0.1:${port}`,
        "tools/call",
        { name: "get_server_info", arguments: {} },
      );
      expect(infoRes.status).toBe(200);
      const infoText = infoRes.payload?.result?.content?.[0]?.text ?? "";
      const infoObj = JSON.parse(infoText);
      expect(infoObj.mode).toBe("full");
      expect(infoObj.transport).toBe("http");
      expect(infoObj.read_groups).toBe(9);
      expect(infoObj.write_groups).toBe(10);
      expect(infoObj.total_tools).toBe(23);
    } finally {
      await stopChild(child);
      mock.close();
    }
  });

  // SDK behavior: a batched [initialize, notif/initialized, tools/call] in ONE
  // POST is rejected with -32600 "Only one initialization request is allowed" —
  // the stateless transport processes initialize mid-batch, marks itself
  // initialized, then rejects the remaining methods. Separate requests are the
  // correct pattern for stateless mode (covered by the test above).
  test("batched [initialize, notification, tools/call] -> 400 -32600", async () => {
    const mock = await startMock();
    const port = 3970 + (process.pid || 0) % 100;
    let child: ChildProcess | null = null;
    try {
      child = await startHost(mock.url, port);
      const batch = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_server_info", arguments: {} } },
      ];
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test_http_token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(batch),
      });
      expect(res.status).toBe(400);
      const payload = await res.json() as { error?: { code?: number } };
      expect(payload.error?.code).toBe(-32600);
    } finally {
      await stopChild(child);
      mock.close();
    }
  });

  /* ---------------------------------------------------------------- */
  /* (4) No GOMODEL_HTTP_TOKEN -> no port open, child still running   */
  /* ---------------------------------------------------------------- */

  test("no GOMODEL_HTTP_TOKEN -> no port open, child still running", async () => {
    const child = spawn("bun", ["dist/index.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        GOMODEL_ADMIN_API_KEY: "sk_gom_test",
        HOST: "127.0.0.1",
        PORT: "3999",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {});
    children.push(child);

    try {
      // must fail to connect — no port opened without GOMODEL_HTTP_TOKEN
      await expect(
        fetch("http://127.0.0.1:3999/mcp", { signal: AbortSignal.timeout(2000) }),
      ).rejects.toThrow();

      // child still running
      await new Promise((r) => setTimeout(r, 500));
      expect(child.exitCode).toBeNull();
    } finally {
      await stopChild(child);
    }
  });
});
