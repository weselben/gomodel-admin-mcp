/**
 * Swagger-derived mock of the GoModel admin API, used by the e2e suite.
 *
 * The route table is generated from spec/admin-swagger.json (36 paths), plus
 * hand-added endpoints the spec does not cover yet (users, guardrails,
 * workflows, auth-keys, plugins, runtime settings/refresh, live logs). The
 * spec stays the source of truth; the extras mirror the upstream handlers in
 * /home/agent/workspaces/gomodel/internal/admin (routes.go, handler_*.go).
 *
 * Behavior cloned from the real gateway:
 * - Error envelope is exactly core.GatewayError.ToJSON():
 *     {"error":{"type":...,"message":...,"param":null,"code":...}}
 * - Missing/wrong bearer -> 401 type authentication_error.
 * - Keys prefixed sk_gom_up_ are user-path scoped -> 403 code
 *   admin_scope_denied on the global endpoints (RequireGlobalScope list).
 * - Missing required query/body params -> 400 type invalid_request_error.
 * - Unknown path -> 404 type not_found_error; path params "missing"/"unknown"
 *   -> 404 not_found_error (simulates an absent resource).
 * - Deactivate endpoints -> 204 No Content.
 * - /admin/live/logs -> SSE, two event frames then end of stream.
 *
 * Fault injection (env of the *test* process, read at import time):
 * - MOCK_FAULT="GET /admin/usage/summary=500,POST /admin/budgets/reset=503"
 *   Repeatable. Statuses map to error types: 400 invalid_request_error,
 *   403 permission_error, 404 not_found_error, 500 internal_error,
 *   503 feature_unavailable, 504 request_timeout.
 * - MOCK_HUGE=1 -> GET /admin/usage/summary returns a >256 KiB payload.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "admin-swagger.json");
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

/* ------------------------------------------------------------------ */
/* Error envelope (core.GatewayError.ToJSON)                           */
/* ------------------------------------------------------------------ */

function gatewayError(status, type, message, code = null) {
  return { status, body: { error: { type, message, param: null, code } } };
}

const ERR = {
  auth: () => gatewayError(401, "authentication_error", "authentication failed"),
  scope: () =>
    gatewayError(403, "permission_error", "admin scope required for this endpoint", "admin_scope_denied"),
  badRequest: (message) => gatewayError(400, "invalid_request_error", message),
  notFound: (message = "resource not found") =>
    gatewayError(404, "not_found_error", message, "not_found"),
  internal: () => gatewayError(500, "internal_error", "an unexpected error occurred", "internal"),
  featureUnavailable: () =>
    gatewayError(503, "feature_unavailable", "this feature is not available", "feature_unavailable"),
  requestTimeout: () =>
    gatewayError(504, "request_timeout", "request timed out", "request_timeout"),
};

