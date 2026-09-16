import { z } from "zod";

/**
 * Write (mutating) admin tools, mirroring what the GoModel dashboard UI can
 * change: virtual models, failover rules, model pricing overrides, rate
 * limits, and auth-key labels.
 *
 * Contracts come from internal/admin/handler_*.go in the GoModel repo.
 */

export interface WriteTool {
  name: string;
  method: "PUT" | "DELETE" | "POST";
  /** Admin API path relative to {base}/admin, may contain {param} placeholders. */
  path: string;
  description: string;
  /** Zod raw shape for the tool arguments. */
  schema: Record<string, z.ZodTypeAny>;
  /** Build the JSON request body from validated arguments. */
  body: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** Copy the defined entries of source into a new object. */
function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const PRICING_FIELDS = [
  "input_per_mtok",
  "output_per_mtok",
  "cached_input_per_mtok",
  "cache_write_per_mtok",
  "reasoning_output_per_mtok",
  "batch_input_per_mtok",
  "batch_output_per_mtok",
  "audio_input_per_mtok",
  "audio_output_per_mtok",
  "per_image",
  "input_per_image",
  "per_second_input",
  "per_second_output",
  "per_character_input",
  "per_request",
] as const;

const pricingSchema: Record<string, z.ZodTypeAny> = Object.fromEntries(
  PRICING_FIELDS.map((field) => [
    field,
    z.number().optional().describe(`USD price component: ${field}`),
  ]),
);

const rateLimitKeyArgs = {
  period: z
    .string()
    .optional()
    .describe("Window name: minute, hour, day, concurrent — or seconds as a string"),
  period_seconds: z
    .number()
    .optional()
    .describe("Window length in seconds; 0 means concurrent. Mutually exclusive with period"),
};

const rateLimitScopeArgs = {
  scope: z
    .string()
    .optional()
    .describe("Rule scope: user_path (default), provider, or model"),
  subject: z
    .string()
    .optional()
    .describe("Rule subject (provider or model name; user_path names user-path rules)"),
  user_path: z.string().optional().describe("User path (natural spelling for user-path rules)"),
};

const taggingRuleSchema: Record<string, z.ZodTypeAny> = {
  header: z.string().describe("Canonical HTTP header name to read labels from"),
  prefix: z.string().optional().describe("Prefix to strip from each label (only affects extracted label)"),
  delimiter: z.string().optional().describe("Delimiter to split one header value into multiple labels (default ',')"),
  do_not_pass: z.boolean().optional().describe("Strip the header before forwarding upstream (default false)"),
  managed: z.boolean().optional().describe("True when the rule is declared in config/env (read-only)"),
};

export const WRITE_TOOLS: WriteTool[] = [
  {
    name: "upsert_virtual_model",
    method: "PUT",
    path: "/virtual-models",
    description:
      "Create, update, or rename one virtual model. With target_model or targets it is a redirect (single alias or load-balanced across targets by strategy); without them it is an access policy. Set old_source to rename.",
    schema: {
      source: z.string().describe("Virtual model name (the id clients request)"),
      old_source: z.string().optional().describe("Rename from this existing source"),
      target_model: z
        .string()
        .optional()
        .describe('Single redirect target, e.g. "openai/gpt-4o" (shorthand for one target)'),
      targets: z
        .array(
          z.object({
            provider: z.string().optional(),
            model: z.string(),
            weight: z.number().optional().describe("round_robin weight, default 1"),
          }),
        )
        .optional()
        .describe("Load-balancing destinations; takes precedence over target_model"),
      strategy: z.string().optional().describe('Balancing strategy: "round_robin", "cost", or "adaptive"'),
      session_affinity: z
        .boolean()
        .optional()
        .describe("Keep a session on its previous target (default true)"),
      user_paths: z.array(z.string()).optional().describe("Restrict to these user paths"),
      description: z.string().optional(),
      enabled: z.boolean().optional().describe("Default true; preserves existing value when omitted"),
    },
    body: (args) => pick(args, [
      "source",
      "old_source",
      "target_model",
      "targets",
      "strategy",
      "session_affinity",
      "user_paths",
      "description",
      "enabled",
    ]),
  },
  {
    name: "delete_virtual_model",
    method: "DELETE",
    path: "/virtual-models",
    description: "Delete one virtual model by source name.",
    schema: {
      source: z.string().describe("Virtual model source to remove"),
    },
    body: (args) => pick(args, ["source"]),
  },
  {
    name: "upsert_failover_rule",
    method: "PUT",
    path: "/failover",
    description:
      "Create or update one failover mapping: when the primary model fails, requests fall back to the listed models in order.",
    schema: {
      primary_model: z.string().describe("Primary model id"),
      fallback_models: z.array(z.string()).describe("Ordered fallback model ids"),
      enabled: z.boolean().optional().describe("Default true; preserves existing value when omitted"),
    },
    body: (args) => pick(args, ["primary_model", "fallback_models", "enabled"]),
  },
  {
    name: "delete_failover_rule",
    method: "DELETE",
    path: "/failover",
    description: "Delete one failover mapping by primary model.",
    schema: {
      primary_model: z.string().describe("Primary model of the mapping to remove"),
    },
    body: (args) => pick(args, ["primary_model"]),
  },
  {
    name: "upsert_model_pricing_override",
    method: "PUT",
    path: "/model-pricing-overrides",
    description:
      'Create or update a USD pricing override. Selector scopes: global "/", provider-wide "provider/", model-wide "model", or exact "provider/model". More precise selectors win at runtime.',
    schema: {
      selector: z
        .string()
        .describe('Pricing scope: "/", "provider/", "model", or "provider/model"'),
      ...pricingSchema,
    },
    body: (args) => ({
      selector: args.selector,
      pricing: pick(args, [...PRICING_FIELDS]),
    }),
  },
  {
    name: "delete_model_pricing_override",
    method: "DELETE",
    path: "/model-pricing-overrides",
    description: "Delete one model pricing override by selector.",
    schema: {
      selector: z.string().describe("Selector of the override to remove"),
    },
    body: (args) => pick(args, ["selector"]),
  },
  {
    name: "upsert_rate_limit",
    method: "PUT",
    path: "/rate-limits",
    description:
      "Create or update one rate limit rule. Identify the rule by scope + subject (or user_path) + window (period or period_seconds); set max_requests and/or max_tokens.",
    schema: {
      ...rateLimitScopeArgs,
      ...rateLimitKeyArgs,
      max_requests: z.number().optional().describe("Maximum requests per window"),
      max_tokens: z.number().optional().describe("Maximum tokens per window"),
    },
    body: (args) => ({
      ...pick(args, ["scope", "subject", "user_path"]),
      limit_key: pick(args, ["period", "period_seconds"]),
      ...pick(args, ["max_requests", "max_tokens"]),
    }),
  },
  {
    name: "delete_rate_limit",
    method: "DELETE",
    path: "/rate-limits",
    description: "Delete one rate limit rule by scope + subject (or user_path) + window.",
    schema: {
      ...rateLimitScopeArgs,
      ...rateLimitKeyArgs,
    },
    body: (args) => ({
      ...pick(args, ["scope", "subject", "user_path"]),
      limit_key: pick(args, ["period", "period_seconds"]),
    }),
  },
  {
    name: "reset_rate_limit",
    method: "POST",
    path: "/rate-limits/reset-one",
    description: "Reset the live counters of one rate limit rule.",
    schema: {
      ...rateLimitScopeArgs,
      ...rateLimitKeyArgs,
    },
    body: (args) => pick(args, ["scope", "subject", "user_path", "period", "period_seconds"]),
  },
  {
    name: "update_auth_key_labels",
    method: "PUT",
    path: "/auth-keys/{id}/labels",
    description:
      "Replace the labels of one API key. The given list replaces the key's labels; an empty list clears them.",
    schema: {
      id: z.string().describe("Auth key id"),
      labels: z.array(z.string()).describe("New label set (replaces existing labels)"),
    },
    body: (args) => pick(args, ["labels"]),
  },

  // === Runtime ===
  {
    name: "update_runtime_setting",
    method: "PUT",
    path: "/runtime/settings/{key}",
    description: "Update one extension-defined runtime setting by key.",
    schema: {
      key: z.string().describe("Runtime setting key to update"),
      value: z.string().describe("New value for the setting"),
    },
    body: (args) => pick(args, ["value"]),
  },
  {
    name: "refresh_runtime",
    method: "POST",
    path: "/runtime/refresh",
    description:
      "Re-register providers and rebuild the effective configuration in the running gateway without a restart.",
    schema: {},
    body: () => ({}),
  },

  // === Provider Credentials ===
  {
    name: "upsert_provider_credential",
    method: "PUT",
    path: "/provider-credentials",
    description:
      "Create or update one admin-managed provider credential. A value of '***' or more asterisks in api_keys or service-account fields preserves the stored value. Registers the provider into the running gateway immediately.",
    schema: {
      name: z.string().describe("Unique provider credential name (must not contain '/')"),
      type: z.string().describe("Provider type from the registered types list"),
      api_keys: z.array(z.string()).optional().describe("API key(s) for the provider"),
      session_sticky_keys: z.boolean().optional().describe("Bind session cookies to specific provider keys"),
      base_url: z.string().optional().describe("Override the default API base URL"),
      api_version: z.string().optional().describe("API version to target"),
      backend: z.string().optional().describe("Override the backend implementation"),
      auth_type: z.string().optional().describe("Authentication type"),
      api_mode: z.string().optional().describe("API mode"),
      vertex_project: z.string().optional().describe("GCP Vertex AI project"),
      vertex_location: z.string().optional().describe("GCP Vertex AI location"),
      service_account_file: z.string().optional().describe("Path to a GCP service account key file"),
      service_account_json: z.string().optional().describe("GCP service account JSON (redacted on read/write)"),
      service_account_json_base64: z.string().optional().describe("GCP service account JSON encoded as base64"),
      gcp_scope: z.string().optional().describe("GCP scope for Vertex AI"),
      models: z.array(z.string()).optional().describe("Model names this credential applies to"),
      enabled: z.boolean().optional().describe("Whether this credential is active"),
    },
    body: (args) => pick(args, [
      "name", "type", "api_keys", "session_sticky_keys",
      "base_url", "api_version", "backend", "auth_type", "api_mode",
      "vertex_project", "vertex_location", "service_account_file",
      "service_account_json", "service_account_json_base64",
      "gcp_scope", "models", "enabled",
    ]),
  },
  {
    name: "delete_provider_credential",
    method: "DELETE",
    path: "/provider-credentials/{name}",
    description: "Delete one admin-managed provider credential by name (path param).",
    schema: {
      name: z.string().describe("Provider credential name to delete"),
    },
    body: () => ({}),
  },

  // === Budgets ===
  {
    name: "upsert_budget",
    method: "PUT",
    path: "/budgets",
    description: "Create or update one budget with an amount limit and a period window (scope + subject + budget_key).",
    schema: {
      scope: z.string().optional().describe("Budget scope: user_path, provider, model, or a label name"),
      subject: z.string().optional().describe("Budget subject (e.g. provider name or label value)"),
      user_path: z.string().optional().describe("User path for user-path budgets"),
      budget_key: z.object({
        period: z.string().optional().describe("Period name: hourly, daily, weekly, monthly, or seconds as a string"),
        period_seconds: z.number().optional().describe("Period window in seconds"),
      }).optional().describe("Period window for the budget"),
      amount: z.number().describe("Monthly spend limit in USD"),
      per_child: z.boolean().optional().describe("Apply quota per child (requires per_child quota templates)"),
    },
    body: (args) => ({
      ...pick(args, ["scope", "subject", "user_path"]),
      budget_key: (() => {
        const bk = pick(args, ["period", "period_seconds"]);
        return Object.keys(bk).length > 0 ? bk : undefined;
      })(),
      amount: args.amount,
      per_child: args.per_child,
    }),
  },
  {
    name: "delete_budget",
    method: "DELETE",
    path: "/budgets",
    description: "Delete one budget by scope + subject + period (DELETE-with-body per the admin API).",
    schema: {
      scope: z.string().optional().describe("Budget scope: user_path, provider, model, or a label name"),
      subject: z.string().optional().describe("Budget subject"),
      user_path: z.string().optional().describe("User path for user-path budgets"),
      budget_key: z.object({
        period: z.string().optional().describe("Period name: hourly, daily, weekly, monthly, or seconds as a string"),
        period_seconds: z.number().optional().describe("Period window in seconds"),
      }).optional().describe("Period window for the budget"),
    },
    body: (args) => ({
      ...pick(args, ["scope", "subject", "user_path"]),
      budget_key: (() => {
        const bk = pick(args, ["period", "period_seconds"]);
        return Object.keys(bk).length > 0 ? bk : undefined;
      })(),
    }),
  },
  {
    name: "update_budget_settings",
    method: "PUT",
    path: "/budgets/settings",
    description: "Update budget reset scheduling settings (hour/minute/day for daily, weekly, monthly resets).",
    schema: {
      daily_reset_hour: z.number().optional().describe("Hour (0-23) to reset daily budget periods"),
      daily_reset_minute: z.number().optional().describe("Minute (0-59) to reset daily budget periods"),
      weekly_reset_weekday: z.number().optional().describe("Weekday (0=Sun … 6=Sat) for weekly reset"),
      weekly_reset_hour: z.number().optional().describe("Hour (0-23) for weekly reset"),
      weekly_reset_minute: z.number().optional().describe("Minute (0-59) for weekly reset"),
      monthly_reset_day: z.number().optional().describe("Day of month (1-31) for monthly reset"),
      monthly_reset_hour: z.number().optional().describe("Hour (0-23) for monthly reset"),
      monthly_reset_minute: z.number().optional().describe("Minute (0-59) for monthly reset"),
    },
    body: (args) => pick(args, [
      "daily_reset_hour", "daily_reset_minute",
      "weekly_reset_weekday", "weekly_reset_hour", "weekly_reset_minute",
      "monthly_reset_day", "monthly_reset_hour", "monthly_reset_minute",
    ]),
  },
  {
    name: "reset_budget",
    method: "POST",
    path: "/budgets/reset-one",
    description: "Reset the current period of one budget. Sends budget key in the request body.",
    schema: {
      scope: z.string().optional().describe("Budget scope: user_path, provider, model, or a label name"),
      subject: z.string().optional().describe("Budget subject"),
      user_path: z.string().optional().describe("User path for user-path budgets"),
      budget_key: z.object({
        period: z.string().optional().describe("Period name: hourly, daily, weekly, monthly, or seconds as a string"),
        period_seconds: z.number().optional().describe("Period window in seconds"),
      }).optional().describe("Period window for the budget"),
    },
    body: (args) => ({
      ...pick(args, ["scope", "subject", "user_path"]),
      budget_key: (() => {
        const bk = pick(args, ["period", "period_seconds"]);
        return Object.keys(bk).length > 0 ? bk : undefined;
      })(),
    }),
  },
  {
    name: "reset_all_budgets",
    method: "POST",
    path: "/budgets/reset",
    description: "Reset all budget periods across every scope. Requires confirmation set to 'reset'.",
    schema: {
      confirmation: z.string().describe("Must be 'reset' to proceed"),
    },
    body: (args) => pick(args, ["confirmation"]),
  },

  // === Rate Limits ===
  {
    name: "reset_all_rate_limits",
    method: "POST",
    path: "/rate-limits/reset",
    description: "Reset live counters of all rate limit rules. Requires confirmation set to 'reset'.",
    schema: {
      confirmation: z.string().describe("Must be 'reset' to proceed"),
    },
    body: (args) => pick(args, ["confirmation"]),
  },

  // === Tagging ===
  {
    name: "update_tagging_settings",
    method: "PUT",
    path: "/tagging/settings",
    description: "Replace operator header tagging rules. Each rule maps an HTTP header to usage labels.",
    schema: {
      headers: z.array(z.object(taggingRuleSchema)).describe("Operator tagging rules (replaces existing operator rules)"),
    },
    body: (args) => pick(args, ["headers"]),
  },

  // === Usage ===
  {
    name: "recalculate_usage_pricing",
    method: "POST",
    path: "/usage/recalculate-pricing",
    description:
      "Recalculate stored usage costs from current model pricing metadata. Requires confirmation set to 'recalculate'.",
    schema: {
      confirmation: z.string().describe("Must be 'recalculate' to proceed"),
      days: z.number().optional().describe("Number of days to recalculate (default 30)"),
      start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      selector: z.string().optional().describe("Model selector to filter (provider/model or alias)"),
      user_path: z.string().optional().describe("User path subtree to filter"),
    },
    body: (args) => pick(args, [
      "confirmation", "days", "start_date", "end_date",
      "selector", "user_path",
    ]),
  },
];
