#!/usr/bin/env node
// Measures the passive context cost of each server mode (tools/list payload)
// and rewrites the token table in README.md. Used by the release workflow
// so the documented numbers always match the code.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SERVER = ["bun", ["dist/index.js"]];
const README = "README.md";

function measure(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER[0], SERVER[1], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const pending = new Map();
    let id = 1;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("server did not answer within 30s"));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    const send = (method, params) => {
      const req = { jsonrpc: "2.0", id: id++, method, params };
      child.stdin.write(JSON.stringify(req) + "\n");
      return new Promise((res) => pending.set(req.id, res));
    };
    (async () => {
      await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "measure-tokens", version: "0" },
      });
      const tools = await send("tools/list", {});
      clearTimeout(timeout);
      child.kill();
      resolve({ tools: tools.result.tools.length, bytes: JSON.stringify(tools.result.tools).length });
    })().catch((error) => {
      clearTimeout(timeout);
      child.kill();
      reject(error);
    });
  });
}

function formatTokens(bytes) {
  const tokens = Math.round(bytes / 4);
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k` : `~${tokens}`;
}

const rows = [
  {
    label: "| Full (default, key set)",
    env: { GOMODEL_ADMIN_API_KEY: "sk_gom_dummy" },
  },
  {
    label: "| `GOMODEL_READ_ONLY=1`",
    env: { GOMODEL_ADMIN_API_KEY: "sk_gom_dummy", GOMODEL_READ_ONLY: "1" },
  },
  {
    label: "| Docs-only (no admin key)",
    env: { GOMODEL_ADMIN_API_KEY: "" },
  },
];

let changed = false;
let readme = readFileSync(README, "utf8");

for (const row of rows) {
  const { tools, bytes } = await measure(row.env);
  const rendered = `${row.label} | ${tools} | ${bytes.toLocaleString("en-US")} | ${formatTokens(bytes)} |`;
  console.log(rendered);
  const pattern = new RegExp(`^${row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*$`, "m");
  if (!pattern.test(readme)) {
    console.error(`table row not found in ${README}: ${row.label}`);
    process.exit(1);
  }
  const next = readme.replace(pattern, rendered);
  if (next !== readme) changed = true;
  readme = next;
}

writeFileSync(README, readme);
console.log(changed ? `${README} updated` : `${README} already up to date`);