function faultFor(method, path) {
  const faults = process.env.MOCK_FAULT ?? "";
  for (const entry of faults.split(",").map((e) => e.trim()).filter(Boolean)) {
    const match = entry.match(/^(\S+)\s+(\S+)=(\d{3})$/);
    if (!match) continue;
    if (match[1].toUpperCase() === method && match[2] === path) {
      const status = Number(match[3]);
      if (status === 400) return ERR.badRequest("fault injection");
      if (status === 403) return ERR.scope();
      if (status === 404) return ERR.notFound("fault injection");
      if (status === 503) return ERR.featureUnavailable();
      if (status === 504) return ERR.requestTimeout();
      return ERR.internal();
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Route table: spec paths + hand-added endpoints                      */
/* ------------------------------------------------------------------ */

/** Global-scope endpoints (RequireGlobalScope in upstream routes.go). */
const GLOBAL_ROUTES = new Set([
  "GET /admin/runtime/settings",
  "GET /admin/cache/overview",
  "GET /admin/live/logs",
  "GET /admin/usage/throughput",
  "GET /admin/providers/status",
  "POST /admin/runtime/refresh",
  "PUT /admin/provider-credentials",
  "DELETE /admin/provider-credentials/{name}",
  "PUT /admin/budgets/settings",
  "POST /admin/budgets/reset",
  "POST /admin/rate-limits/reset",
  "GET /admin/tagging/settings",
  "PUT /admin/tagging/settings",
  "GET /admin/virtual-models",
  "PUT /admin/virtual-models",
  "DELETE /admin/virtual-models",
  "GET /admin/mcp-servers",
  "PUT /admin/mcp-servers",
  "DELETE /admin/mcp-servers/{name}",
  "POST /admin/mcp-servers/{name}/reconnect",
  "GET /admin/model-pricing-overrides",
  "PUT /admin/model-pricing-overrides",
  "DELETE /admin/model-pricing-overrides",
  "GET /admin/plugins",
  "GET /admin/guardrails",
  "PUT /admin/guardrails",
  "DELETE /admin/guardrails",
  "GET /admin/guardrails/types",
  "GET /admin/workflows",
  "POST /admin/workflows",
  "GET /admin/workflows/guardrails",
  "GET /admin/workflows/{id}",
  "POST /admin/workflows/{id}/deactivate",
]);

/** Endpoints the spec does not cover yet (mirrors upstream routes.go). */
const EXTRA_ROUTES = [
  { method: "GET", path: "/admin/runtime/settings" },
  { method: "PUT", path: "/admin/runtime/settings/{key}", bodyRequired: ["value"] },
  { method: "POST", path: "/admin/runtime/refresh" },
  { method: "GET", path: "/admin/live/logs", sse: true },
  { method: "GET", path: "/admin/providers/status" },
  { method: "GET", path: "/admin/users" },
  { method: "PUT", path: "/admin/users", bodyRequired: ["user_path"] },
  { method: "DELETE", path: "/admin/users", queryRequired: ["user_path"] },
  { method: "GET", path: "/admin/plugins" },
  { method: "GET", path: "/admin/guardrails" },
  { method: "PUT", path: "/admin/guardrails", bodyRequired: ["name", "type"] },
  { method: "DELETE", path: "/admin/guardrails", bodyRequired: ["name"] },
  { method: "GET", path: "/admin/guardrails/types" },
  { method: "GET", path: "/admin/auth-keys" },
  { method: "POST", path: "/admin/auth-keys", bodyRequired: ["name"] },
  { method: "PUT", path: "/admin/auth-keys/{id}/labels", bodyRequired: ["labels"] },
  { method: "PUT", path: "/admin/auth-keys/{id}/allowed-models", bodyRequired: ["allowed_models"] },
  { method: "PUT", path: "/admin/auth-keys/{id}/dashboard-access", bodyRequired: ["dashboard_access"] },
  { method: "POST", path: "/admin/auth-keys/{id}/deactivate", noContent: true },
  { method: "GET", path: "/admin/workflows" },
  { method: "POST", path: "/admin/workflows", bodyRequired: ["name", "workflow_payload"] },
  { method: "GET", path: "/admin/workflows/guardrails" },
  { method: "GET", path: "/admin/workflows/{id}" },
  { method: "POST", path: "/admin/workflows/{id}/deactivate", noContent: true },
  { method: "GET", path: "/admin/failover" },
  { method: "PUT", path: "/admin/failover", bodyRequired: ["primary_model", "fallback_models"] },
  { method: "DELETE", path: "/admin/failover", bodyRequired: ["primary_model"] },
];

/** Spec (swagger 2) operation -> normalized route entry. */
function specRoute(method, path, op) {
  const queryRequired = [];
  const bodyRequired = [];
  for (const param of op.parameters ?? []) {
    if (param.in === "query" && param.required) queryRequired.push(param.name);
    if (param.in === "body" && param.required) {
      const defName = param.schema?.$ref?.replace("#/definitions/", "");
      const def = defName ? spec.definitions?.[defName] : null;
      if (def?.required?.length) bodyRequired.push(...def.required);
      // No required fields declared upstream -> nothing to enforce.
    }
    if (param.in === "path" && param.required) {
      // Path params are always filled by the MCP client; nothing to check.
    }
  }
  const status = op.responses?.["204"] ? "noContent" : op.responses?.["200"] ? "ok" : "ok";
  const schema = op.responses?.["200"]?.schema ?? null;
  return { method: method.toUpperCase(), path, queryRequired, bodyRequired, schema, sse: false, noContent: status === "noContent" };
}

export function buildRoutes() {
  const routes = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      routes.push(specRoute(method, path, op));
    }
  }
  for (const extra of EXTRA_ROUTES) {
    const existing = routes.find((r) => r.method === extra.method && r.path === extra.path);
    if (existing) continue; // spec gained the route upstream; spec wins
    routes.push({
      queryRequired: [],
      bodyRequired: [],
      schema: null,
      sse: false,
      noContent: false,
      ...extra,
    });
  }
  return routes;
}

/* ------------------------------------------------------------------ */
/* Response synthesizer (definitions -> example JSON, depth-capped)    */
/* ------------------------------------------------------------------ */

const MAX_DEPTH = 4;

function resolveRef(ref) {
  const name = ref.replace("#/definitions/", "");
  return spec.definitions?.[name] ?? null;
}

export function synthExample(schema, depth = 0) {
  if (!schema || depth > MAX_DEPTH) return null;
  if (schema.$ref) {
    const def = resolveRef(schema.$ref);
    return def ? synthExample({ ...def, example: undefined }, depth) : {};
  }
  if (schema.allOf) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const sub = part.$ref ? resolveRef(part.$ref) : part;
      if (!sub) continue;
      Object.assign(merged.properties, sub.properties ?? {});
      merged.required.push(...(sub.required ?? []));
    }
    return synthExample(merged, depth + 1);
  }
  const type = schema.type ?? (schema.properties ? "object" : null);
  if (type === "object" || schema.properties) {
    const out = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      out[key] = synthExample(prop, depth + 1);
    }
    return out;
  }
  if (type === "array") {
    return [synthExample(schema.items ?? { type: "string" }, depth + 1)];
  }
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  if (type === "string") {
    if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
    return "string";
  }
  if (schema.enum?.length) return schema.enum[0];
  return null;
}

