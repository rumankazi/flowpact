# Contributing

## Setup

Node.js 22 or later and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build        # bundles the CLI and the GitHub Action
pnpm test         # unit, property and end-to-end tests
pnpm lint         # Biome
pnpm typecheck
pnpm docs:gen     # regenerate rule pages and JSON schemas after changing a rule or schema
```

`packages/action/dist` is committed (GitHub runs the action from it). Rebuild it with `pnpm build` and commit the
result whenever `packages/core`, `packages/reporters` or `packages/action` change; CI fails otherwise.

## Pull requests

`main` is protected: changes land through pull requests that pass the **CI passed** and **Conventional PR title**
checks, are approved by a code owner (`.github/CODEOWNERS`), and are squash-merged. GitHub does not let authors
approve their own pull requests, so repository admins may merge their own without the approval (the `main reviews`
ruleset); the checks still apply to everyone (the `main` ruleset). **CI passed** sums up every CI job — tests on Node 22 and 24, the docs build, smoke
tests of the packed CLI on Linux, macOS and Windows, and the GitHub Action on this repository and on fixtures. New
checks are added as jobs to `.github/workflows/ci.yml` and listed under the `ci-passed` job's `needs`.

The branch and tag rules live in the repository, not only in the settings UI: `.github/rulesets/*.json` (GitHub's
ruleset export format) and `.github/repository.json` (merge settings). A pull request that changes them shows the
difference from the live settings (**Settings diff**); merging applies them, and a weekly run reverts changes made in
the UI. Release tags (`v*`) can only be created or moved by the release bot and repository admins.

Dependencies are updated by Renovate (`renovate.json`) with Conventional Commit titles. When a runtime dependency
changes, the release bot rebuilds the committed action bundle on the Renovate branch. Non-major updates (except 0.x
minors) merge themselves once every required check passes: Renovate may skip the code owner review, not the checks.
Nothing reaches users that way — a dependency fix only updates the release pull request, which needs approval. Actions
are pinned to commit SHAs, with the version in a comment.

## Commit messages

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`. The
title is the whole squashed commit on `main` (the description is not copied), and release-please reads only those.
Retitle GitHub's `Revert "…"` pull requests as `revert: …`.

| Type | Use for | Release |
| --- | --- | --- |
| `feat` | a new rule, option or command | minor |
| `fix` | a bug fix, including false positives and negatives | patch |
| `perf` | a faster analysis | patch |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `style` | everything else | none |

Mark a breaking change with `!` (`feat(config)!: …`) or a `BREAKING CHANGE:` footer. Before 1.0 a breaking change
bumps the minor version. Useful scopes: `core`, `rules`, `contracts`, `config`, `cli`, `action`, `reporters`, `docs`.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please), acting as the
`rk-release-bot` GitHub App (so its pull requests and tags run the usual workflows):

1. Every push to `main` updates a **release pull request** that bumps the version in every package, rebuilds the
   action bundle and adds the changelog entry from the commits since the last release.
2. Merging it tags the release (`vX.Y.Z`) and creates the GitHub release.
3. The release workflow then publishes `flowpact` to npm with provenance through npm trusted publishing (no
   token; only the very first publish of a new package name needs a short-lived `NPM_TOKEN` secret, because a trusted
   publisher can be configured only once the package exists), moves the floating tag used by
   `uses: rumankazi/flowpact@v0.2` (before 1.0 one tag per minor line — `v0.2`, `v0.3` — because a 0.x minor may be
   breaking; from 1.0 the major, `v1`), and smoke-tests the published package on Linux, macOS and Windows.

If publishing fails after the tag exists, run the **Release** workflow manually with that tag; versions already on
npm are skipped.

Rule codes are stable: a code never changes meaning, and removed codes are not reused.
