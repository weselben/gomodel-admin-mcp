import { z } from "zod";
import { assembleStream } from "./playground-sse.js";

/**
 * Playground tools: the MCP equivalent of the dashboard Playground page
 * (docs/features/playground.mdx). Two operations on one group:
 *
 * - context: what the UI's model picker + user-path prefill know — the
 *   effective user-path header name (GET /admin/runtime/config), the model
 *   inventory (GET /admin/models), and virtual models with their user_paths
 *   access policies (GET /admin/virtual-models).
 * - send: ONE inference request through the gateway's PUBLIC API
 *   (/v1/chat/completions, /v1/responses, /v1/messages — never /admin) using
 *   the configured admin key, then reassembles the audit-trail entry for this
 *   exact request so the caller gets the same JSON the dashboard shows and
 *   the audit trail records, without refetching.
 *
 * The group is gated behind GOMODEL_PLAYGROUND=1 (default OFF) and requires
 * an admin key; `send` additionally respects GOMODEL_READ_ONLY.
 *
 * Contracts verified against the GoModel gateway source:
 * - Credential headers: internal/core/credential_headers.go (IsCredentialHeader)
 * - User-path header: internal/core/user_path.go (UserPathHeader, configurable
 *   via server.user_path_header; effective name from GET /admin/runtime/config)
 * - Public routes: internal/server/http.go (POST /v1/chat/completions,
 *   /v1/responses, /v1/messages)
 * - Messages role policy: internal/anthropicapi/request.go ("messages[i].role
 *   must be \"user\" or \"assistant\"")
 * - Audit entry fields: internal/auditlog/auditlog.go (id, status_code,
 *   duration_ns, usage; data.request_body/response_body/
 *   request_headers/response_headers, *_body_too_big_to_handle flags)
 */

import { operationListing, type ToolGroup } from "./groups.js";

/* ------------------------------------------------------------------ */
/* Credential headers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Headers whose values carry secrets. Ported verbatim from the GoModel
 * gateway's internal/core/credential_headers.go (credentialHeaders map —
 * the single source of truth behind IsCredentialHeader). Matching is
 * case-insensitive and ignores surrounding whitespace, like the Go code.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key", // Azure OpenAI credential header
  "x-goog-api-key", // Google Gemini / Vertex credential header
  "x-auth-token",
  "x-access-token",
  "x-gomodel-key",
]);

/** Case-insensitive, whitespace-trimming port of core.IsCredentialHeader. */
export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.trim().toLowerCase());
}

/** Default user-path header when runtime config does not override it. */
const DEFAULT_USER_PATH_HEADER = "X-GoModel-User-Path";

/* ------------------------------------------------------------------ */
/* Group definition                                                     */
/* ------------------------------------------------------------------ */

export const PLAYGROUND_GROUP: ToolGroup = {
  name: "playground",
  description:
    "Playground: test models through the gateway's public API like the dashboard Playground. send posts one inference request and returns the matching audit-trail entry (request/response bodies and headers).",
  operations: {
    context:
      "model picker context: user-path header name, models, virtual models with user_paths policies",
    send:
      "send one inference request via /v1/chat/completions, /v1/responses, or /v1/messages and reassemble the audit entry",
  },
  kind: "playground",
};

/* ------------------------------------------------------------------ */
/* Param schemas                                                        */
/* ------------------------------------------------------------------ */

const messageSchema = z.object({
  role: z.string().min(1, "role is required"),
  content: z.union([z.string(), z.array(z.unknown())]),
});

const allowedRoles = (endpoint: string): string[] => {
  switch (endpoint) {
    case "messages":
      // internal/anthropicapi/request.go: "messages[i].role must be
      // \"user\" or \"assistant\"".
      return ["user", "assistant"];
    case "responses":
      // internal/server/conversation_item_normalization.go.
      return ["system", "developer", "user", "assistant"];
    default:
      return ["system", "developer", "user", "assistant", "tool", "function"];
  }
};

