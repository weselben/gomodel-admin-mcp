import { z } from "zod";

/**
 * Declarative table of every read-only (GET) endpoint of the GoModel admin
 * REST API. Source: internal/admin/routes.go plus the Swagger 2 annotations
 * extracted into spec/admin-swagger.json.
 *
 * The MCP server exposes these tools alongside mutating tools declared in
 * write-tools.ts (gated at registration time, so the server is not fully
 * read-only by construction).
 */

export interface QueryParam {
  name: string;
  description: string;
  required?: boolean;
}

export interface AdminTool {
  /** MCP tool name. */
  name: string;
  /** Admin API path relative to {base}/admin, may contain {param} placeholders. */
  path: string;
  description: string;
  /** Query parameters, all passed as strings. */
  query?: QueryParam[];
}

const timeRange: QueryParam[] = [
  { name: "days", description: "Lookback window in days (alternative to start_date/end_date)" },
  { name: "start_date", description: "Range start, RFC3339 or YYYY-MM-DD" },
  { name: "end_date", description: "Range end, RFC3339 or YYYY-MM-DD" },
];

const usageFilters: QueryParam[] = [
  ...timeRange,
  { name: "model", description: "Filter by model id" },
  { name: "provider", description: "Filter by provider name" },
  { name: "label", description: "Filter by request label" },
  { name: "user_path", description: "Filter by user path" },
  { name: "cache_mode", description: "Filter by cache mode (e.g. all, cached_only, bypass)" },
];

const auditFilters: QueryParam[] = [
  ...timeRange,
  { name: "requested_model", description: "Filter by requested model id" },
  { name: "provider", description: "Filter by provider name" },
  { name: "method", description: "Filter by HTTP method" },
  { name: "path", description: "Filter by request path" },
  { name: "user_path", description: "Filter by user path" },
  { name: "error_type", description: "Filter by error type" },
  { name: "status_code", description: "Filter by HTTP status code" },
  { name: "stream", description: "Filter streaming requests (true/false)" },
  { name: "search", description: "Free-text search" },
  { name: "limit", description: "Page size" },
  { name: "offset", description: "Page offset" },
];

