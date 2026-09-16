# gomodel-admin-mcp

[MCP](https://modelcontextprotocol.io) server for the
[GoModel](https://github.com/ENTERPILOT/GoModel) admin REST API.

Exposes **every** route of the GoModel admin API — the same surface the
dashboard UI uses — as MCP tools: all reads, all mutations (virtual models,
failover, pricing, budgets, rate limits, auth keys, users, guardrails,
workflows, provider credentials, tagging, MCP servers, runtime settings),
plus live documentation tools that search the GoModel docs straight from
GitHub.

## Tools

79 tools, grouped by area:

- **Runtime**: `get_runtime_config`, `get_runtime_settings`,
  `get_provider_status`, `get_server_info` (base URL, admin endpoint,
  redacted key preview, tool counts, read-only flag)
- **Runtime control (write)**: `update_runtime_setting`, `refresh_runtime`
- **Usage**: `get_usage_summary`, `get_usage_daily`, `get_usage_by_model`,
  `get_usage_by_user_path`, `get_usage_by_label`, `get_usage_by_session`,
  `get_usage_log`, `get_token_throughput`
- **Usage control (write)**: `recalculate_usage_pricing`
- **Audit**: `get_audit_log`, `get_audit_sessions`, `get_audit_stats`,
  `get_audit_detail`, `get_audit_conversation`, `get_live_logs` (SSE, bounded)
- **Cache**: `get_cache_overview`
- **Models**: `list_models`, `list_model_categories`, `list_virtual_models`,
  `list_model_pricing_overrides`
- **Providers**: `list_provider_credentials`, `list_provider_credential_types`
- **Provider control (write)**: `upsert_provider_credential`,
  `delete_provider_credential`
- **Governance**: `list_budgets`, `get_budget_settings`, `list_rate_limits`,
  `get_tagging_settings`, `list_guardrails`, `list_guardrail_types`,
  `list_failover_rules`, `list_auth_keys`, `get_access_overview`, `list_users`,
  `list_plugins`
- **Governance control (write)**: `upsert_budget`, `delete_budget`,
  `update_budget_settings`, `reset_budget`, `reset_all_budgets`,
  `reset_all_rate_limits`, `update_tagging_settings`, `upsert_guardrail`,
  `delete_guardrail`, `upsert_user`, `delete_user`, `upsert_failover_rule`,
  `delete_failover_rule`
- **Auth keys (write)**: `create_auth_key`, `update_auth_key_labels`,
  `update_auth_key_allowed_models`, `update_auth_key_dashboard_access`,
  `deactivate_auth_key`
- **Virtual models (write)**: `upsert_virtual_model` (create / update /
  rename, alias or load-balanced redirect, or access policy),
  `delete_virtual_model`
- **Pricing overrides (write)**: `upsert_model_pricing_override`,
  `delete_model_pricing_override` — selector scopes: global `/`,
  provider-wide `provider/`, model-wide `model`, exact `provider/model`
- **Rate limits (write)**: `upsert_rate_limit`, `delete_rate_limit`,
  `reset_rate_limit`
- **Workflows**: `list_workflows`, `list_workflow_guardrails`, `get_workflow`
- **Workflows (write)**: `create_workflow`, `deactivate_workflow`
- **MCP servers**: `list_mcp_servers`, `get_mcp_server_catalog`
- **MCP servers (write)**: `upsert_mcp_server`, `delete_mcp_server`,
  `reconnect_mcp_server`
- **Docs (live from GitHub)**: `docs_index` (list doc pages from the repo's
  Mintlify navigation), `docs_search` (ripgrep-style search over page
  contents), `docs_get` (fetch one page) — anonymous raw.githubusercontent /
  api.github.com reads, 15-minute in-memory cache

The full API contract is in [`spec/admin-swagger.json`](spec/admin-swagger.json)
(admin paths of GoModel's embedded Swagger 2 spec).

## Passive token cost

The tool schemas sit in the model's context for the whole session once the
MCP server is connected. Measured from `tools/list` (JSON payload, estimated
tokens ≈ bytes / 4):

| Mode                        | Tools | Schema bytes | ~tokens |
| --------------------------- | ----: | -----------: | ------: |
| Full (default)              |    79 |       47,776 |  ~11.9k |
| `GOMODEL_READ_ONLY=1`       |    44 |       21,095 |   ~5.3k |
| Docs-only (no API key)      |     4 |        2,321 |   ~0.6k |

## Modes

| Mode | Condition | Registered tools |
| ---- | --------- | ---------------- |
| Full (default) | API key set | all 79: 40 read, 36 write, 3 docs, `get_server_info` |
| Read-only | API key set + `GOMODEL_READ_ONLY=1` | 44: 40 read, 3 docs, `get_server_info` |
| Docs-only | no `GOMODEL_ADMIN_API_KEY` | 4: `docs_index`, `docs_search`, `docs_get`, `get_server_info` — every admin tool is hidden from the model's context, so the server acts as a pure docs MCP |

`get_server_info` reports the active mode (`docs_only`, `read_only`, tool
counts). In docs-only mode it never exposes the base URL or key preview.

## Configuration

| Variable              | Required | Default                    | Description                                    |
| --------------------- | -------- | -------------------------- | ---------------------------------------------- |
| `GOMODEL_ADMIN_API_KEY` | no     | —                          | Admin API key (`dashboard_access`); without it the server runs docs-only |
| `GOMODEL_BASE_URL`    | no       | `http://localhost:8080`    | Base URL of the GoModel gateway                |
| `GOMODEL_READ_ONLY`   | no       | unset (writes enabled)     | `1`/`true` to register read tools only         |
| `GOMODEL_DOCS_REPO`   | no       | `ENTERPILOT/GoModel`       | GitHub repo the docs tools read from           |
| `GOMODEL_DOCS_REF`    | no       | `main`                     | Branch/ref the docs tools read from            |

## Setup

```bash
git clone https://github.com/weselben/gomodel-admin-mcp.git
cd gomodel-admin-mcp
npm install
npm run build
```

## mcp.json

Add to your MCP client's `mcp.json`, pointing at the built server:

```json
{
  "mcpServers": {
    "gomodel-admin": {
      "command": "node",
      "args": ["/absolute/path/to/gomodel-admin-mcp/dist/index.js"],
      "env": {
        "GOMODEL_BASE_URL": "http://localhost:8080",
        "GOMODEL_ADMIN_API_KEY": "sk_gom_..."
      }
    }
  }
}
```

Or without building, via `npx` + `tsx`:

```json
{
  "mcpServers": {
    "gomodel-admin": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/gomodel-admin-mcp/src/index.ts"],
      "env": {
        "GOMODEL_BASE_URL": "http://localhost:8080",
        "GOMODEL_ADMIN_API_KEY": "sk_gom_..."
      }
    }
  }
}
```

Keep the API key out of version control — `mcp.json` lives in your local
client config, not in this repository.

## Development

```bash
npm run dev    # run from source with tsx
npm run build  # compile to dist/
```

## Smoke test

```bash
export GOMODEL_ADMIN_API_KEY=sk_gom_...
export GOMODEL_BASE_URL=http://localhost:8080
node scripts/smoke.mjs          # read-only checks
SMOKE_WRITE=1 node scripts/smoke.mjs   # + safe virtual-model round-trip
```

## Notes

- Responses larger than 256 KiB are truncated with a marker.
- `get_live_logs` collects server-sent events for a bounded window
  (`seconds` argument, default 5, max 30).
- Several DELETE endpoints (`delete_virtual_model`, `delete_failover_rule`,
  `delete_model_pricing_override`, `delete_rate_limit`, `delete_budget`,
  `delete_user`, `delete_guardrail`, budget/rate-limit resets) pass their
  identifier in the JSON request body, mirroring the GoModel admin API.
- `delete_mcp_server` / `delete_provider_credential` take the name as a
  path parameter instead.