/** Fallback payload for routes the spec (or a bare extra) has no schema for. */
function fallbackPayload(method, path) {
  const segments = path.replace("/admin/", "").split("/").filter(Boolean);
  const name = segments[segments.length - 1] ?? "result";
  const noun = name.replace(/\{|\}/g, "").replace(/-/g, "_") || "result";
  if (method === "GET") {
    return { [noun]: [{ id: "demo", name: "demo" }], total: 1 };
  }
  return { updated: true, [noun]: "demo" };
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

function matchRoute(routes, method, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const template = route.path.split("/").filter(Boolean);
    if (template.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const match = template[i].match(/^\{(\w+)\}$/);
      if (match) params[match[1]] = decodeURIComponent(segments[i]);
      else if (template[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function createMockServer() {
  const routes = buildRoutes();
  /** @type {Map<string, number>} keyed by "METHOD /admin/path" (template-resolved) */
  const requests = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = (req.method ?? "GET").toUpperCase();

    const key = `${method} ${pathname}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);

    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    // Auth: real gateway shape, observed live. Any sk_gom_* key passes except
    // sk_gom_wrong; sk_gom_up_* keys are user-path scoped (see below).
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token.startsWith("sk_gom_") || token === "sk_gom_wrong") {
      const err = ERR.auth();
      return send(err.status, err.body);
    }

    const matched = matchRoute(routes, method, pathname);
    if (!matched) {
      const err = ERR.notFound(`route not found: ${method} ${pathname}`);
      return send(err.status, err.body);
    }
    const { route, params } = matched;

    // Scoped-key guard (RequireGlobalScope).
    if (token.startsWith("sk_gom_up_") && GLOBAL_ROUTES.has(`${method} ${route.path}`)) {
      const err = ERR.scope();
      return send(err.status, err.body);
    }

    // Fault injection.
    const fault = faultFor(method, route.path);
    if (fault) return send(fault.status, fault.body);

    // Simulated missing resources.
    if (Object.values(params).some((v) => v === "missing" || v === "unknown")) {
      const err = ERR.notFound("resource not found");
      return send(err.status, err.body);
    }

    // Body parsing + required-field validation.
    let body = {};
    if (method !== "GET" && method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          const err = ERR.badRequest("invalid request body: malformed JSON");
          return send(err.status, err.body);
        }
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        const err = ERR.badRequest("invalid request body: expected JSON object");
        return send(err.status, err.body);
      }
      const missing = route.bodyRequired.filter((field) => body[field] === undefined);
      if (missing.length > 0) {
        const err = ERR.badRequest(`invalid request body: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required`);
        return send(err.status, err.body);
      }
    }

    // Required query params.
    const missingQuery = (route.queryRequired ?? []).filter((name) => !url.searchParams.get(name));
    if (missingQuery.length > 0) {
      const err = ERR.badRequest(`${missingQuery.join(", ")} ${missingQuery.length > 1 ? "are" : "is"} required`);
      return send(err.status, err.body);
    }

    // SSE live logs.
    if (route.sse) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (let i = 1; i <= 2; i++) {
        res.write(`event: log\ndata: {"seq":${i},"model":"openai/gpt-4o","status":200}\n\n`);
      }
      return res.end();
    }

    if (route.noContent) {
      return send(204, "");
    }

    // Huge payload mode for truncation tests.
    if (process.env.MOCK_HUGE === "1" && method === "GET" && route.path === "/admin/usage/summary") {
      const entries = Array.from({ length: 5000 }, (_, i) => ({ id: i, model: `provider/model-${i}`, cost: i * 1.5 }));
      return send(200, JSON.stringify({ entries, total: entries.length }));
    }

    const payload = route.schema
      ? synthExample(route.schema)
      : fallbackPayload(method, route.path);
    return send(200, payload ?? fallbackPayload(method, route.path));
  });

  return {
    server,
    routes,
    requests,
    /** Listen on an ephemeral port; resolves to the base URL. */
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
