import { describe, test, expect } from "bun:test";
import type { AdminTool } from "../src/tools.js";
import type { WriteTool } from "../src/write-tools.js";
import {
  READ_GROUPS,
  WRITE_GROUPS,
  resolveOperation,
  type ToolGroup,
} from "../src/groups.js";
import { ADMIN_TOOLS } from "../src/tools.js";
import { WRITE_TOOLS } from "../src/write-tools.js";
import { EXTRA_WRITE_TOOLS } from "../src/extra-write-tools.js";
import { startMock, startMcp } from "../tests/helpers.mjs";
import { buildRoutes } from "../tests/mock-server.mjs";

/* ================================================================ */
/* Helpers                                                           */
/* ================================================================ */

const allReadTools: AdminTool[] = ADMIN_TOOLS;
const allWriteTools: WriteTool[] = [...WRITE_TOOLS, ...EXTRA_WRITE_TOOLS];

const readMap = new Map(allReadTools.map((t) => [t.name, t]));
const writeMap = new Map(allWriteTools.map((t) => [t.name, t]));

const routeTable = new Map(buildRoutes().map((r) => [`${r.method} ${r.path}`, r]));

function buildReverseLookup() {
  const reads: Record<string, { group: ToolGroup; opName: string }> = {};
  for (const g of READ_GROUPS) {
    for (const [op] of Object.entries(g.operations)) {
      reads[op] = { group: g, opName: op };
    }
  }
  const writes: Record<string, { group: ToolGroup; opName: string }> = {};
  for (const g of WRITE_GROUPS) {
    for (const [op] of Object.entries(g.operations)) {
      writes[op] = { group: g, opName: op };
    }
  }
  return { reads, writes };
}
const { reads: readToGroup, writes: writeToGroup } = buildReverseLookup();

function requiredQueryFor(op: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const p of op.parameters ?? []) {
    if (p.in === "query" && p.required) out.push(p.name);
  }
  return out;
}

function buildReadArgs(tool: AdminTool, specOp: Record<string, unknown>): Record<string, string> {
  const args: Record<string, string> = {};
  for (const match of tool.path.matchAll(/\{(\w+)\}/g)) {
    args[match[1]] = "demo";
  }
  for (const q of requiredQueryFor(specOp)) {
    args[q] = "demo";
  }
  return args;
}

/* Synthetic value from a Zod schema node, using _def.typeName */
function synthFromZod(schema: unknown): unknown {
  if (!schema) return null;
  const s = schema as Record<string, unknown>;
  const def = (s._def as Record<string, unknown>) ?? {};
  const typeName = (def.typeName as string) ?? "";

  // Unwrap ZodOptional / ZodDefault / ZodNullable
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable") {
    const inner = (def.innerType as unknown) ?? null;
    return inner ? synthFromZod(inner) : null;
  }
  if (typeName === "ZodNonOptional") {
    const inner = (def.innerType as unknown) ?? null;
    return inner ? synthFromZod(inner) : null;
  }

  // ZodObject
  if (typeName === "ZodObject") {
    const out: Record<string, unknown> = {};
    const shape = s.shape;
    if (typeof shape === "function") {
      for (const [k, v] of Object.entries(shape())) {
        out[k] = synthFromZod(v);
      }
    } else if (shape && typeof shape === "object") {
      for (const [k, v] of Object.entries(shape)) {
        out[k] = synthFromZod(v);
      }
    }
    return out;
  }

  // ZodArray
  if (typeName === "ZodArray") {
    const element = (def.type as unknown) ?? null;
    return element ? [synthFromZod(element)] : ["demo"];
  }

  // ZodRecord
  if (typeName === "ZodRecord") {
    const valueType = (def.valueType as unknown) ?? null;
    if (valueType) {
      return { k: synthFromZod(valueType) };
    }
    return { k: "v" };
  }

  // Leaf types
  switch (typeName) {
    case "ZodString":
      return "demo";
    case "ZodNumber":
      return 1;
    case "ZodBoolean":
      return true;
    case "ZodLiteral":
      return (def.value as unknown) ?? "demo";
    case "ZodEnum":
      return (def.values as unknown[])?.[0] ?? "demo";
    case "ZodNativeEnum":
      return "demo";
    default:
      return null;
  }
}

function buildWriteArgs(tool: WriteTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) {
    args[key] = synthFromZod(schema);
  }
  return args;
}

/* Known noContent (204) endpoints, derived from the mock route table */
const noContentRoutes = new Set(
  buildRoutes()
    .filter((r) => r.noContent)
    .map((r) => `${r.method} ${r.path}`),
);

function isNoContentRoute(method: string, specPath: string): boolean {
  return noContentRoutes.has(`${method} ${specPath}`);
}

