#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ADMIN_TOOLS, inputSchemaFor, type AdminTool } from "./tools.js";
import { WRITE_TOOLS, type WriteTool } from "./write-tools.js";
import { EXTRA_WRITE_TOOLS } from "./extra-write-tools.js";
import { registerDocsTools } from "./docs.js";

const BASE_URL = (process.env.GOMODEL_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const API_KEY = process.env.GOMODEL_ADMIN_API_KEY ?? "";
const HAS_KEY = API_KEY.length > 0;
const READ_ONLY = ["1", "true"].includes((process.env.GOMODEL_READ_ONLY ?? "").toLowerCase());
const MAX_BYTES = 256 * 1024;

if (!HAS_KEY) {
  // Docs-only mode: no admin key configured, so no admin tools are
  // registered and nothing admin-related lands in the model's context.
  console.error(
    "gomodel-admin-mcp: GOMODEL_ADMIN_API_KEY not set — docs tools only, admin tools hidden",
  );
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

function truncate(text: string): string {
  if (text.length <= MAX_BYTES) return text;
  return `${text.slice(0, MAX_BYTES)}\n\n[truncated: response exceeded ${MAX_BYTES} bytes]`;
}

async function adminGet(tool: AdminTool, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(buildUrl(tool, args), {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`admin API ${res.status} ${res.statusText}: ${body.slice(0, 2000)}`);
  }
  return truncate(body);
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
  if (res.status === 204 || responseBody.length === 0) {
    return `${tool.method} ${tool.path} -> ${res.status} No Content`;
  }
  return truncate(responseBody);
}

const server = new McpServer({
  name: "gomodel-admin-mcp",
  version: "0.2.0",
});

const REGISTERED_READ_TOOLS = HAS_KEY ? ADMIN_TOOLS : [];
const REGISTERED_WRITE_TOOLS = HAS_KEY && !READ_ONLY ? [...WRITE_TOOLS, ...EXTRA_WRITE_TOOLS] : [];

for (const tool of REGISTERED_READ_TOOLS) {
  const handler =
    tool.name === "get_live_logs"
      ? (args: Record<string, unknown>) => collectLiveLogs(args)
      : (args: Record<string, unknown>) => adminGet(tool, args);
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: inputSchemaFor(tool) },
    async (args) => {
      try {
        const text = await handler(args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

for (const tool of REGISTERED_WRITE_TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.schema },
    async (args) => {
      try {
        const text = await adminWrite(tool, args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

const docsToolCount = registerDocsTools(server);

server.registerTool(
  "get_server_info",
  {
    description:
      "Return the configuration this MCP server is bound to: the gateway base URL, the admin path prefix, a redacted preview of the API key (when configured), a count of registered tools, and whether docs-only or read-only mode is active.",
    inputSchema: {},
  },
  async () => {
    const info = {
      base_url: HAS_KEY ? BASE_URL : null,
      admin_endpoint: HAS_KEY ? `${BASE_URL}/admin` : null,
      api_key_preview: HAS_KEY ? `sk_gom_...${API_KEY.slice(-4)}` : null,
      docs_only: !HAS_KEY,
      protocol: "MCP over stdio",
      read_only: READ_ONLY,
      read_tools: REGISTERED_READ_TOOLS.length,
      write_tools: REGISTERED_WRITE_TOOLS.length,
      docs_tools: docsToolCount,
      total_tools: REGISTERED_READ_TOOLS.length + REGISTERED_WRITE_TOOLS.length + docsToolCount + 1,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
