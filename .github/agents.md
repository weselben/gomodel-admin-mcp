# CI: how this repo builds, tests, and releases

Read this before touching `.github/workflows/release.yml` or the rulesets.
Every constraint below was learned the hard way — the "obvious" alternative
has already failed in production.

## What runs, when

One workflow: `.github/workflows/release.yml`, fired by pushes to `main`
that touch a watched path:

`src/**`, `package.json`, `bun.lock`, `Dockerfile`, `tsconfig.json`,
`README.md`, `CLAUDE.md`, `tests/**`, `.github/**`

Steps: build → lint (`oxlint`) → `bun test` → refresh the README token
table (`bun run measure-tokens`) → compute the next patch tag → then one
of two modes, chosen by the head commit subject:

- **subject starts with `chore(release):`** → **finalize**: force-tag the
  head commit, create the GitHub Release, build and push the GHCR image
  (`vX.Y.Z` / `latest` / merge SHA).
- **anything else** → **open release PR**: bump `package.json`, push a
  `release/vX.Y.Z` branch, open (or update) a `chore(release): vX.Y.Z`
  PR, and stop. Merging that PR is the release trigger: the merge is a
  real push event by a human, which fires the workflow again in finalize
  mode. If the version is already on `main` (no diff), the run skips the
  PR and finalizes directly.

A `release` concurrency group serializes overlapping runs.

## Releases are human-gated — nothing auto-merges

The workflow never merges anything. The `chore(release)` PR sits open
until a human merges it, and that human merge is what fires the finalize
run. This is deliberate:

- auto-merge chained unreviewed releases (three versions shipped in one
  day from docs tweaks) — that is why it was removed;
- `GITHUB_TOKEN` merges fire no push event (GitHub recursion guard), so
  bot merges would stall the flow anyway;
- a human merge by the owner works because the owner's Admin role is on
  the ruleset bypass list — the event fires, the finalize run completes.

If a `chore(release)` PR is open, it is waiting for you. Merge it to
release; close it to skip the release (the next watched merge re-opens it
with the recomputed tag).

## Hard constraints (why alternatives failed)

- The `main` ruleset (`Block Direct Push to main`, ruleset 23570187)
  requires pull requests, blocks `deletion` and `non_fast_forward`, and
  requires a Copilot review.
- **`GITHUB_TOKEN` cannot push to `main`** — the ruleset rejects it, and
  personal repos cannot add GitHub Actions as a ruleset bypass actor
  (Integration bypass actors need an organization; the API returns 422).
- **Events triggered by `GITHUB_TOKEN` fire no further workflow runs**
  (GitHub recursion guard) — an auto-merged PR produces no push event, so
  event-driven finalize after a bot merge is impossible by design.
- **`actions/checkout` injects an Authorization extraheader** (persist-
  credentials default) that outranks URL-embedded credentials; a runner
  push to `main` would authenticate as the Actions app regardless of the
  URL. Do not push to `main` from workflows — open a PR instead.
- **`x-access-token:<PAT>` as git username attributes the push to the
  Actions app**, not the token's owner. (Historical: no PAT is used.)
- `gh pr merge --auto` **errors on already-mergeable PRs** ("Pull request
  is in clean status") and enables unreviewed chained releases when it
  works. Moot now — the workflow does not merge.

## Credentials

No PAT. `GITHUB_TOKEN` (contents / packages / pull-requests write) pushes
the `release/*` branch, opens the release PR, pushes tags (`refs/tags/*`
and `release/*` are not ruleset-guarded — only `refs/heads/main` is), and
pushes the GHCR image. The former `RELEASE_PAT` secret is deleted; do not
reintroduce one.

## Watched paths

The `paths:` filter decides what fires releases. **New top-level files or
directories that should ship in a release must be added there** —
`CLAUDE.md` was missed once and its merge silently released nothing.
When adding watched paths, also check `files` in `package.json` and the
Docker build context.

## Operations

- Release now / redo a partial release: `gh workflow run release.yml`
  (workflow_dispatch) — it finalizes whatever the current state implies.
- Failure mid-release is safe: version bump, commit, tag, and release
  steps all tolerate no-ops and force-replace on re-run.
- The version field is CI-owned. Never bump it in feature PRs.
- Skip a release: close the open `chore(release)` PR; the next watched
  merge re-opens it with the recomputed tag.
