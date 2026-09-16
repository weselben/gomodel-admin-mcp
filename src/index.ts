#!/usr/bin/env bun
import http from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { ADMIN_TOOLS, inputSchemaFor, type AdminTool } from "./tools.js";
import { WRITE_TOOLS, type WriteTool } from "./write-tools.js";
import { EXTRA_WRITE_TOOLS } from "./extra-write-tools.js";
import { registerDocsTools } from "./docs.js";
import { READ_GROUPS, WRITE_GROUPS, resolveOperation, type ToolGroup } from "./groups.js";

const BASE_URL = (process.env.GOMODEL_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const API_KEY = process.env.GOMODEL_ADMIN_API_KEY ?? "";
const HAS_KEY = API_KEY.length > 0;
const READ_ONLY = ["1", "true"].includes((process.env.GOMODEL_READ_ONLY ?? "").toLowerCase());
const HTTP_TOKEN = process.env.GOMODEL_HTTP_TOKEN ?? "";

/** Parse a numeric env var; garbage input falls back instead of becoming NaN. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = envInt("PORT", 3000, 1, 65535);
const CACHE_TTL_SECONDS = envInt("GOMODEL_CACHE_TTL_SECONDS", 30, 1, 86400);

// Single source of truth: the CI-owned version field in package.json.
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const MAX_BYTES = 256 * 1024;

if (!HAS_KEY) {
  console.error(
    "gomodel-admin-mcp: GOMODEL_ADMIN_API_KEY not set — docs tools only, admin tools hidden",
  );
}

const READ_MAP = new Map<string, AdminTool>(ADMIN_TOOLS.map((t) => [t.name, t]));
const WRITE_MAP = new Map<string, WriteTool>(
  [...WRITE_TOOLS, ...EXTRA_WRITE_TOOLS].map((t) => [t.name, t]),
);

/* ------------------------------------------------------------------ */
/* Read cache: spare the Admin API on repeated reads.                  */
/* ------------------------------------------------------------------ */

const readCache = new Map<string, { text: string; expiresAt: number }>();

function cacheGet(key: string): string | undefined {
  const entry = readCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    readCache.delete(key);
    return undefined;
  }
  return entry.text;
}

