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
  { name: "session_id", description: "Filter by exact detected session ID" },
  { name: "auth_key_id", description: "Filter by exact managed auth key ID" },
  { name: "model", description: "Filter by model id" },
  { name: "provider", description: "Filter by provider name" },
  { name: "label", description: "Filter by request label" },
  { name: "user_path", description: "Filter by user path" },
  { name: "endpoint", description: "Filter by exact request endpoint, e.g. /v1/chat-completions" },
  { name: "operation", description: "Filter by comma-separated operations, e.g. chat_completions" },
  { name: "cache_mode", description: "Filter by cache mode (e.g. all, cached_only, bypass)" },
];

const auditFilters: QueryParam[] = [
  ...timeRange,
  { name: "session_id", description: "Filter by exact session id" },
  { name: "exclude_operation", description: "Comma-separated endpoint operations to hide, e.g. mcp,provider_passthrough,audio_speech" },
  { name: "requested_model", description: "Filter by requested model id" },
  { name: "provider", description: "Filter by provider name" },
  { name: "method", description: "Filter by HTTP method" },
  { name: "path", description: "Filter by request path" },
  { name: "user_path", description: "Filter by user path" },
  { name: "user_path_prefix", description: "Filter by user path prefix" },
  { name: "model_prefix", description: "Filter by requested model id prefix" },
  { name: "request_id", description: "Filter by request id" },
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
      // /audit/sessions filters threads, not entries — no session_id filter.
      ...auditFilters.filter((p) => p.name !== "search" && p.name !== "session_id"),
      { name: "search", description: "Free-text search" },
      { name: "session_id", description: "Filter by exact detected session id" },
    ],
  },
  {
    name: "get_audit_stats",
    path: "/audit/stats",
    description: "Get time-bucketed request status and latency statistics.",
    query: [...timeRange, { name: "user_path", description: "Filter by user path" }],
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
    name: "list_mcp_virtual_servers",
    path: "/mcp-virtual-servers",
    description:
      "List virtual MCP servers (config-declared, read-only). Each serves a subset of the MCP servers at /mcp/{name}; missing_servers lists members no server matches, conflict explains why a virtual server is not served.",
  },
  {
    name: "get_mcp_tool_catalog",
    path: "/mcp-servers/catalog",
    description:
      "Export every tool the MCP servers report, one row per tool with its server, for security reviews and audits. Rows carry exposure state (exposed, shadowed_by), read_only/destructive hints, and each server's transport, enabled flag, status, and user-path scope.",
    query: [
      { name: "format", description: "Export format: json (default) or csv (as an attachment)" },
      { name: "server", description: "Keep the rows of one MCP server, by slug" },
      { name: "virtual_server", description: "Keep the members of one virtual MCP server" },
      { name: "user_path", description: "Keep the servers a caller with this user path can see, e.g. /team/x" },
    ],
  },
  {
    name: "get_usage_benchmark",
    path: "/usage/benchmark",
    description:
      "Benchmark the monthly cost per active user of a group. Each direct child of parent counts as one user; per calendar month returns active users, total/mean/median/p90/max cost per active user, plus unpriced and unattributed cost.",
    query: [
      { name: "parent", description: "Group whose direct children are the users, e.g. /eng (default: the credential's scope root, or /)" },
      { name: "months", description: "Number of months ending at end_month, 1-12 (default 7); ignored with start_month" },
      { name: "start_month", description: "First month (YYYY-MM, default: months before end_month)" },
      { name: "end_month", description: "Last month (YYYY-MM, default and latest: the current month)" },
      { name: "cost_basis", description: "provider (default) or billed; billed requires pricing.markups_enabled" },
      { name: "top_users", description: "List each month's N highest-cost users (0-50, default 0: aggregates only)" },
      { name: "model", description: "Filter by exact model names; repeat or comma-separate for several" },
      { name: "provider", description: "Filter by provider names or types; repeat or comma-separate for several" },
      { name: "label", description: "Filter by request labels (exact match); repeat for several" },
      { name: "endpoint", description: "Filter by exact request endpoints, e.g. /v1/chat/completions; repeat or comma-separate for several" },
      { name: "operation", description: "Filter by comma-separated operations, e.g. chat_completions,embeddings" },
      { name: "session_id", description: "Filter by exact detected session ID" },
      { name: "auth_key_id", description: "Filter by managed auth key IDs; repeat or comma-separate for several" },
      { name: "user_path", description: "Filter by tracked user path subtrees; repeat for several" },
    ],
  },
  {
    name: "get_usage_breakdown",
    path: "/usage/breakdown",
    description:
      "Pivot the filtered usage by a row and an optional column dimension. Keys rank by the metric; those past limit fold into a trailing \"other\" key. Period keys follow interval and are never folded.",
    query: [
      { name: "rows", description: "Row dimension: model, provider, user_path, label, endpoint, auth_key, period", required: true },
      { name: "columns", description: "Column dimension (same values, different from rows); omit or none for one column" },
      { name: "metric", description: "Ranking metric for the top-N cut: cost, tokens, requests (default cost)" },
      { name: "limit", description: "Keys kept per dimension before the rest fold into other (default 10, max 50)" },
      { name: "user_path_depth", description: "Group user paths by their first N segments (0 keeps full paths, max 16)" },
      ...timeRange,
      { name: "interval", description: "Period grouping: daily, weekly, monthly, yearly (default daily)" },
      { name: "model", description: "Filter by exact model names; repeat or comma-separate for several" },
      { name: "provider", description: "Filter by provider names or types; repeat or comma-separate for several" },
      { name: "label", description: "Filter by request labels (exact match); repeat for several" },
      { name: "endpoint", description: "Filter by exact request endpoints, e.g. /v1/chat/completions; repeat or comma-separate for several" },
      { name: "operation", description: "Filter by comma-separated operations, e.g. chat_completions,embeddings" },
      { name: "session_id", description: "Filter by exact detected session ID" },
      { name: "auth_key_id", description: "Filter by managed auth key IDs; repeat or comma-separate for several" },
      { name: "user_path", description: "Filter by tracked user path subtrees; repeat for several" },
      { name: "cache_mode", description: "Cache mode filter: uncached, cached, all (default uncached)" },
    ],
  },
  {
    name: "get_usage_endpoints",
    path: "/usage/endpoints",
    description:
      "Get per-endpoint token and cost aggregates. Each row names the operation its endpoint belongs to, so endpoints that mean the same thing can be folded: /v1/chat/completions and /v1/messages are both chat_completions.",
    query: usageFilters,
  },
  {
    name: "get_usage_invoice",
    path: "/usage/invoice",
    description:
      "Export billed usage for the period, one block of model/provider line items per customer user path, with subtotals and a grand total. Amounts are USD. Requires a GoModel Pro license with the billing entitlement and pricing.markups_enabled.",
    query: [
      { name: "format", description: "Export format: csv (default, as an attachment) or json" },
      { name: "parent", description: "Bill each direct child of this user path as one customer, e.g. /customers" },
      ...timeRange,
      { name: "model", description: "Filter by exact model names; repeat or comma-separate for several" },
      { name: "provider", description: "Filter by provider names or types; repeat or comma-separate for several" },
      { name: "label", description: "Filter by request labels (exact match); repeat for several" },
      { name: "endpoint", description: "Filter by exact request endpoints, e.g. /v1/chat/completions; repeat or comma-separate for several" },
      { name: "operation", description: "Filter by comma-separated operations, e.g. chat_completions,embeddings" },
      { name: "session_id", description: "Filter by exact detected session ID" },
      { name: "auth_key_id", description: "Filter by managed auth key IDs; repeat or comma-separate for several" },
      { name: "user_path", description: "Filter by tracked user path subtrees; repeat for several" },
    ],
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
      // /admin/usage/sessions takes no cache_mode filter; session_id and the
      // rest come from usageFilters.
      ...usageFilters.filter((p) => p.name !== "cache_mode"),
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