const sendSchema = z
  .object({
    endpoint: z
      .enum(["chat_completions", "responses", "messages"])
      .describe("Public API dialect to call"),
    model: z.string().min(1).describe("Model id or virtual model name"),
    messages: z
      .array(messageSchema)
      .optional()
      .describe(
        "Conversation messages ({role, content}); required for chat_completions and messages, used as the responses input array for responses",
      ),
    stream: z
      .boolean()
      .optional()
      .describe("Stream the response; the SSE stream is assembled into the non-streaming shape"),
    max_tokens: z.number().optional().describe("Max tokens (max_output_tokens on responses)"),
    temperature: z.number().optional(),
    user_path: z
      .string()
      .optional()
      .describe(
        "User path for this request; overrides the auto-resolved first entry of the model's user_paths policy. Only settable here — never via headers.",
      ),
    headers: z
      .record(z.string())
      .optional()
      .describe(
        "Custom request headers forwarded verbatim (e.g. X-Session-Id, X-Title, HTTP-Referer, anthropic-version). Credential headers and the user-path header are rejected.",
      ),
  })
  .superRefine((value, ctx) => {
    const allowed = new Set(allowedRoles(value.endpoint));
    (value.messages ?? []).forEach((message, i) => {
      if (!allowed.has(message.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", i, "role"],
          message: `role must be one of: ${[...allowed].join(", ")}`,
        });
      }
    });
    if (value.endpoint !== "responses" && (value.messages ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: `required for ${value.endpoint} (at least one message)`,
      });
    }
  });

const contextSchema = z.object({}).strict();

/** Same rendering style as index.ts formatZodError, with headers redacted. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".") || "(root)";
      const sensitive = issue.path.some(
        (segment) => typeof segment === "string" && /headers/i.test(segment),
      );
      const received = sensitive ? " [redacted]" : "";
      return `- ${path}: ${issue.message}${received}`;
    })
    .join("\n");
}


function endpointPath(endpoint: string): string {
  switch (endpoint) {
    case "chat_completions":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    default:
      return "/v1/messages";
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

export type PlaygroundDispatch =
  | { kind: "text"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "run";
      operation: "context" | "send";
      params: Record<string, unknown>;
      bypass: boolean;
    };

export function playgroundDispatch(args: Record<string, unknown>): PlaygroundDispatch {
  const operation = typeof args.operation === "string" ? args.operation : "";
  const listing = operationListing(PLAYGROUND_GROUP);
  if (!operation) {
    return { kind: "text", text: listing };
  }
  if (operation !== "context" && operation !== "send") {
    return { kind: "error", text: `unknown operation "${operation}" for admin_playground.\n\n${listing}` };
  }
  const raw = (args.params ?? {}) as Record<string, unknown>;
  const bypass = raw.cache_bypass === true;
  const params = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "cache_bypass"));
  const schema = operation === "context" ? contextSchema : sendSchema;
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return {
      kind: "error",
      text: `invalid params for ${operation}:\n${formatZodError(parsed.error)}\n\nCall admin_playground again with corrected params; omit "operation" to re-list this area's operations.`,
    };
  }
  return { kind: "run", operation, params: parsed.data as Record<string, unknown>, bypass };
}

/* ------------------------------------------------------------------ */
/* Execution                                                            */
/* ------------------------------------------------------------------ */

export interface PlaygroundDeps {
  /** Admin read by tool name; returns normalized JSON text (throws on HTTP error). */
  readAdmin: (toolName: string, args: Record<string, unknown>, bypass: boolean) => Promise<string>;
  /** Gateway base URL (no trailing slash) and the configured admin key. */
  baseUrl: string;
  apiKey: string;
  /** When true, `send` refuses to run (GOMODEL_READ_ONLY). */
  readOnly: boolean;
}

function headerNames(headers: Record<string, string>): string[] {
  return Object.keys(headers);
}

function validateHeaderNames(
  headers: Record<string, string>,
  userPathHeader: string,
): string | undefined {
  for (const name of headerNames(headers)) {
    if (isCredentialHeader(name)) {
      let hint = "credential and auth headers are always set by this tool from its configured admin key and must not be supplied";
      if (name.trim().toLowerCase() !== "authorization") {
        hint = "secrets must never be forwarded as request headers";
      }
      return `- headers.${name}: credential header rejected — ${hint}`;
    }
    if (name.trim().toLowerCase() === userPathHeader.trim().toLowerCase()) {
      return `- headers.${name}: user-path header rejected — pass the user path via the user_path parameter instead; the user path is only settable through that param, never through headers`;
    }
  }
  return undefined;
}

