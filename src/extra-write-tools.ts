import { z } from "zod";

/**
 * Extra write (mutating) admin tools, split out from write-tools.ts to keep
 * that file from growing unmanageable.
 *
 * Contracts come from internal/admin/handler_*.go in the GoModel repo.
 */

import type { WriteTool } from "./write-tools.js";

/** Copy the defined entries of source into a new object. */
function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** Zod schema for the MCP server tool-timeout selector. */
const toolTimeoutArgs = {
  tool_timeout_seconds: z
    .number()
    .optional()
    .describe("Max seconds to wait for a tool call"),
};

export const EXTRA_WRITE_TOOLS: WriteTool[] = [
  {
    name: "upsert_mcp_server",
    method: "PUT",
    path: "/mcp-servers",
    description:
      "Create or update one admin-managed MCP server. Set slug to derive a lowercase handle (defaults to lowercase name). Headers with value \"***\" preserve the stored header; omit headers entirely to keep existing ones. Only tools not in disallowed_tools are available, and only tools in allowed_tools (if set) are available. User paths listed in user_paths are granted access to this server; paths in disallowed_user_paths are denied access to it.",
    schema: {
      name: z.string().describe("Display name for the server"),
      slug: z
        .string()
        .optional()
        .describe(
          "Lowercase URL-safe handle; defaults to lowercase name when omitted",
        ),
      url: z.string().describe("Base URL of the MCP server"),
      transport: z
        .string()
        .optional()
        .describe('Transport type: "stdio" or "sse" (default inferred from URL)'),
      headers: z
        .record(z.string())
        .optional()
        .describe(
          'Request headers; use value "***" to preserve the stored value for that header',
        ),
      description: z.string().optional().describe("Server description"),
      enabled: z
        .boolean()
        .optional()
        .describe("Default true; preserves existing value when omitted"),
      allowed_tools: z
        .array(z.string())
        .optional()
        .describe("If set, only these tools are exposed"),
      disallowed_tools: z
        .array(z.string())
        .optional()
        .describe("Tools to hide from the server's catalog"),
      disallowed_user_paths: z
        .array(z.string())
        .optional()
        .describe("User paths denied access to this server"),
      user_paths: z
        .array(z.string())
        .optional()
        .describe("Restrict access to these user paths"),
      ...toolTimeoutArgs,
    },
    body: (args) =>
      pick(args, [
        "name",
        "slug",
        "url",
        "transport",
        "headers",
        "description",
        "enabled",
        "allowed_tools",
        "disallowed_tools",
        "disallowed_user_paths",
        "user_paths",
        "tool_timeout_seconds",
      ]),
  },
  {
    name: "delete_mcp_server",
    method: "DELETE",
    path: "/mcp-servers/{name}",
    description: "Delete one admin-managed MCP server by slug name.",
    schema: {
      name: z.string().describe("MCP server slug to remove"),
    },
    body: () => ({}),
  },
  {
    name: "reconnect_mcp_server",
    method: "POST",
    path: "/mcp-servers/{name}/reconnect",
    description:
      "Force-redial one MCP server and return its fresh state. Succeeds even when the upstream stays down.",
    schema: {
      name: z.string().describe("MCP server slug to reconnect"),
    },
    body: () => ({}),
  },
  {
    name: "start_mcp_server_oauth",
    method: "POST",
    path: "/mcp-servers/{name}/oauth/start",
    description:
      "Start an OAuth sign-in to one MCP server. Runs authorization discovery (protected resource metadata, authorization server metadata, PKCE check, dynamic client registration when no client_id is given) and returns the authorization URL to open in the browser. The response sets a short-lived cookie the callback checks.",
    schema: {
      name: z.string().describe("MCP server slug"),
      client_id: z.string().optional().describe("OAuth client id; omit for dynamic client registration"),
      client_secret: z.string().optional().describe("OAuth client secret"),
      redirect_uri: z.string().describe("Redirect URI the OAuth callback targets"),
    },
    body: (args) => pick(args, ["client_id", "client_secret", "redirect_uri"]),
  },
  {
    name: "sign_out_mcp_server",
    method: "DELETE",
    path: "/mcp-servers/{name}/oauth",
    description:
      "Sign out of one MCP server: delete the stored OAuth tokens and reconnect the server without them.",
    schema: {
      name: z.string().describe("MCP server slug to sign out of"),
    },
    body: () => ({}),
  },
  {
    name: "upsert_mcp_virtual_server",
    method: "PUT",
    path: "/mcp-virtual-servers",
    description:
      "Create or update one admin-managed virtual MCP server. Members must be existing MCP servers. A new virtual server may not use an MCP server's slug, and config-declared virtual servers are read-only.",
    schema: {
      name: z.string().describe("Virtual MCP server name"),
      servers: z.array(z.string()).describe("Member MCP server slugs"),
      description: z.string().optional().describe("Virtual server description"),
      tool_discovery: z
        .string()
        .optional()
        .describe('Configured tool discovery mode: "off", "search", or "" to inherit the gateway default'),
    },
    body: (args) => pick(args, ["name", "servers", "description", "tool_discovery"]),
  },
  {
    name: "delete_mcp_virtual_server",
    method: "DELETE",
    path: "/mcp-virtual-servers/{name}",
    description: "Delete one admin-managed virtual MCP server by name.",
    schema: {
      name: z.string().describe("Virtual MCP server name to remove"),
    },
    body: () => ({}),
  },
  {
    name: "create_auth_key",
    method: "POST",
    path: "/auth-keys",
    description:
      "Create one API auth key scoped to a user path with optional model allowlist, dashboard access, and labels.",
    schema: {
      name: z.string().describe("Key name (human label)"),
      description: z.string().optional().describe("Key description"),
      user_path: z
        .string()
        .optional()
        .describe("User path this key authenticates for"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Labels attached to the key"),
      allowed_models: z
        .array(z.string())
        .optional()
        .describe(
          "If set, restricts requests with this key to these model selectors (e.g. 'openai/gpt-4o')",
        ),
      dashboard_access: z
        .boolean()
        .optional()
        .describe("Grant access to the admin dashboard (default false)"),
      expires_at: z
        .string()
        .optional()
        .describe("ISO-8601 expiry timestamp; omit for no expiry"),
    },
    body: (args) =>
      pick(args, [
        "name",
        "description",
        "user_path",
        "labels",
        "allowed_models",
        "dashboard_access",
        "expires_at",
      ]),
  },
  {
    name: "update_auth_key_allowed_models",
    method: "PUT",
    path: "/auth-keys/{id}/allowed-models",
    description:
      "Replace the model allowlist of one API key. An empty list lifts the key-level restriction (user-path policies still apply). Required argument.",
    schema: {
      id: z.string().describe("Auth key id"),
      allowed_models: z
        .array(z.string())
        .describe("New model allowlist (replaces existing)"),
    },
    body: (args) => pick(args, ["allowed_models"]),
  },
  {
    name: "update_auth_key_dashboard_access",
    method: "PUT",
    path: "/auth-keys/{id}/dashboard-access",
    description:
      "Grant or revoke dashboard access for one API key. Required argument.",
    schema: {
      id: z.string().describe("Auth key id"),
      dashboard_access: z
        .boolean()
        .describe("Whether to grant or revoke dashboard access"),
    },
    body: (args) => pick(args, ["dashboard_access"]),
  },
  {
    name: "deactivate_auth_key",
    method: "POST",
    path: "/auth-keys/{id}/deactivate",
    description:
      "Deactivate one API key so it can no longer authenticate requests.",
    schema: {
      id: z.string().describe("Auth key id to deactivate"),
    },
    body: () => ({}),
  },
  {
    name: "upsert_user",
    method: "PUT",
    path: "/users",
    description:
      "Create or update a user-path policy: set the allowed models list and description for a user path node in the access tree.",
    schema: {
      user_path: z.string().describe("User path (e.g. '/org/team')"),
      allowed_models: z
        .array(z.string())
        .optional()
        .describe(
          "Model selectors this user path may use; empty means no restriction",
        ),
      description: z.string().optional().describe("Policy description"),
    },
    body: (args) =>
      pick(args, ["user_path", "allowed_models", "description"]),
  },
  {
    name: "delete_user",
    method: "DELETE",
    path: "/users?user_path={user_path}",
    description: "Delete one user-path policy by user path.",
    schema: {
      user_path: z.string().describe("User path to remove"),
    },
    body: () => ({}),
  },
  {
    name: "upsert_guardrail",
    method: "PUT",
    path: "/guardrails",
    description:
      "Create or update one guardrail definition. Config must be a valid JSON object for the guardrail type. Guardrails can be scoped to a user path.",
    schema: {
      name: z.string().describe("Guardrail name (unique within scope)"),
      type: z.string().describe("Guardrail type (e.g. 'pii', 'prompt_injection')"),
      description: z
        .string()
        .optional()
        .describe("Guardrail description"),
      user_path: z
        .string()
        .optional()
        .describe("Scope to this user path; empty means global"),
      config: z
        .record(z.unknown())
        .optional()
        .describe("Type-specific configuration as a JSON object"),
      fail_mode: z
        .string()
        .optional()
        .describe(
          'Failure behavior: "allow" (default) or "block"',
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe("Execution timeout in milliseconds"),
    },
    body: (args) => {
      const picked = pick(args, [
        "name",
        "type",
        "description",
        "user_path",
        "config",
        "fail_mode",
        "timeout_ms",
      ]);
      if (typeof picked.config === "object" && picked.config !== null) {
        // Serialize config object to JSON string — the Go handler expects json.RawMessage.
        picked.config = JSON.stringify(picked.config);
      }
      return picked;
    },
  },
  {
    name: "delete_guardrail",
    method: "DELETE",
    path: "/guardrails",
    description:
      "Delete one guardrail by name. Fails if the guardrail is referenced by active workflows.",
    schema: {
      name: z.string().describe("Guardrail name to remove"),
    },
    body: (args) => pick(args, ["name"]),
  },
  {
    name: "create_workflow",
    method: "POST",
    path: "/workflows",
    description:
      "Create and activate a new workflow. Scope narrows the workflow to a provider, model, or user path. The workflow payload defines steps, guardrails, and other features.",
    schema: {
      scope_provider_name: z
        .string()
        .optional()
        .describe("Provider name to scope this workflow to (preferred over scope_provider)"),
      scope_provider: z
        .string()
        .optional()
        .describe(
          "Legacy provider name scope — used when scope_provider_name is empty",
        ),
      scope_model: z
        .string()
        .optional()
        .describe("Model name (requires scope_provider_name)"),
      scope_user_path: z
        .string()
        .optional()
        .describe("User path scope for this workflow"),
      name: z.string().describe("Workflow name (unique within scope)"),
      description: z
        .string()
        .optional()
        .describe("Workflow description"),
      workflow_payload: z
        .object({})
        .passthrough()
        .describe(
          "Workflow definition: steps, features (guardrails, etc.), and other config",
        ),
    },
    body: (args) =>
      pick(args, [
        "scope_provider_name",
        "scope_provider",
        "scope_model",
        "scope_user_path",
        "name",
        "description",
        "workflow_payload",
      ]),
  },
  {
    name: "deactivate_workflow",
    method: "POST",
    path: "/workflows/{id}/deactivate",
    description: "Deactivate a workflow by id (stops it from executing).",
    schema: {
      id: z.string().describe("Workflow id to deactivate"),
    },
    body: () => ({}),
  },
];
