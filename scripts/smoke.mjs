#!/usr/bin/env node
// Smoke-test the MCP server over stdio: initialize, list tools, call a few
// reads, optional safe round-trip write.
import { spawn } from "node:child_process";

// ── env (no secrets embedded) ───────────────────────────────────────
const API_KEY = process.env.GOMODEL_ADMIN_API_KEY;
if (!API_KEY) {
  console.error("smoke: GOMODEL_ADMIN_API_KEY is required (exit 1)");
  process.exit(1);
}

const BASE_URL = process.env.GOMODEL_BASE_URL ?? "http://localhost:8080";
const WRITE = process.env.SMOKE_WRITE === "1";

// ── stdio JSON-RPC harness ──────────────────────────────────────────
const child = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    GOMODEL_BASE_URL: BASE_URL,
    GOMODEL_ADMIN_API_KEY: API_KEY,
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function send(method, params) {
  const id = nextId++;
  const req = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(req) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});

const tools = await send("tools/list", {});
const toolNames = tools.result.tools.map((t) => t.name);
console.log("registered:", toolNames.length, "tools");
console.log("writes:", toolNames.filter((n) => /^(upsert|delete|reset|update)_/.test(n)));

const cfg = await send("tools/call", { name: "get_runtime_config", arguments: {} });
console.log("runtime_config DEMO_MODE:", JSON.parse(cfg.result.content[0].text).DEMO_MODE);

const info = await send("tools/call", {
  name: "get_server_info",
  arguments: { include_tool_categories: true },
});
const infoJson = JSON.parse(info.result.content[0].text);
console.log("server_info:", infoJson.base_url, "key", infoJson.api_key_preview, "read/write", infoJson.read_tools + "/" + infoJson.write_tools);

// ── mutating round-trip (opt-in via SMOKE_WRITE=1) ──────────────────
if (!WRITE) {
  console.log("write round-trip skipped — set SMOKE_WRITE=1 to enable");
} else {
  const stamp = Date.now();
  const source = `mcp-smoke-${stamp}`;

  const create = await send("tools/call", {
    name: "upsert_virtual_model",
    arguments: { source, description: "mcp smoke test (temporary)", enabled: true },
  });
  console.log("upsert_virtual_model:", create.result.isError ? "ERR" : "ok");

  const del = await send("tools/call", {
    name: "delete_virtual_model",
    arguments: { source },
  });
  console.log("delete_virtual_model:", del.result.content[0].text);

  const verify = await send("tools/call", {
    name: "list_virtual_models",
    arguments: {},
  });
  const remaining = JSON.parse(verify.result.content[0].text);
  console.log("virtual_models count after cleanup:", remaining.length, "— still has", source, "?", remaining.some((v) => v.source === source));
}

child.kill();
