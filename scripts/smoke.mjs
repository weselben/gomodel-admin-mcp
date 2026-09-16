#!/usr/bin/env node
// Smoke-test the grouped MCP server over stdio.
// Pattern: admin_<area>(operation, params); omit operation → list area ops.
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
const child = spawn("bun", ["dist/index.js"], {
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

// ── results tracking ────────────────────────────────────────────────
let anyFail = false;

function check(label, cond) {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    console.log(`FAIL ${label}`);
    anyFail = true;
  }
}

// ── initialise ──────────────────────────────────────────────────────
const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
check("initialize", !init.isError);

// ── check 1: tool count + admin_* group names ──────────────────────
const tools = await send("tools/list", {});
check("tools/list", !tools.isError);
const toolList = tools.result?.tools ?? [];
const toolNames = toolList.map((t) => t.name);
const adminGroups = toolNames.filter((n) => n.startsWith("admin_"));
console.log("registered:", toolNames.length, "tools");
console.log("admin_* groups:", adminGroups.join(", "));
check("has admin_* tools", adminGroups.length > 0);

// ── check 2: get_server_info (unchanged, no arguments block) ────────
const info = await send("tools/call", {
  name: "get_server_info",
  arguments: {},
});
check("get_server_info call", !info.isError);
const infoJson = JSON.parse(info.result?.content?.[0]?.text ?? "{}");
console.log("server_info: mode=", infoJson.mode, "transport=", infoJson.transport, "total_tools=", infoJson.total_tools);
check("server_info has fields", infoJson.mode != null && infoJson.transport != null && infoJson.total_tools != null);

// ── check 3: admin_runtime no operation → expect operations list ───
const runtimeOp = await send("tools/call", {
  name: "admin_runtime",
  arguments: {},
});
check("admin_runtime (no op) call", !runtimeOp.isError);
const runtimeText = runtimeOp.result?.content?.[0]?.text ?? "";
console.log("admin_runtime ops list:", runtimeText.slice(0, 200));
check("admin_runtime lists operations", runtimeText.includes("get_runtime_config"));

// ── check 4: admin_usage get_usage_summary days=1 ──────────────────
const usage = await send("tools/call", {
  name: "admin_usage",
  arguments: { operation: "get_usage_summary", params: { days: "1" } },
});
check("admin_usage call", !usage.isError);
console.log("admin_usage:", usage.result?.isError ? "ERR" : "ok");

// ── check 5: admin_audit nonsense_op → expect isError true ────────
const badOp = await send("tools/call", {
  name: "admin_audit",
  arguments: { operation: "nonsense_op", params: {} },
});
const badText = badOp.result?.content?.[0]?.text ?? "";
const badIsError = !!badOp.result?.isError;
console.log("admin_audit(nonsense) isError=", badIsError, "msg:", badText.slice(0, 200));
check("admin_audit nonsense → isError true", badIsError && badText.includes("unknown operation") && badText.includes("get_audit_log"));

// ── check 6: SMOKE_WRITE round-trip via admin_virtual_models ────────
if (!WRITE) {
  console.log("write round-trip skipped — set SMOKE_WRITE=1 to enable");
  console.log("(not a failure, just skipped)");
} else {
  const stamp = Date.now();
  const source = `mcp-smoke-${stamp}`;

  // upsert
  const upsert = await send("tools/call", {
    name: "admin_virtual_models",
    arguments: {
      operation: "upsert_virtual_model",
      params: {
        source,
        description: "mcp smoke test (temporary)",
        enabled: true,
      },
    },
  });
  check("upsert_virtual_model", !upsert.result?.isError);

  // list_virtual_models inside admin_models to verify existence
  const list = await send("tools/call", {
    name: "admin_models",
    arguments: { operation: "list_virtual_models", params: {} },
  });
  check("list_virtual_models call", !list.result?.isError);
  const modelsText = list.result?.content?.[0]?.text ?? "[]";
  const models = JSON.parse(modelsText);
  const foundBefore = models.some((v) => v.source === source);
  console.log("virtual model present after upsert:", foundBefore);
  check("virtual model found after upsert", foundBefore);

  // delete
  const del = await send("tools/call", {
    name: "admin_virtual_models",
    arguments: { operation: "delete_virtual_model", params: { source } },
  });
  check("delete_virtual_model", !del.result?.isError);

  // verify gone
  const verify = await send("tools/call", {
    name: "admin_models",
    arguments: { operation: "list_virtual_models", params: {} },
  });
  const verifyText = verify.result?.content?.[0]?.text ?? "[]";
  const verifyModels = JSON.parse(verifyText);
  const foundAfter = verifyModels.some((v) => v.source === source);
  check("virtual model cleaned up after delete", !foundAfter);
}

// ── done ────────────────────────────────────────────────────────────
child.kill();
if (anyFail) {
  console.error("smoke: one or more checks failed (exit 1)");
  process.exit(1);
}
console.log("smoke: all checks passed");
