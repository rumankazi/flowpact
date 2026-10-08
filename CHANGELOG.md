# Changelog

All notable changes to flowpact (called wfc before 0.2.0) are documented here. The project uses
[Semantic Versioning](https://semver.org/). Rule codes (`FPnnn`) are stable: a code never changes meaning, and removed
codes are not reused. They were renamed once, from `WFCnnn` to `FPnnn` with the same numbers, in 0.2.0.

## [0.3.0](https://github.com/rumankazi/flowpact/compare/v0.2.1...v0.3.0) (2026-10-08)


### Features

* impact mode for publishers of reusable workflows and actions ([#20](https://github.com/rumankazi/flowpact/issues/20)) ([9531d70](https://github.com/rumankazi/flowpact/commit/9531d70127b445baaf90359142efda9a8148e5db))

## [0.2.1](https://github.com/rumankazi/flowpact/compare/v0.2.0...v0.2.1) (2026-10-08)


### Bug Fixes

* **reporters:** leave findings accepted by overrides out of SARIF ([#21](https://github.com/rumankazi/flowpact/issues/21)) ([efb84ee](https://github.com/rumankazi/flowpact/commit/efb84ee6468248c48fb3a1ac6eba3d38c0884ed4))

## [0.2.0](https://github.com/rumankazi/flowpact/compare/v0.1.1...v0.2.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* rename wfc to flowpact ([#18](https://github.com/rumankazi/flowpact/issues/18))

### Features

* rename wfc to flowpact ([#18](https://github.com/rumankazi/flowpact/issues/18)) ([b7d04b9](https://github.com/rumankazi/flowpact/commit/b7d04b9cf78679250aa09e731dae4aedb77d451b))

## [0.1.1](https://github.com/rumankazi/wfc/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* **action:** shorten the description to fit the GitHub Marketplace limit ([#5](https://github.com/rumankazi/wfc/issues/5)) ([2ea93bb](https://github.com/rumankazi/wfc/commit/2ea93bb5bc7073046a26292c7da849ee21ad9445))

## [0.1.0] — 2026-10-08

First release.

### Engine

- Parses workflows and local composite/JavaScript/Docker actions into a data-flow graph with exact source positions:
  inputs, secrets, env, matrix keys and outputs across nested reusable workflows, same-repository `owner/repo@ref`
  references, YAML anchors and aliases.
- Uses GitHub's own `@actions/expressions` and `@actions/workflow-parser` for expressions and schema validation.
- Expands matrices exactly like GitHub (`include`/`exclude`) and evaluates bindings per combination, honouring each
  job's and step's own `if:`.

### Rules (45)

- `WFC1xx` inputs, `WFC2xx` secrets, `WFC3xx` outputs, `WFC4xx` matrix, `WFC5xx` expressions, env, schema and context
  availability, `WFC6xx` structure, `WFC8xx` contracts, `WFC9xx` overrides. Every finding has a code, location, call
  chain, why, fix and docs link.

### Contracts

- `wfc generate` writes a deterministic, semantic contract per workflow and local action to
  `.github/workflow-contracts/`; `wfc check` reports drift and classifies breaking changes; `--patch` writes a
  `git apply`-able patch.

### Configuration

- `.github/workflow-contracts/wfc.config.yml` with rule severities, limits, ignored paths, overrides (mandatory
  reason, optional expiry and owner), declared shapes for runtime-computed matrices, and plugins. JSON Schemas for the
  config, contracts and the JSON report are published at `https://rumankazi.github.io/wfc/schemas/`.

### CLI (`npx workflow-contracts`, command `wfc`)

- `lint`, `check`, `generate`, `trace`, `graph`, `explain`, `rules`; pretty, JSON, Markdown and SARIF output; reports
  to files; debug logging; exit codes 0 (clean), 1 (findings), 2 (usage/config error), 3 (internal error).

### GitHub Action (`rumankazi/wfc@v0`)

- Job summary, pull request annotations, JSON/SARIF/Markdown reports, and — in check mode — the regenerated contracts
  plus a patch as a downloadable artifact for people who cannot run the CLI.

[0.1.0]: https://github.com/rumankazi/wfc/releases/tag/v0.1.0
