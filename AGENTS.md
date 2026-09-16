# AGENTS.md

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

## Secrets and safety

- Never commit real admin keys, HTTP tokens, or gateway URLs. Placeholders
  only (`sk_gom_REPLACE_ME`, `localhost`).