/* ================================================================ */
/* Forward sweep: every spec path+method -> exactly one group op     */
/* ================================================================ */

describe("Forward sweep — spec paths map to group operations", () => {
  test("all spec operations resolve and execute successfully", async () => {
    const mock = await startMock();
    let mcp: Awaited<ReturnType<typeof startMcp>> | undefined;
    try {
      mcp = await startMcp({ GOMODEL_BASE_URL: mock.url });

      let ok = 0;
      const fail: string[] = [];

      const spec = require("../spec/admin-swagger.json");
      for (const [specPath, methods] of Object.entries(
        spec.paths as Record<string, Record<string, unknown>>,
      )) {
        for (const [methodRaw, op] of Object.entries(methods)) {
          if (methodRaw === "parameters") continue;
          const method = methodRaw.toUpperCase();

          // Find the underlying tool for this spec path+method
          const tool =
            method !== "GET"
              ? writeMap.get(
                  allWriteTools.find(
                    (t) =>
                      t.method === method && "/admin" + t.path === specPath,
                  )?.name ?? "",
                )
              : readMap.get(
                  allReadTools.find((t) => "/admin" + t.path === specPath)
                    ?.name ?? "",
                );

          if (!tool) {
            fail.push(`no tool: ${method} ${specPath}`);
            continue;
          }

          // Resolve to group
          const pool = method !== "GET" ? writeMap : readMap;
          const group =
            method !== "GET"
              ? writeToGroup[tool.name]?.group
              : readToGroup[tool.name]?.group;
          const opName =
            method !== "GET"
              ? writeToGroup[tool.name]?.opName
              : readToGroup[tool.name]?.opName;
          if (!group || !opName) {
            fail.push(`cannot resolve group for ${tool.name} (${method} ${specPath})`);
            continue;
          }

          const resolved = resolveOperation(group, opName, readMap, writeMap);
          if (!resolved) {
            fail.push(`resolveOperation returned undefined for ${opName}`);
            continue;
          }

          // Build minimal args
          const toolArgs =
            method !== "GET"
              ? buildWriteArgs(resolved as WriteTool)
              : buildReadArgs(resolved as AdminTool, op as Record<string, unknown>);

          const callArgs = { operation: opName, params: toolArgs };

          const result = await mcp.call(`admin_${group.name}`, callArgs);
          if (result.isError) {
            fail.push(`${opName}: isError — ${result.text.slice(0, 120)}`);
            continue;
          }

          // For noContent ops (204) the text is not JSON
          if (!isNoContentRoute(method, specPath)) {
            try {
              JSON.parse(result.text);
            } catch {
              fail.push(`${opName}: text not JSON — ${result.text.slice(0, 120)}`);
            }
          }
          ok++;
        }
      }

      console.log(
        `Forward sweep: ${ok} ops covered, ${fail.length} failures`,
      );
      if (fail.length) console.error("Failures:", fail);
      expect(fail.length).toBe(0);
    } finally {
      if (mcp) await mcp.close();
      mock.close();
    }
  });
});

/* ================================================================ */
/* Reverse sweep: every group op maps to a route in mock            */
/* ================================================================ */

describe("Reverse sweep — all group ops have matching mock routes", () => {
  test("zero unmatched operations", () => {
    const allOps: string[] = [];
    for (const g of READ_GROUPS) allOps.push(...Object.keys(g.operations));
    for (const g of WRITE_GROUPS) allOps.push(...Object.keys(g.operations));

    const unmatched: string[] = [];
    for (const op of allOps) {
      const rgrp = readToGroup[op];
      const wgrp = writeToGroup[op];

      if (rgrp) {
        const tool = readMap.get(op);
        if (!tool) {
          unmatched.push(`${op}: no read tool`);
          continue;
        }
        const key = `GET /admin${tool.path}`;
        if (!routeTable.has(key)) {
          unmatched.push(`${op}: route missing ${key}`);
        }
      } else if (wgrp) {
        const tool = writeMap.get(op);
        if (!tool) {
          unmatched.push(`${op}: no write tool`);
          continue;
        }
        // Tool path may embed query params (e.g. "/users?user_path={user_path}")
        // Normalize to just the path portion for route table lookup
        const rawPath = tool.path;
        const pathOnly = rawPath.split("?")[0];
        const key = `${tool.method} /admin${pathOnly}`;
        if (!routeTable.has(key)) {
          unmatched.push(`${op}: route missing ${key} (from path ${rawPath})`);
        }
      }
    }

    console.log(
      `Reverse sweep: ${allOps.length} ops checked, ${unmatched.length} unmatched`,
    );
    if (unmatched.length) console.error("Unmatched:", unmatched);
    expect(unmatched.length).toBe(0);
  });
});