/** Public API content types, forced per dialect (all three are JSON). */
function contentTypeFor(): string {
  return "application/json";
}

/**
 * Build the request body for one dialect. Mirrors the dashboard Playground:
 * messages become the Responses API `input` array for the responses dialect,
 * max_tokens maps to max_output_tokens there.
 */
function buildRequestBody(args: {
  endpoint: string;
  model: string;
  messages?: { role: string; content: unknown }[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { model: args.model };
  if (args.endpoint === "responses") {
    body.input = (args.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
    if (args.max_tokens !== undefined) body.max_output_tokens = args.max_tokens;
  } else {
    body.messages = args.messages ?? [];
    if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
  }
  if (args.stream !== undefined) body.stream = args.stream;
  if (args.temperature !== undefined) body.temperature = args.temperature;
  return body;
}

function validateRoles(
  endpoint: string,
  messages: { role: string; content: unknown }[] | undefined,
): string | undefined {
  if (endpoint !== "responses" && (!messages || messages.length === 0)) {
    return `- messages: required for ${endpoint} (at least one message)`;
  }
  if (!messages) return undefined;
  const allowed = new Set(allowedRoles(endpoint));
  for (const [i, message] of messages.entries()) {
    if (!allowed.has(message.role)) {
      return `- messages.${i}.role: invalid_type — role must be one of: ${[...allowed].join(", ")}`;
    }
  }
  return undefined;
}

/* ------------------------------ send ---------------------------------- */

function firstUserPathPolicy(
  virtualModels: unknown,
  model: string,
): string | undefined {
  if (!Array.isArray(virtualModels)) return undefined;
  for (const entry of virtualModels) {
    if (!entry || typeof entry !== "object") continue;
    const view = entry as Record<string, unknown>;
    if (view.source !== model) continue;
    const paths = view.user_paths;
    if (Array.isArray(paths) && typeof paths[0] === "string" && paths[0]) return paths[0];
  }
  return undefined;
}

function pickAuditSnapshot(detail: Record<string, unknown>): Record<string, unknown> {
  const data = (detail.data ?? {}) as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {
    source: "audit",
    audit_id: detail.id,
    status: detail.status_code,
    latency_ms:
      typeof detail.duration_ns === "number" ? detail.duration_ns / 1_000_000 : undefined,
    usage: detail.usage,
    request_body: data.request_body,
    response_body: data.response_body,
    request_headers: data.request_headers,
    response_headers: data.response_headers,
  };
  // 1MB body-capture caps surface as flags instead of truncated bodies.
  for (const flag of [
    "request_body_too_big_to_handle",
    "response_body_too_big_to_handle",
  ] as const) {
    if (data[flag] === true) snapshot[flag] = true;
  }
  return snapshot;
}

/** Poll the audit log briefly for the entry of THIS request. */
async function findAuditEntry(
  deps: PlaygroundDeps,
  model: string,
  path: string,
  startedAt: Date,
): Promise<{ id?: string; missing: boolean }> {
  const startedIso = new Date(startedAt.getTime() - 1000).toISOString();
  // A short bounded window: two polls ~500ms apart. Misses are a normal
  // fallback (direct response), never an error.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const text = await deps.readAdmin(
        "get_audit_log",
        { requested_model: model, path, start_date: startedIso, limit: "10" },
        true,
      );
      const list = JSON.parse(text) as { entries?: Record<string, unknown>[] };
      const entries = Array.isArray(list.entries) ? list.entries : [];
      if (typeof entries[0]?.id === "string") return { id: entries[0].id as string, missing: false };
    } catch {
      // audit listing failed — fall through to the direct response
    }
  }
  return { missing: true };
}

async function readUserPathHeaderName(deps: PlaygroundDeps): Promise<string> {
  try {
    const text = await deps.readAdmin("get_runtime_config", {}, false);
    const config = JSON.parse(text) as Record<string, unknown>;
    const name = config.USER_PATH_HEADER;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // fall back to the default header name
  }
  return DEFAULT_USER_PATH_HEADER;
}

