# TcView 1.0.0-alpha.3

Public alpha focused on startup performance, explorer responsiveness, and release readiness.

## Highlights

- Faster startup and first paint for representative TwinCAT workspaces
- Narrower background validation and incremental refresh work
- Webview explorer polish for authoring and state updates
- Tracked representative runtime baselines for recurring workspace profiles
- Public-repo documentation cleanup and GitFlow/release automation preparation

## What Changed

### Performance

- reduced TwinCAT root and `.tsproj` startup overhead with cached and persisted structure reuse
- reduced tree refresh churn by separating structural refreshes from content/state refreshes
- reduced webview explorer refresh cost through slimmer payloads and less redundant refresh work
- reduced background diagnostics rescans by narrowing validation to changed files, affected projects, and lightweight dependent-file sets
- refreshed the synthetic large-workspace performance guardrail digests to match the validated current output

### Explorer And Editing

- Explorer supports TwinCAT-aware authoring flows such as create, rename, delete, copy/cut/paste, and member creation for supported items
- diagnostics are reflected more consistently in the Explorer, including background-validated files and aggregated parent nodes

### Repo And Release Prep

- tracked curated runtime baselines for representative workspaces:
  - `FO_Standard`
  - `LibraryDev`
- cleaned documentation links so public repo docs use portable relative paths
- prepared GitFlow-aligned public release/tag workflow around `release/<version>` and `v<version>` tags

## Validation Snapshot

- `npm run compile`
- `npm test`
- `npm run test:integration`
- `npm run test:perf:guardrails`
- `npm run test:packaging:backend -- --vsix tcview-1.0.0-alpha.3.vsix`

## Known Scope Boundaries

- Windows-only
- intended as a TwinCAT XAE companion, not an XAE replacement
- backend-powered library automation remains best-effort alpha functionality