export const ADMIN_TOOLS: AdminTool[] = [
  {
    name: "get_runtime_config",
    path: "/runtime/config",
    description: "Get the admin runtime configuration (feature flags and dashboard settings).",
  },
  {
    name: "get_cache_overview",
    path: "/cache/overview",
    description: "Get the cached-only usage overview for the semantic/exact cache.",
    query: [...usageFilters, { name: "interval", description: "Bucket interval (e.g. hour, day)" }],
  },
  {
    name: "get_live_logs",
    path: "/live/logs",
    description:
      "Stream live audit log events (SSE) for a short window and return the collected events.",
  },
  {
    name: "get_usage_summary",
    path: "/usage/summary",
    description: "Get the aggregated usage summary (requests, tokens, cost).",
    query: usageFilters,
  },
  {
    name: "get_usage_daily",
    path: "/usage/daily",
    description: "Get the usage breakdown bucketed by period.",
    query: [...usageFilters, { name: "interval", description: "Bucket interval (e.g. hour, day)" }],
  },
  {
    name: "get_usage_by_model",
    path: "/usage/models",
    description: "Get the usage breakdown grouped by model.",
    query: usageFilters,
  },
  {
    name: "get_usage_by_user_path",
    path: "/usage/user-paths",
    description: "Get the usage breakdown grouped by user path.",
    query: usageFilters,
  },
  {
    name: "get_usage_by_label",
    path: "/usage/labels",
    description: "Get the usage breakdown grouped by request label.",
    query: usageFilters,
  },
  {
    name: "get_usage_log",
    path: "/usage/log",
    description: "Get paginated usage log entries.",
    query: [
      ...usageFilters,
      { name: "search", description: "Free-text search" },
      { name: "limit", description: "Page size" },
      { name: "offset", description: "Page offset" },
    ],
  },
  {
    name: "get_token_throughput",
    path: "/usage/throughput",
    description: "Get the live token-throughput window.",
    query: [
      { name: "granularity", description: "Bucket granularity (e.g. second, minute)", required: true },
    ],
  },
  {
    name: "get_audit_log",
    path: "/audit/log",
    description: "Get paginated audit log entries.",
    query: auditFilters,
  },
  {
    name: "get_audit_sessions",
    path: "/audit/sessions",
    description: "Get paginated audit sessions (conversation threads).",
    query: [
      ...auditFilters.filter((p) => p.name !== "search"),
      { name: "session_id", description: "Filter by session id" },
      { name: "search", description: "Free-text search" },
    ],
  },
  {
    name: "get_audit_stats",
    path: "/audit/stats",
    description: "Get time-bucketed request status and latency statistics.",
    query: timeRange,
  },
  {
    name: "get_audit_detail",
    path: "/audit/detail",
    description: "Get the full detail of one audit log entry.",
    query: [{ name: "log_id", description: "Audit log entry id", required: true }],
  },
  {
    name: "get_audit_conversation",
    path: "/audit/conversation",
    description: "Get the conversation thread surrounding an audit log entry.",
    query: [
      { name: "log_id", description: "Audit log entry id", required: true },
      { name: "limit", description: "Maximum number of surrounding entries" },
    ],
  },
  {
    name: "get_media",
    path: "/media/{id}",
    description:
      "Download a stored media object (audio/image) referenced by the audit log. Returns content type, byte size, and the bytes base64-encoded; oversized objects are bounded to the output byte cap with truncated: true.",
  },
  {
    name: "get_provider_status",
    path: "/providers/status",
    description: "Get health status and configuration summary for every configured provider.",
  },
  {
    name: "list_provider_credentials",
    path: "/provider-credentials",
    description: "List admin-managed model provider credentials (values are redacted).",
  },
  {
    name: "list_provider_credential_types",
    path: "/provider-credentials/types",
    description: "List the provider types the gateway can construct, with their credential fields.",
  },
  {
    name: "list_budgets",
    path: "/budgets",
    description: "List budgets with their current spend status.",
  },
  {
    name: "get_budget_settings",
    path: "/budgets/settings",
    description: "Get the budget reset settings.",
  },
  {
    name: "list_rate_limits",
    path: "/rate-limits",
    description: "List rate limit rules with live counter status.",
  },
  {
    name: "get_tagging_settings",
    path: "/tagging/settings",
    description: "Get the header tagging rules.",
  },
  {
    name: "list_models",
    path: "/models",
    description: "List all registered models with provider info and access state.",
    query: [{ name: "category", description: "Filter by model category" }],
  },
  {
    name: "list_model_categories",
    path: "/models/categories",
    description: "List model categories with model counts.",
  },
  {
    name: "get_model_metadata",
    path: "/models/metadata",
    description:
      "Show where one model's metadata comes from: the merged metadata plus each layer (provider listing, catalog entry, config override) and the winning source per field.",
    query: [
      { name: "provider", description: "Provider instance name or provider type", required: true },
      { name: "model", description: "Raw upstream model id", required: true },
    ],
  },
  {
    name: "list_virtual_models",
    path: "/virtual-models",
    description: "List virtual models (redirects and access policies).",
  },
  {
    name: "list_mcp_servers",
    path: "/mcp-servers",
    description: "List MCP servers (config-declared and admin-managed).",
  },
  {
    name: "get_mcp_server_catalog",
    path: "/mcp-servers/{name}/catalog",
    description: "Inspect one MCP server's current tool/prompt/resource catalog.",
  },
  {
    name: "list_failover_rules",
    path: "/failover",
    description: "List failover mappings between models.",
  },
  {
    name: "list_model_pricing_overrides",
    path: "/model-pricing-overrides",
    description: "List model pricing overrides.",
  },
  {
    name: "list_auth_keys",
    path: "/auth-keys",
    description: "List gateway API keys (values are redacted).",
  },
  {
    name: "list_guardrails",
    path: "/guardrails",
    description: "List configured guardrails.",
  },
  {
    name: "list_guardrail_types",
    path: "/guardrails/types",
    description: "List the available guardrail types with their configuration fields.",
  },
  {
    name: "list_workflows",
    path: "/workflows",
    description: "List workflows with scope and feature payload.",
  },
  {
    name: "list_workflow_guardrails",
    path: "/workflows/guardrails",
    description: "List the guardrail names available for workflow authoring.",
  },
  {
    name: "get_workflow",
    path: "/workflows/{id}",
    description: "Get one workflow by id.",
  },
  {
    name: "get_access_overview",
    path: "/access",
    description:
      "Describe the caller's admin scope: whether the credential administers the whole gateway or only one user-path subtree.",
  },
  {
    name: "get_runtime_settings",
    path: "/runtime/settings",
    description: "List extension-defined settings for the Dashboard.",
  },
  {
    name: "get_usage_by_session",
    path: "/usage/sessions",
    description:
      "Get usage breakdown by detected session. Returns a bounded page of request, token, and cost aggregates for detected, user-path-scoped sessions.",
    query: [
      ...usageFilters,
      { name: "session_id", description: "Filter by exact detected session ID" },
      { name: "limit", description: "Page size (default 50, max 200)" },
      { name: "offset", description: "Offset for pagination" },
    ],
  },
  {
    name: "list_plugins",
    path: "/plugins",
    description:
      "List every loaded plugin type with its manifest, hook kinds, config schema, source and health.",
  },
  {
    name: "list_users",
    path: "/users",
    description:
      "List user-path policies (access-tree nodes with allowed models and descriptions).",
  },
];

/** Zod shape for a tool's path/query parameters. */
export function inputSchemaFor(tool: AdminTool) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const match of tool.path.matchAll(/\{(\w+)\}/g)) {
    shape[match[1]] = z.string().describe(`Path parameter: ${match[1]}`);
  }
  for (const param of tool.query ?? []) {
    const field = z.string().describe(param.description);
    shape[param.name] = param.required ? field : field.optional();
  }
  if (tool.name === "get_live_logs") {
    shape.seconds = z
      .string()
      .optional()
      .describe("How long to collect SSE events, in seconds (default 5, max 30)");
  }
  return shape;
}
