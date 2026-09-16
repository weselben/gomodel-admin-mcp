# gomodel-admin-mcp

[MCP](https://modelcontextprotocol.io) server for the
[GoModel](https://github.com/ENTERPILOT/GoModel) admin REST API.

Gradual-discovery group tools for the whole admin surface (the same
operations the dashboard UI uses), live documentation tools that search the
GoModel docs straight from GitHub, a TTL read cache that spares the Admin
API, and an opt-in HTTP host mode so the server can run as a container
anywhere. Runs on [Bun](https://bun.sh) or Node ≥ 18.

## Architecture: grouped tools, gradual discovery

Instead of exposing 79 individual tools (~12k tokens of passive context),
the server registers **one tool per area** — the same grouping as the list
below (~5k tokens total). Each area tool takes:

```
{ "operation": "<name>", "params": { ...operation arguments } }
```

Discovery ladder, harness-agnostic (plain tools/calls, no protocol exotics):

1. The server `instructions` teach the generic call pattern once.
2. Omit `operation` → the area returns its operation list.
3. An unknown `operation` errors with the valid list.
4. Invalid `params` error with field-level messages (`Unrecognized key(s)`,
   type mismatches) — correct the call and retry; a wrong guess costs one
   failed call, not a re-read of the docs.

Areas: `admin_runtime`, `admin_runtime_control`, `admin_usage`,
`admin_usage_control`, `admin_audit`, `admin_cache`, `admin_models`,
`admin_providers`, `admin_provider_control`, `admin_governance`,
`admin_governance_control`, `admin_auth_keys`, `admin_virtual_models`,
`admin_pricing_overrides`, `admin_rate_limits`, `admin_workflows`,
`admin_workflows_control`, `admin_mcp_servers`, `admin_mcp_servers_control`
— plus `docs_index`, `docs_search`, `docs_get`, `get_server_info`.

### What the areas cover

- **runtime** — feature flags, dashboard settings, provider health
- **runtime_control** — update settings, trigger runtime refresh
- **usage** — summary, daily, by model / user path / label / session, log,
  token throughput
- **usage_control** — recalculate recorded usage pricing
- **audit** — log, sessions, stats, detail, conversation, live SSE stream
- **cache** — semantic/exact cache overview
- **models** — registry, categories, virtual models, pricing overrides
- **providers** / **provider_control** — credentials (redacted) and their
  types; upsert / delete credentials
- **governance** — budgets, rate limits, tagging, guardrails, failover,
  auth keys, users, plugins
- **governance_control** — budget/rate-limit/tagging/guardrail/user/failover
  mutations
- **auth_keys** — create keys, labels, allowed models, dashboard access,
  deactivate
- **virtual_models** — upsert (alias / load-balanced / access policy) and
  delete
- **pricing_overrides** — USD pricing by selector scope (`/`, `provider/`,
  `model`, `provider/model`)
- **rate_limits** — upsert, delete, reset counters
- **workflows** / **workflows_control** — list/get, create, deactivate
- **mcp_servers** / **mcp_servers_control** — list, catalogs; upsert,
  delete, reconnect
- **docs_*** — live GoModel docs from GitHub (Mintlify navigation index,
  ripgrep-style search, page fetch; anonymous reads, 15-minute cache)

The full API contract is in [`spec/admin-swagger.json`](spec/admin-swagger.json).

## Read cache

Read results are cached in memory for `GOMODEL_CACHE_TTL_SECONDS` (default
30s) so repeated audits/usage queries don't hammer the Admin API. Pass
`"params": { "cache_bypass": true }` to skip the cache for one call. Any
write invalidates the whole cache.

## Modes and passive token cost

<!-- CI-generated: bun run measure-tokens rewrites the rows below on release. Do not edit them by hand. -->

Measured from `tools/list` (JSON payload, tokens ≈ bytes / 4):

| Mode | Tools | Schema bytes | ~tokens |
| ------------------------- | ----: | -----------: | ------: |
| Full (default, key set) | 23 | 20,296 | ~5.1k |
| `GOMODEL_READ_ONLY=1` | 13 | 11,053 | ~2.8k |
| Docs-only (no admin key) | 4 | 2,290 | ~573 |

| Mode | Condition | What registers |
| ---- | --------- | -------------- |
| Full | key set | all areas incl. writes |
| Read-only | key set + `GOMODEL_READ_ONLY=1` | read areas + docs + info |
| Docs-only | no `GOMODEL_ADMIN_API_KEY` | `docs_*` + `get_server_info` only |

## Configuration

| Variable                | Required | Default                 | Description                                     |
| ----------------------- | -------- | ----------------------- | ----------------------------------------------- |
| `GOMODEL_ADMIN_API_KEY` | no       | —                       | Admin API key; without it the server is docs-only |
| `GOMODEL_BASE_URL`      | no       | `http://localhost:8080` | Base URL of the GoModel gateway                 |
| `GOMODEL_READ_ONLY`     | no       | unset (writes enabled)  | `1`/`true` registers read areas only            |
| `GOMODEL_HTTP_TOKEN`    | no       | —                       | Set to serve streamable-HTTP MCP on `/mcp`; clients must send it as bearer |
| `HOST`                  | no       | `0.0.0.0`               | HTTP bind address (HTTP mode)                   |
| `PORT`                  | no       | `3000`                  | HTTP port (HTTP mode)                           |
| `GOMODEL_CACHE_TTL_SECONDS` | no   | `30`                    | Read-cache TTL                                  |
| `GOMODEL_DOCS_REPO`     | no       | `ENTERPILOT/GoModel`    | GitHub repo the docs tools read from            |
| `GOMODEL_DOCS_REF`      | no       | `main`                  | Branch/ref the docs tools read from             |

## Run it

Local (Bun):

```bash
bun install
bun run build
GOMODEL_ADMIN_API_KEY=sk_gom_... bun run start     # stdio
GOMODEL_HTTP_TOKEN=change-me bun run start         # HTTP host mode on :3000
```

Via bunx straight from a GitHub tag (no clone, no npm account):

```bash
GOMODEL_ADMIN_API_KEY=sk_gom_... bunx github:weselben/gomodel-admin-mcp@v0.3.0
```

Docker (image published to GHCR on every release):

```bash
docker run -d --name gomodel-admin-mcp \
  -e GOMODEL_HTTP_TOKEN=change-me \
  -e GOMODEL_ADMIN_API_KEY=sk_gom_... \
  -e GOMODEL_BASE_URL=https://your-gateway.example \
  -p 3000:3000 \
  ghcr.io/weselben/gomodel-admin-mcp:latest
```

The image is distroless (no shell, non-root); HTTP mode only starts when
`GOMODEL_HTTP_TOKEN` is set — without it the process never binds a port.

## Wiring it up

stdio clients (`mcp.json`), see [`mcp.json.example`](mcp.json.example) for
all variants — local build, `bunx`, docs-only, HTTP URL:

```json
{
  "mcpServers": {
    "gomodel-admin": {
      "command": "bunx",
      "args": ["github:weselben/gomodel-admin-mcp@v0.3.0"],
      "env": {
        "GOMODEL_BASE_URL": "http://localhost:8080",
        "GOMODEL_ADMIN_API_KEY": "sk_gom_..."
      }
    }
  }
}
```

GoModel's own MCP feature (Admin UI → MCP servers) can consume this server
both ways:

- command transport: command `bunx`, args
  `["github:weselben/gomodel-admin-mcp@v0.3.0"]`, env as above
- URL transport: url `http://your-host:3000/mcp`, transport `streamable`,
  headers `Authorization: Bearer <GOMODEL_HTTP_TOKEN>`

Keep every key/token out of version control — `mcp.json` lives in local
client config.

## Development

```bash
bun install
bun run dev     # watch mode from source
bun run build   # tsc → dist/
bun scripts/smoke.mjs                 # read-only checks against a live gateway
SMOKE_WRITE=1 bun scripts/smoke.mjs   # + safe virtual-model round-trip
```

`scripts/smoke.mjs` needs `GOMODEL_ADMIN_API_KEY` (and optionally
`GOMODEL_BASE_URL`) from the environment.

## CI / Releases

`.github/workflows/release.yml` (mirrors the RooForge flow): pushes to
`main` touching code run the bun build check, compute the next patch tag,
and — when the tag is new — commit `chore(release): vX.Y.Z [skip ci]`
straight to `main` **before** tagging, so `main` always houses the version
of the latest release (see `AGENTS.md`). Then the workflow creates the
tag, the GitHub Release, and the `ghcr.io/weselben/gomodel-admin-mcp`
image (tags `vX.Y.Z`, `latest`, `sha`). No npm publishing — install from
GitHub tags or GHCR.