function cacheSet(key: string, text: string): void {
  readCache.set(key, { text, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

function cacheInvalidateAll(): void {
  readCache.clear();
}

/* ------------------------------------------------------------------ */
/* Admin API plumbing (unchanged contract, now cache-aware).           */
/* ------------------------------------------------------------------ */

function truncate(text: string): string {
  if (text.length <= MAX_BYTES) return text;
  return `${text.slice(0, MAX_BYTES)}\n\n[truncated: response exceeded ${MAX_BYTES} bytes]`;
}

function buildUrl(tool: AdminTool, args: Record<string, unknown>): string {
  let path = tool.path;
  for (const match of tool.path.matchAll(/\{(\w+)\}/g)) {
    const value = args[match[1]];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing path parameter: ${match[1]}`);
    }
    path = path.replace(`{${match[1]}}`, encodeURIComponent(value));
  }
  const url = new URL(`${BASE_URL}/admin${path}`);
  for (const param of tool.query ?? []) {
    const value = args[param.name];
    if (typeof value === "string" && value.length > 0) {
      url.searchParams.set(param.name, value);
    }
  }
  return url.toString();
}

async function adminGet(tool: AdminTool, args: Record<string, unknown>, bypass: boolean): Promise<string> {
  const url = buildUrl(tool, args);
  if (!bypass) {
    const cached = cacheGet(url);
    if (cached !== undefined) return `${cached}\n\n[cache hit: ${CACHE_TTL_SECONDS}s TTL]`;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`admin API ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`);
  }
  // Cache the truncated text — a cache hit must not bypass MAX_BYTES.
  const text = truncate(body);
  cacheSet(url, text);
  return text;
}

/** Collect SSE events from /admin/live/logs for a bounded window. */
async function collectLiveLogs(args: Record<string, unknown>): Promise<string> {
  const raw = Number.parseInt(String(args.seconds ?? "5"), 10);
  const seconds = Math.min(Math.max(Number.isFinite(raw) ? raw : 5, 1), 30);
  const res = await fetch(`${BASE_URL}/admin/live/logs`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" },
    signal: AbortSignal.timeout(seconds * 1000 + 10_000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`admin API ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const deadline = Date.now() + seconds * 1000;
  try {
    while (Date.now() < deadline && collected.length < MAX_BYTES) {
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null) break;
      if (chunk.done) break;
      collected += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return truncate(collected || `[no events received within ${seconds}s]`);
}

function buildUrlFromPath(path: string, args: Record<string, unknown>): string {
  const pathname = path.replace(/\{(\w+)\}/g, (_, key) => {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`missing path parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });
  return `${BASE_URL}/admin${pathname}`;
}

async function adminWrite(tool: WriteTool, args: Record<string, unknown>): Promise<string> {
  const url = buildUrlFromPath(tool.path, args);
  const body = JSON.stringify(tool.body(args));
  const res = await fetch(url, {
    method: tool.method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const responseBody = await res.text();
  if (!res.ok) {
    throw new Error(`admin API ${res.status} ${res.statusText}: ${responseBody.slice(0, 2000)}`);
  }
  cacheInvalidateAll();
  if (res.status === 204 || responseBody.length === 0) {
    return `${tool.method} ${tool.path} -> ${res.status} No Content`;
  }
  return truncate(responseBody);
}

/* ------------------------------------------------------------------ */
/* Group tools: gradual discovery, harness-agnostic.                   */
/* ------------------------------------------------------------------ */

function operationListing(group: ToolGroup): string {
  const lines = Object.entries(group.operations).map(([op, hint]) => `- ${op}: ${hint}`);
  return `Operations of admin_${group.name}:\n${lines.join("\n")}`;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function schemaFor(group: ToolGroup, operation: string): z.ZodTypeAny {
  const shape =
    group.kind === "read"
      ? inputSchemaFor(READ_MAP.get(operation) as AdminTool)
      : (WRITE_MAP.get(operation) as WriteTool).schema;
  return z.object(shape).strict();
}

function groupSchema(group: ToolGroup) {
  return {
    operation: z
      .string()
      .optional()
      .describe(
        `Which operation to run. Omit to list this area's operations (${Object.keys(group.operations).join(", ")}).`,
      ),
    params: z
      .record(z.unknown())
      .optional()
      .describe(
        "Arguments for the operation. Unknown or wrongly typed arguments return field-level errors so you can correct the call. Reads accept params.cache_bypass=true to skip the response cache for this call.",
      ),
  };
}

type DispatchResult =
  | { kind: "text"; text: string }
  | { kind: "error"; text: string }
  | { kind: "run"; tool: AdminTool | WriteTool; args: Record<string, unknown>; bypass: boolean };

function dispatchGroup(group: ToolGroup, args: Record<string, unknown>): DispatchResult {
  const operation = typeof args.operation === "string" ? args.operation : "";
  if (!operation) {
    return { kind: "text", text: operationListing(group) };
  }
  const tool = resolveOperation(group, operation, READ_MAP, WRITE_MAP);
  if (!tool) {
    return {
      kind: "error",
      text: `unknown operation "${operation}" for admin_${group.name}.\n\n${operationListing(group)}`,
    };
  }
  const raw = (args.params ?? {}) as Record<string, unknown>;
  const bypass = raw.cache_bypass === true;
  const params = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "cache_bypass"));
  const parsed = schemaFor(group, operation).safeParse(params);
  if (!parsed.success) {
    return {
      kind: "error",
      text: `invalid params for ${operation}:\n${formatZodError(parsed.error)}\n\nCall admin_${group.name} again with corrected params; omit "operation" to re-list this area's operations.`,
    };
  }
  return { kind: "run", tool, args: parsed.data as Record<string, unknown>, bypass };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const INSTRUCTIONS = [
  "GoModel admin API, grouped by area. Call pattern: admin_<area>(operation, params).",
  "Areas: " +
    [...READ_GROUPS, ...WRITE_GROUPS].map((g) => `admin_${g.name}`).join(", ") +
    " (write areas only appear when writes are enabled).",
  "Gradual discovery: omit operation to list an area's operations; an unknown operation errors with the valid list; invalid params return field-level errors. Correct and retry — discovery costs one failed call at most.",
  "Reads are cached for " + CACHE_TTL_SECONDS + "s; pass params.cache_bypass=true to skip the cache for one call.",
  "Docs live in GitHub: docs_index lists pages, docs_search greps contents, docs_get fetches one page.",
].join("\n");

const REGISTERED_READ_GROUPS = HAS_KEY ? READ_GROUPS : [];
const REGISTERED_WRITE_GROUPS = HAS_KEY && !READ_ONLY ? WRITE_GROUPS : [];

/** Build a fully registered server. Called per request in HTTP mode
 *  (stateless transport), once at startup in stdio mode. */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: "gomodel-admin-mcp", version: PKG_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const group of [...REGISTERED_READ_GROUPS, ...REGISTERED_WRITE_GROUPS]) {
    server.registerTool(
      `admin_${group.name}`,
      {
        description: `${group.description} Operations: ${Object.entries(group.operations)
          .map(([op, hint]) => `${op} (${hint})`)
          .join("; ")}.`,
        inputSchema: groupSchema(group),
      },
      async (args) => {
        try {
          const result = dispatchGroup(group, args as Record<string, unknown>);
          if (result.kind === "error") return errorResult(result.text);
          if (result.kind === "text") return textResult(result.text);
          const text =
            group.kind === "read"
              ? (result.tool as AdminTool).name === "get_live_logs"
                ? await collectLiveLogs(result.args)
                : await adminGet(result.tool as AdminTool, result.args, result.bypass)
              : await adminWrite(result.tool as WriteTool, result.args);
          return textResult(text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorResult(`Error: ${message}`);
        }
      },
    );
  }

  const docsToolCount = registerDocsTools(server);

  server.registerTool(
    "get_server_info",
    {
      description:
        "Configuration and mode of this MCP server: mode (full/read-only/docs-only), transport (stdio/http), registered groups and tool counts, cache TTL, and a redacted API key preview (only when configured).",
      inputSchema: {},
    },
    async () => {
      const mode = !HAS_KEY ? "docs_only" : READ_ONLY ? "read_only" : "full";
      const info = {
        mode,
        transport: HTTP_TOKEN ? "http" : "stdio",
        http: HTTP_TOKEN ? { host: HOST, port: PORT, endpoint: "/mcp" } : null,
        docs_only: !HAS_KEY,
        read_only: READ_ONLY,
        base_url: HAS_KEY ? BASE_URL : null,
        admin_endpoint: HAS_KEY ? `${BASE_URL}/admin` : null,
        api_key_preview: HAS_KEY ? `sk_gom_...${API_KEY.slice(-4)}` : null,
        cache_ttl_seconds: CACHE_TTL_SECONDS,
        read_groups: REGISTERED_READ_GROUPS.length,
        write_groups: REGISTERED_WRITE_GROUPS.length,
        docs_tools: docsToolCount,
        total_tools:
          REGISTERED_READ_GROUPS.length + REGISTERED_WRITE_GROUPS.length + docsToolCount + 1,
      };
      return textResult(JSON.stringify(info, null, 2));
    },
  );

  return server;
}

/* ------------------------------------------------------------------ */
/* Transports: stdio by default, streamable HTTP when HTTP_TOKEN set.  */
/* ------------------------------------------------------------------ */

if (HTTP_TOKEN) {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found; MCP endpoint is /mcp" }));
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${HTTP_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized: send Authorization: Bearer <GOMODEL_HTTP_TOKEN>" }));
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }
    // Stateless mode: one fresh server + transport per request, torn down on close.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const requestServer = buildServer();
    await requestServer.connect(transport);
    res.on("close", () => {
      transport.close().catch(() => {});
      requestServer.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`gomodel-admin-mcp: streamable HTTP MCP on http://${HOST}:${PORT}/mcp`);
  });
} else {
  await buildServer().connect(new StdioServerTransport());
}
