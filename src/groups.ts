import type { AdminTool } from "./tools.js";
import type { WriteTool } from "./write-tools.js";

/**
 * Tool grouping, one entry per README area. Each group becomes one MCP
 * tool (`admin_<name>`); its `operation` argument selects one of the
 * underlying tools. Gradual discovery: omitting `operation` lists the
 * group's operations, an unknown one errors with the valid list.
 */

export interface ToolGroup {
  name: string;
  description: string;
  /** Operation name → one-line hint, in registration order. */
  operations: Record<string, string>;
  kind: "read" | "write";
}

function ops(entries: [string, string][]): Record<string, string> {
  return Object.fromEntries(entries);
}

export const READ_GROUPS: ToolGroup[] = [
  {
    name: "runtime",
    description: "Gateway runtime state: feature flags, dashboard settings, provider health.",
    operations: ops([
      ["get_runtime_config", "admin runtime configuration (feature flags, dashboard settings)"],
      ["get_runtime_settings", "extension-defined dashboard settings"],
      ["get_provider_status", "health + config summary for every provider"],
    ]),
    kind: "read",
  },
  {
    name: "usage",
    description: "Usage analytics: summaries, breakdowns, per-session, throughput.",
    operations: ops([
      ["get_usage_summary", "aggregated requests, tokens, cost"],
      ["get_usage_daily", "breakdown bucketed by period"],
      ["get_usage_by_model", "grouped by model"],
      ["get_usage_by_user_path", "grouped by user path"],
      ["get_usage_by_label", "grouped by request label"],
      ["get_usage_by_session", "per detected session"],
      ["get_usage_log", "paginated usage log entries"],
      ["get_token_throughput", "live token-throughput window"],
    ]),
    kind: "read",
  },
  {
    name: "audit",
    description: "Audit trail: request logs, sessions, stats, detail, conversation threads, live stream.",
    operations: ops([
      ["get_audit_log", "paginated audit log entries"],
      ["get_audit_sessions", "conversation threads"],
      ["get_audit_stats", "status + latency statistics"],
      ["get_audit_detail", "full detail of one entry"],
      ["get_audit_conversation", "thread around one entry"],
      ["get_live_logs", "SSE live events, bounded window"],
    ]),
    kind: "read",
  },
  {
    name: "cache",
    description: "Semantic/exact cache overview.",
    operations: ops([["get_cache_overview", "cached-only usage overview"]]),
    kind: "read",
  },
  {
    name: "models",
    description: "Model registry, categories, virtual models, pricing overrides.",
    operations: ops([
      ["list_models", "all registered models with provider info"],
      ["list_model_categories", "categories with model counts"],
      ["list_virtual_models", "redirects and access policies"],
      ["list_model_pricing_overrides", "pricing overrides"],
    ]),
    kind: "read",
  },
  {
    name: "providers",
    description: "Admin-managed provider credentials (redacted) and supported types.",
    operations: ops([
      ["list_provider_credentials", "credentials, values redacted"],
      ["list_provider_credential_types", "types with their credential fields"],
    ]),
    kind: "read",
  },
  {
    name: "governance",
    description: "Budgets, rate limits, tagging, guardrails, failover, auth keys, users, plugins.",
    operations: ops([
      ["list_budgets", "budgets with spend status"],
      ["get_budget_settings", "budget reset settings"],
      ["list_rate_limits", "rules with live counters"],
      ["get_tagging_settings", "header tagging rules"],
      ["list_guardrails", "configured guardrails"],
      ["list_guardrail_types", "available types with config fields"],
      ["list_failover_rules", "failover mappings"],
      ["list_auth_keys", "API keys, values redacted"],
      ["get_access_overview", "caller's admin scope"],
      ["list_users", "user-path policies"],
      ["list_plugins", "loaded plugins with health"],
    ]),
    kind: "read",
  },
  {
    name: "workflows",
    description: "Workflows and the guardrails available for authoring them.",
    operations: ops([
      ["list_workflows", "workflows with scope and payload"],
      ["list_workflow_guardrails", "guardrails available for authoring"],
      ["get_workflow", "one workflow by id"],
    ]),
    kind: "read",
  },
  {
    name: "mcp_servers",
    description: "MCP servers known to the gateway and their catalogs.",
    operations: ops([
      ["list_mcp_servers", "config-declared and admin-managed"],
      ["get_mcp_server_catalog", "one server's tool/prompt/resource catalog"],
    ]),
    kind: "read",
  },
];

