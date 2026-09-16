# AGENTS.md

MCP server for the GoModel admin REST API. It exposes the dashboard
surface as grouped MCP tools with gradual discovery, fetches GoModel docs
live from GitHub, caches reads to spare the Admin API, and can run over
stdio or as an internet-facing HTTP host in a distroless container.

## Core Principles

### Keep It Simple

Keep files small. Prefer explicit, maintainable code over clever
abstractions. Do not add abstractions until a repeated pattern clearly
justifies them.

### Use Good Defaults

Defaults should fit most users. Choose safe practical defaults. Avoid
requiring configuration for common cases. Document when and why users
override them.

### Follow the Contract

The Admin API contract lives in the GoModel repo
(`internal/admin/routes.go` + `handler_*.go`), not here. When adding or
changing a tool, read the upstream handler first and mirror its exact
request/response fields, path params, and query params. Keep
`spec/admin-swagger.json` in sync when upstream changes.

## Implementation Guidance

When editing code:

- Make the smallest change that solves the problem.
- Match the existing declarative table style in `src/tools.ts`,
  `src/write-tools.ts`, `src/extra-write-tools.ts`, and `src/groups.ts`.
- Keep the gradual-discovery contract: omitting `operation` lists an
  area's operations; unknown operations error with the valid list;
  invalid params return field-level zod errors. Never require clients to
  know operations that the dispatch cannot discover.
- Keep group tool schemas generic (`operation`, `params`). Do not move
  per-operation param docs into tool schemas; that is the passive
  context cost we pay to avoid.
- The HTTP host mode is stateless: one fresh `McpServer` + transport per
  request. Do not share a server across requests.
- Reads go through the TTL cache (`params.cache_bypass` escapes it);
  writes invalidate the cache.
- Never bind a port unless `GOMODEL_HTTP_TOKEN` is set; without it the
  server is stdio-only.
- Do not expose real admin keys, HTTP tokens, or gateway URLs. Placeholders
  only (`sk_gom_REPLACE_ME`, `localhost`).

## Testing

```bash
bun run lint         # oxlint
bun run build        # tsc
bun test             # bun:test against the swagger-derived mock server
```

The mock (`tests/mock-server.mjs`) generates spec-derived routes plus
hand-added endpoints mirroring upstream handlers — param validation,
scope checks, fault injection via `MOCK_FAULT`/`MOCK_HUGE` env vars.
When upstream GoModel admin routes change, regenerate
`spec/admin-swagger.json` and keep the coverage sweep green.

Optional live docs gate: `DOCS_E2E=1 bun test` runs docs tools against
the live GitHub repo (requires `GOMODEL_DOCS_REPO`).

## Documentation

`README.md` is the user-facing doc. Keep it in sync: tool areas, env
vars, the measured token table, and install paths. Comments in code stay
sparse and say *why*, not *what*.

The token table is CI-generated: `bun run measure-tokens` rewrites it on
every release (before the version commit), so numbers always match the
code. **Do not edit that table by hand** — any commit to `main` triggers a
release cycle that regenerates it per release tag. Run the script locally
to preview numbers after changing tool descriptions or groupings, but
never commit manual tweaks to it.

## Commit and PR Format

Conventional Commits for subjects and PR titles:

```text
type(scope): short summary
```

Allowed types: `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`,
`ci`, `chore`, `revert`. Keep the change focused; explain user-visible
impact. Squash merges preserve the PR title as the commit subject. Do not
add AI-assistant mentions to commits.

## Version management (CI-owned — do not touch)

The `version` field in `package.json` is managed automatically by the
release workflow (`.github/workflows/release.yml`):

- On every push to `main` that touches watched paths, CI runs the build
  check, computes the next semantic tag, commits
  `chore(release): vX.Y.Z [skip ci]` **directly to `main`** (setting
  `version` to match), and only then creates the tag, the GitHub Release,
  and the GHCR image. `main` therefore always houses the version of the
  latest release.
- **Never edit `version` yourself.** Do not include version bumps in
  feature PRs — rebases and merges of branches always win for code, and CI
  rewrites the version field at release time.
- The release commit carries `[skip ci]`, so it never re-fires the release
  workflow. Any other commit touching `package.json` (dependencies,
  scripts) triggers a normal release cycle.

## Runtime and toolchain

- Bun is the package manager and runtime (`bun.lock` is the lockfile;
  `package-lock.json` must not return). `bun run build` compiles with
  `tsc`; `bun run start` runs `dist/index.js`.
- No npm publishing: consumers install from GitHub tags
  (`bunx github:weselben/gomodel-admin-mcp@vX.Y.Z`) or the GHCR image.