/**
 * Run a playground send. Validation failures (read-only, rejected headers,
 * rejected roles, non-2xx upstream) return `{kind: "error", text}` so the
 * caller can surface them through MCP's `isError` channel. Audit-reassembly
 * fallbacks (`source: "direct"` with a warning) keep `kind: "text"` — they
 * are documented behavior, not user errors.
 */
export type SendRunResult = { kind: "text"; text: string } | { kind: "error"; text: string };

function sendError(message: string): SendRunResult {
  // Match the wording of the dispatch-layer error path so callers that
  // already key off "invalid params for ..." keep working.
  return { kind: "error", text: `Error: ${message}` };
}

async function executeSend(
  deps: PlaygroundDeps,
  params: Record<string, unknown>,
): Promise<SendRunResult> {
  if (deps.readOnly) {
    return sendError(
      "send is disabled: this MCP server runs with GOMODEL_READ_ONLY=1 — playground inference requests are writes and are gated off",
    );
  }

  const endpoint = params.endpoint as string;
  const model = params.model as string;
  const messages = params.messages as { role: string; content: unknown }[] | undefined;
  const customHeaders = (params.headers ?? {}) as Record<string, string>;

  // Live user-path header name, then header rejection (before any network call).
  const userPathHeader = await readUserPathHeaderName(deps);
  const headerError = validateHeaderNames(customHeaders, userPathHeader);
  if (headerError) {
    return sendError(
      `invalid params for send:\n${headerError}\n\nCall admin_playground again with corrected params; omit "operation" to re-list this area's operations.`,
    );
  }

  const roleError = validateRoles(endpoint, messages);
  if (roleError) {
    return sendError(
      `invalid params for send:\n${roleError}\n\nCall admin_playground again with corrected params; omit "operation" to re-list this area's operations.`,
    );
  }

  // User path: explicit param wins; otherwise auto-send the FIRST entry of the
  // model's user_paths policy, mirroring the UI prefill.
  let userPath = typeof params.user_path === "string" ? params.user_path : undefined;
  let autoResolved = false;
  if (userPath === undefined) {
    try {
      const virtualModelsText = await deps.readAdmin("list_virtual_models", {}, false);
      const policyPath = firstUserPathPolicy(JSON.parse(virtualModelsText), model);
      if (policyPath) {
        userPath = policyPath;
        autoResolved = true;
      }
    } catch {
      // no virtual-model context — proceed without a user path
    }
  }

  const path = endpointPath(endpoint);
  const body = buildRequestBody({
    endpoint,
    model,
    messages,
    stream: params.stream as boolean | undefined,
    max_tokens: params.max_tokens as number | undefined,
    temperature: params.temperature as number | undefined,
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.apiKey}`, // always set by the tool, never caller-supplied
    "Content-Type": contentTypeFor(),
    ...customHeaders,
  };
  if (userPath !== undefined) headers[userPathHeader] = userPath;

  const startedAt = new Date();
  const startMs = Date.now();
  let res: Response;
  try {
    res = await fetch(`${deps.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendError(`public API request failed: ${message}`);
  }
  const latencyMs = Date.now() - startMs;

  let directBody: unknown;
  if (params.stream === true) {
    const sse = await res.text();
    directBody = res.ok ? assembleStream(endpoint, sse) : sse.slice(0, 2000);
  } else {
    const raw = await res.text();
    try {
      directBody = JSON.parse(raw);
    } catch {
      directBody = raw.slice(0, 2000);
    }
  }
  if (!res.ok) {
    return sendError(
      `public API ${res.status} ${res.statusText}: ${JSON.stringify(directBody).slice(0, 2000)}`,
    );
  }

  // Audit reassembly: find THIS request's entry, then fetch its detail.
  // All three fallback branches below are documented behavior (entry not
  // found, detail fetch fails, LOGGING_LOG_BODIES=false), not user errors —
  // they keep `kind: "text"` and surface `source: "direct"` with a warning.
  const found = await findAuditEntry(deps, model, path, startedAt);
  if (found.missing || !found.id) {
    return {
      kind: "text",
      text: JSON.stringify({
        source: "direct",
        warning:
          "audit entry for this request not found within the lookup window — returned the direct API response instead",
        status: res.status,
        latency_ms: latencyMs,
        response: directBody,
      }),
    };
  }

  let detail: Record<string, unknown>;
  try {
    const detailText = await deps.readAdmin("get_audit_detail", { log_id: found.id }, true);
    detail = JSON.parse(detailText) as Record<string, unknown>;
  } catch {
    return {
      kind: "text",
      text: JSON.stringify({
        source: "direct",
        warning: `audit detail for entry ${found.id} could not be fetched — returned the direct API response instead`,
        status: res.status,
        latency_ms: latencyMs,
        response: directBody,
      }),
    };
  }

  const data = (detail.data ?? {}) as Record<string, unknown>;
  const hasBodies = data.request_body !== undefined || data.response_body !== undefined;
  const bodiesTooBig =
    data.request_body_too_big_to_handle === true || data.response_body_too_big_to_handle === true;
  if (!hasBodies && !bodiesTooBig) {
    // LOGGING_LOG_BODIES=false on the gateway: bodies never reach the audit
    // trail, so the audit panel view is impossible — return the direct response.
    return {
      kind: "text",
      text: JSON.stringify({
        source: "direct",
        audit_id: detail.id,
        warning:
          "request/response bodies are absent from the audit entry — enable LOGGING_LOG_BODIES=true on the gateway to get the full audit reassembly; returned the direct API response instead",
        status: detail.status_code ?? res.status,
        latency_ms:
          typeof detail.duration_ns === "number" ? detail.duration_ns / 1_000_000 : latencyMs,
        usage: detail.usage,
        response: directBody,
      }),
    };
  }

  const snapshot = pickAuditSnapshot(detail);
  if (autoResolved) snapshot.user_path = userPath;
  return { kind: "text", text: JSON.stringify(snapshot) };
}

async function executeContext(
  deps: PlaygroundDeps,
  bypass: boolean,
): Promise<SendRunResult> {
  const [configText, modelsText, virtualText] = await Promise.all([
    deps.readAdmin("get_runtime_config", {}, bypass),
    deps.readAdmin("list_models", {}, bypass),
    deps.readAdmin("list_virtual_models", {}, bypass),
  ]);
  const config = JSON.parse(configText) as Record<string, unknown>;
  const models = JSON.parse(modelsText) as unknown;
  const virtualModels = JSON.parse(virtualText) as unknown;

  const modelList = Array.isArray(models) ? models : [];
  const compactModels = modelList
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => {
      const model = entry.model as Record<string, unknown> | string | undefined;
      const access = entry.access as Record<string, unknown> | string | undefined;
      return {
        selector: entry.selector,
        model: typeof model === "object" && model !== null ? model.id : model,
        provider: entry.provider_name,
        access:
          typeof access === "object" && access !== null
            ? (access.status ?? access.state ?? access)
            : access,
      };
    });

  const virtualList = Array.isArray(virtualModels) ? virtualModels : [];
  const compactVirtual = virtualList
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      source: entry.source,
      enabled: entry.enabled,
      user_paths: entry.user_paths,
    }));

  const headerName = config.USER_PATH_HEADER;
  return {
    kind: "text",
    text: JSON.stringify({
      user_path_header:
        typeof headerName === "string" && headerName.trim()
          ? headerName.trim()
          : DEFAULT_USER_PATH_HEADER,
      models: compactModels,
      virtual_models: compactVirtual,
    }),
  };
}

/**
 * Run a playground operation. Returns a discriminated union the caller routes
 * to MCP `isError`/text content based on `kind`. Context is always text;
 * send surfaces read-only refusals, credential/user-path-header rejections,
 * role validation, and non-2xx upstream responses as `kind: "error"`.
 */
export async function runPlaygroundOp(
  operation: "context" | "send",
  params: Record<string, unknown>,
  deps: PlaygroundDeps,
  bypass: boolean,
): Promise<SendRunResult> {
  if (operation === "context") return executeContext(deps, bypass);
  return executeSend(deps, params);
}
