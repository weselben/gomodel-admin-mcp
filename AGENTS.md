
MCP server for the GoModel admin REST API. It exposes the dashboard
surface as grouped MCP tools with gradual discovery, fetches GoModel docs
live from GitHub, caches reads to spare the Admin API, and can run over
stdio or as an internet-facing HTTP host in a distroless container.

Release CI: see `.github/agents.md`.

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
- JSON responses are homogenized (`src/homogenize.ts`): arrays of objects
  get a uniform sorted key set, missing keys padded with `null`. This keeps
  output valid JSON while making list responses eligible for GoModel Pro's
  JSON-table prompt compression. Preserve the invariant: emitted bytes stay
  plain JSON, never a `$gomodel:`-encoded form.
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
every release (the bump travels in the release PR), so numbers always
match the code. **Do not edit that table by hand** — a merge to `main` that
touches a watched code path (see `.github/agents.md`) triggers a release
cycle that regenerates it per release tag. Run the
script locally to preview numbers after changing tool descriptions or
groupings, but never commit manual tweaks to it.

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
release workflow (`.github/workflows/release.yml`) via **release PRs**:

- On every push to `main` that touches watched paths, CI runs the build
  check, computes the next semantic tag, and opens (or updates) an
  auto-merged `chore(release): vX.Y.Z` PR carrying the version bump and
  the refreshed README token table.
- When that PR merges, the workflow run on the merge commit finalizes:
  it tags the merge commit (force-replacing an existing tag), creates
  the GitHub Release, and pushes the GHCR image. `main` therefore always
  houses the version of the latest release.
- Why a PR: the `main` ruleset requires pull requests, `GITHUB_TOKEN`
  pushes are rejected, and personal repos cannot add GitHub Actions as a
  ruleset bypass actor. The PR path needs no bypass and no PAT.
- **Never edit `version` yourself.** Do not include version bumps in
  feature PRs — rebases and merges of branches always win for code, and
  CI rewrites the version field at release time.
- Merging the release PR is what releases. If Copilot review stalls the
  auto-merge, merging the release PR manually completes the release.

## Runtime and toolchain

- Bun is the package manager and runtime (`bun.lock` is the lockfile;
  `package-lock.json` must not return). `bun run build` compiles with
  `tsc`; `bun run start` runs `dist/index.js`.
- No npm publishing: consumers install from GitHub tags
  (`bunx github:weselben/gomodel-admin-mcp#vX.Y.Z`) or the GHCR image.