export const WRITE_GROUPS: ToolGroup[] = [
  {
    name: "runtime_control",
    description: "Runtime control: update settings, trigger a runtime refresh.",
    operations: ops([
      ["update_runtime_setting", "set one dashboard setting"],
      ["refresh_runtime", "rebuild runtime from current config"],
    ]),
    kind: "write",
  },
  {
    name: "usage_control",
    description: "Usage control: recalculate pricing for recorded usage.",
    operations: ops([["recalculate_usage_pricing", "recalculate cost for recorded usage"]]),
    kind: "write",
  },
  {
    name: "provider_control",
    description: "Provider credentials: upsert or delete admin-managed credentials.",
    operations: ops([
      ["upsert_provider_credential", "create/update credentials ('***' preserves stored values)"],
      ["delete_provider_credential", "remove by provider name"],
    ]),
    kind: "write",
  },
  {
    name: "governance_control",
    description: "Governance control: budgets, rate limits, tagging, guardrails, failover, users.",
    operations: ops([
      ["upsert_budget", "create/update a budget"],
      ["delete_budget", "delete a budget"],
      ["update_budget_settings", "budget reset schedule"],
      ["reset_budget", "reset one budget's counters"],
      ["reset_all_budgets", "reset all budgets (confirmation: 'reset')"],
      ["reset_all_rate_limits", "reset all rate limits (confirmation: 'reset')"],
      ["update_tagging_settings", "header tagging rules"],
      ["upsert_guardrail", "create/update a guardrail"],
      ["delete_guardrail", "delete a guardrail by name"],
      ["upsert_failover_rule", "create/update failover mapping"],
      ["delete_failover_rule", "delete failover mapping"],
      ["upsert_user", "create/update user-path policy"],
      ["delete_user", "delete user-path policy"],
    ]),
    kind: "write",
  },
  {
    name: "auth_keys",
    description: "API keys: create, labels, allowed models, dashboard access, deactivate.",
    operations: ops([
      ["create_auth_key", "issue a new gateway API key"],
      ["update_auth_key_labels", "replace a key's labels"],
      ["update_auth_key_allowed_models", "replace a key's model allowlist"],
      ["update_auth_key_dashboard_access", "toggle dashboard access"],
      ["deactivate_auth_key", "deactivate a key"],
    ]),
    kind: "write",
  },
  {
    name: "virtual_models",
    description: "Virtual models: redirects, load-balanced targets, access policies.",
    operations: ops([
      ["upsert_virtual_model", "create/update/rename; alias, load-balanced, or access policy"],
      ["delete_virtual_model", "delete by source name"],
    ]),
    kind: "write",
  },
  {
    name: "pricing_overrides",
    description: "Model pricing overrides by selector scope.",
    operations: ops([
      ["upsert_model_pricing_override", "create/update; scopes '/', 'provider/', 'model', 'provider/model'"],
      ["delete_model_pricing_override", "delete by selector"],
    ]),
    kind: "write",
  },
  {
    name: "rate_limits",
    description: "Rate limit rules: upsert, delete, reset counters.",
    operations: ops([
      ["upsert_rate_limit", "create/update a rule"],
      ["delete_rate_limit", "delete a rule"],
      ["reset_rate_limit", "reset one rule's counters"],
    ]),
    kind: "write",
  },
  {
    name: "workflows_control",
    description: "Workflow control: create and deactivate workflows.",
    operations: ops([
      ["create_workflow", "create a workflow"],
      ["deactivate_workflow", "deactivate by id"],
    ]),
    kind: "write",
  },
  {
    name: "mcp_servers_control",
    description: "MCP server management: upsert, delete, reconnect.",
    operations: ops([
      ["upsert_mcp_server", "create/update an admin-managed MCP server"],
      ["delete_mcp_server", "delete by slug"],
      ["reconnect_mcp_server", "drop and re-establish the connection"],
    ]),
    kind: "write",
  },
];

/** Resolve an operation to its underlying tool within a group. */
export function resolveOperation(
  group: ToolGroup,
  operation: string,
  reads: Map<string, AdminTool>,
  writes: Map<string, WriteTool>,
): AdminTool | WriteTool | undefined {
  const pool = group.kind === "read" ? reads : writes;
  if (!Object.prototype.hasOwnProperty.call(group.operations, operation)) return undefined;
  return pool.get(operation);
}
