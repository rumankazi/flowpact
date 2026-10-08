# Changelog

All notable changes to wfc are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/). Rule codes (`WFCnnn`) are stable: a code never changes
meaning, and removed codes are not reused.

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
