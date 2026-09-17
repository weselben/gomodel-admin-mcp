# CI: release flow (read this before touching .github/workflows/release.yml)

This file explains how releases work and why they are built the way they
are. Every "obvious simplification" here has already failed in production —
read the constraints first.

## The flow (v0.0.4+)

1. Any push to `main` touching a watched path fires `release.yml`.
2. Build → lint → test → refresh README token table → compute next tag.
3. Mode detection via the head commit subject:
   - subject starts with `chore(release):` → **finalize**: force-tag the
     head commit, create the GitHub Release, build and push the GHCR
     image (`vX.Y.Z` / `latest` / sha).
   - anything else → **open release PR**: bump `package.json`, push a
     `release/vX.Y.Z` branch, open (or update) a `chore(release): vX.Y.Z`
     PR, merge it, then poll until merged and switch into finalize mode
     **within the same run**. The merge tries `--auto` first and falls
     back to a direct merge: `enablePullRequestAutoMerge` **errors when
     the PR is already mergeable** ("Pull request is in clean status"),
     which is a race — Copilot review sometimes satisfies the ruleset
     between `gh pr create` and `gh pr merge`. A clean PR means every
     requirement is already met, so the direct merge is the correct
     fallback.
4. A `release` concurrency group serializes overlapping runs.

Releases are therefore triggered by merging *anything* watched — the
release PR merge is just the most common instance.

## Hard constraints (why alternatives failed)

- The `main` ruleset (`Block Direct Push to main`, ruleset 23570187)
  requires pull requests, blocks `deletion` and `non_fast_forward`, and
  requires a Copilot review.
- **`GITHUB_TOKEN` cannot push to `main`** — the ruleset rejects it, and
  personal repos cannot add GitHub Actions as a ruleset bypass actor
  (Integration bypass actors need an organization; the API returns 422).
- **Events triggered by `GITHUB_TOKEN` fire no further workflow runs**
  (GitHub recursion guard). A release PR auto-merged by the bot produces
  no push event — that is why the PR-opening run polls for the merge and
  finalizes itself instead of waiting for another run.
- **`actions/checkout` injects an Authorization extraheader** (persist-
  credentials default) that outranks URL-embedded credentials. Direct
  pushes to main from a runner would authenticate as the Actions app
  regardless of the URL — do not try to push to `main` from workflows.
- **`x-access-token:<PAT>` as git username attributes the push to the
  Actions app**, not to the token's owner. Owner PAT pushes must use the
  owner as username. (Moot now — see below.)
- The release PR merges by **auto-merge gated on the Copilot review**.
  If Copilot stalls, merge the release PR manually: a human merge fires
  a normal finalize run. Both paths are idempotent (force-tag, release
  upsert), so double-finalize is harmless.

## Credentials

No PAT is needed. `GITHUB_TOKEN` (contents/packages/pull-requests write)
creates the release branch and PR, merges it (auto-merge), pushes tags
(`refs/tags/*` and `release/*` are not ruleset-guarded — only
`refs/heads/main` is), and pushes the GHCR image. The former
`RELEASE_PAT` secret is deleted; do not reintroduce one.

## Watched paths

The `paths:` filter decides what fires releases. **New top-level files or
directories that should trigger a release must be added there** (e.g.
`CLAUDE.md` was missed once and its merge silently released nothing).
When adding watched paths, also check `files` in `package.json` and the
Docker build context.

## Operations

- Release now / redo a partial release: `gh workflow run release.yml`
  (workflow_dispatch) — it finalizes whatever the current state implies.
- Failure mid-release is safe: version bump, commit, tag, and release
  steps all tolerate no-ops and force-replace on re-run.
- The version field is CI-owned. Never bump it in feature PRs.
