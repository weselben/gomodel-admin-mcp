/**
 * Test harness helpers for the e2e suite: in-process mock admin API plus a
 * stdio JSON-RPC client for the MCP server (spawned as `bun dist/index.js`)
 * and a minimal streamable-HTTP client for host-mode tests.
 */

import { spawn } from "node:child_process";
import { createMockServer } from "./mock-server.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Start the mock admin API. Returns { url, requests, close }. */
export async function startMock() {
  const mock = createMockServer();
  const url = await mock.listen();
  return { url, requests: mock.requests, close: () => mock.close() };
}

/* ------------------------------------------------------------------ */
/* stdio JSON-RPC client                                               */
/* ------------------------------------------------------------------ */

let nextId = 1;

export async function startMcp(env = {}) {
  const child = spawn("bun", ["dist/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GOMODEL_ADMIN_API_KEY: "sk_gom_test",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      } catch {
        // Non-JSON stdout line; ignore.
      }
    }
  });
  child.stderr.on("data", () => {}); // startup banner etc.
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method}`));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const init = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "0.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  /** Call an MCP tool; returns { isError, text } from the first text content. */
  async function call(name, args = {}) {
    const message = await request("tools/call", { name, arguments: args });
    if (message.error) {
      throw new Error(`tools/call ${name} failed: ${message.error.message}`);
    }
    const content = message.result?.content ?? [];
    return {
      isError: message.result?.isError === true,
      text: content.map((c) => c.text ?? "").join("\n"),
    };
  }

  async function listTools() {
    const message = await request("tools/list", {});
    if (message.error) throw new Error(`tools/list failed: ${message.error.message}`);
    return message.result?.tools ?? [];
  }

  async function close() {
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }

  return { call, listTools, close, serverInfo: init.result?.serverInfo ?? null };
}

/* ------------------------------------------------------------------ */
/* streamable-HTTP client (host mode)                                  */
/* ------------------------------------------------------------------ */

/** One fresh JSON-RPC HTTP request to the MCP host endpoint. */
export async function httpRpc(baseUrl, method, params, token = "test_http_token") {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  // Streamable responses may be JSON or an SSE stream with one data frame.
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
    payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
  }
  return { status: res.status, payload };
}
