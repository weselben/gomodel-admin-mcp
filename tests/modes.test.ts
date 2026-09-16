/**
 * modes.test — tool registration gating per mode.
 *
 * Full       (key set)           -> 23 tools
 * Read-only  (READ_ONLY=1)       -> 13 tools
 * Docs-only  (key="")            -> 4 tools
 *
 * Also exercises get_server_info JSON payload in each mode.
 */
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { createMockServer } from "./mock-server.mjs";

/* ------------------------------------------------------------------ */
/* Minimal stdio JSON-RPC client — mirrors helpers.mjs design          */
/* ------------------------------------------------------------------ */

function createMcpClient(opts: {
  env?: Record<string, string>;
  baseDir: string;
  mockUrl?: string;
} = {}): {
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  listTools(): Promise<any[]>;
  serverInfo: any;
  child: ReturnType<typeof spawn>;
  close(): void;
  init(): Promise<void>;
} {
  const { env: extraEnv = {}, baseDir, mockUrl = "" } = opts;
  const bunPath = process.env.BUN_BIN ?? Bun.which("bun") ?? "bun";

  const child = spawn(bunPath, ["dist/index.js"], {
    cwd: baseDir,
    env: {
      ...process.env,
      GOMODEL_ADMIN_API_KEY: "sk_gom_test",
      GOMODEL_BASE_URL: mockUrl,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // discard startup banner

  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, (msg: any) => void>();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const fn = pending.get(msg.id);
        if (fn) {
          pending.delete(msg.id);
          fn(msg);
        }
      } catch {
        // non-JSON stdout line — ignore
      }
    }
  });

  const request = (method: string, params: object): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  return {
    call(name: string, args: Record<string, unknown> = {}) {
      return request("tools/call", { name, arguments: args }).then(
        (msg: any) => {
          if (msg.error) {
            throw new Error(`tools/call ${name} failed: ${msg.error.message}`);
          }
          const content = msg.result?.content ?? [];
          return {
            isError: msg.result?.isError === true,
            text: content.map((c: any) => c.text ?? "").join("\n"),
          };
        },
      );
    },
    listTools() {
      return request("tools/list", {}).then(
        (msg: any) => msg.result?.tools ?? [],
      );
    },
    serverInfo: null as any,
    child,
    initialized: false,
    /** Call after creation to do initialize + notifications/initialized. */
    async init() {
      const initMsg = await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "e2e-test", version: "0.0.0" },
      });
      this.serverInfo = initMsg.result?.serverInfo ?? null;
      // Send notifications/initialized (required by MCP spec).
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      this.initialized = true;
    },
    close() {
      child.kill("SIGKILL");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("modes", () => {
  let mock: Awaited<ReturnType<typeof createMockServer>>;
  let mcp: ReturnType<ReturnType<typeof createMcpClient>>;
  let baseDir: string;
  let mockUrl: string;

  beforeEach(async () => {
    baseDir = new URL("..", import.meta.url).pathname;
    mock = createMockServer();
    mockUrl = await mock.listen();
    mcp = createMcpClient({ baseDir, mockUrl });
    await mcp.init();
  });

  afterEach(() => {
    mcp.close();
    mock.close();
  });

  /* ------------------------------------------------------------------ */
  /* 1. Full mode — 23 tools                                             */
  /* ------------------------------------------------------------------ */

  test("full mode: 23 tools, names include admin_runtime, admin_runtime_control, get_server_info, docs_index, docs_search, docs_get", async () => {
    const tools = await mcp.listTools();
    const names = tools.map((t: any) => t.name);

    expect(names).toHaveLength(23);

    const expected = [
      "admin_runtime",
      "admin_runtime_control",
      "get_server_info",
      "docs_index",
      "docs_search",
      "docs_get",
    ];
    for (const exp of expected) {
      expect(names).toContain(exp);
    }

    // All admin_* tools present (9 read + 10 write groups = 19)
    const adminTools = names.filter((n) => n.startsWith("admin_"));
    expect(adminTools.length).toBe(19);
  });

  /* ------------------------------------------------------------------ */
  /* 2. Read-only — 13 tools                                             */
  /* ------------------------------------------------------------------ */

  test("read-only: 13 tools, no write groups", async () => {
    const ro = createMcpClient({
      baseDir,
      mockUrl,
      env: { GOMODEL_READ_ONLY: "1" },
    });
    await ro.init();

    try {
      const tools = await ro.listTools();
      const names = tools.map((t: any) => t.name);

      expect(names).toHaveLength(13);

      // No write-group tools
      const writeGroupNames = [
        "admin_runtime_control",
        "admin_auth_keys",
        "admin_virtual_models",
        "admin_pricing_overrides",
        "admin_rate_limits",
        "admin_workflows_control",
        "admin_mcp_servers_control",
        "admin_governance_control",
        "admin_provider_control",
        "admin_usage_control",
      ];
      for (const wn of writeGroupNames) {
        expect(names).not.toContain(wn);
      }

      // All read-group tools present
      const readGroupNames = [
        "admin_runtime",
        "admin_usage",
        "admin_audit",
        "admin_cache",
        "admin_models",
        "admin_providers",
        "admin_governance",
        "admin_workflows",
        "admin_mcp_servers",
      ];
      for (const rn of readGroupNames) {
        expect(names).toContain(rn);
      }
    } finally {
      ro.close();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 3. Docs-only — 4 tools                                              */
  /* ------------------------------------------------------------------ */

  test("docs-only: 4 tools, no admin_* tools", async () => {
    const dc = createMcpClient({
      baseDir,
      mockUrl,
      env: { GOMODEL_ADMIN_API_KEY: "" },
    });
    await dc.init();

    try {
      const tools = await dc.listTools();
      const names = tools.map((t: any) => t.name);

      expect(names).toHaveLength(4);
      expect(names).toContain("docs_index");
      expect(names).toContain("docs_search");
      expect(names).toContain("docs_get");
      expect(names).toContain("get_server_info");
      expect(names.filter((n) => n.startsWith("admin_")).length).toBe(0);
    } finally {
      dc.close();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 4. Full-mode get_server_info                                        */
  /* ------------------------------------------------------------------ */

  test("full-mode get_server_info: mode full, transport stdio, cache_ttl 30, groups and tools correct, api_key_preview", async () => {
    const result = await mcp.call("get_server_info");
    expect(result.isError).toBe(false);
    const info = JSON.parse(result.text);

    expect(info.mode).toBe("full");
    expect(info.transport).toBe("stdio");
    expect(info.cache_ttl_seconds).toBe(30);
    expect(info.read_groups).toBe(9);
    expect(info.write_groups).toBe(10);
    expect(info.total_tools).toBe(23);
    expect(info.api_key_preview).toMatch(/^sk_gom_\.\.\.test$/);
  });

  /* ------------------------------------------------------------------ */
  /* 5. Read-only get_server_info                                        */
  /* ------------------------------------------------------------------ */

  test("read-only get_server_info: mode read_only, read_only true, write_groups 0", async () => {
    const ro = createMcpClient({
      baseDir,
      mockUrl,
      env: { GOMODEL_READ_ONLY: "1" },
    });
    await ro.init();

    try {
      const result = await ro.call("get_server_info");
      expect(result.isError).toBe(false);
      const info = JSON.parse(result.text);

      expect(info.mode).toBe("read_only");
      expect(info.read_only).toBe(true);
      expect(info.write_groups).toBe(0);
    } finally {
      ro.close();
    }
  });

  /* ------------------------------------------------------------------ */
  /* 6. Docs-only get_server_info                                        */
  /* ------------------------------------------------------------------ */

  test("docs-only get_server_info: mode docs_only, docs_only true, base_url null, api_key_preview null", async () => {
    const dc = createMcpClient({
      baseDir,
      mockUrl,
      env: { GOMODEL_ADMIN_API_KEY: "" },
    });
    await dc.init();

    try {
      const result = await dc.call("get_server_info");
      expect(result.isError).toBe(false);
      const info = JSON.parse(result.text);

      expect(info.mode).toBe("docs_only");
      expect(info.docs_only).toBe(true);
      expect(info.base_url).toBeNull();
      expect(info.api_key_preview).toBeNull();
    } finally {
      dc.close();
    }
  });
});
