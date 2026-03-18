# TcView 1.0.0-alpha.3

Public alpha focused on startup performance, explorer responsiveness, and a cleaner first-time experience.

## Highlights

- Faster startup and first paint for representative TwinCAT workspaces
- Smoother Explorer refresh behavior and authoring interactions
- Narrower background validation and incremental refresh work
- Cleaner public documentation, onboarding, and issue-reporting surfaces
- Tracked representative runtime baselines for recurring workspace profiles

## What Changed

### Performance And Responsiveness

- reduced TwinCAT root and `.tsproj` startup overhead with cached and persisted structure reuse
- reduced tree refresh churn by separating structural refreshes from content/state refreshes
- reduced webview explorer refresh cost through slimmer payloads and less redundant refresh work
- reduced background diagnostics rescans by narrowing validation to changed files, affected projects, and lightweight dependent-file sets
- refreshed the synthetic large-workspace performance guardrail digests to match the validated current output

### Explorer And Editing

- Explorer supports TwinCAT-aware authoring flows such as create, rename, delete, copy/cut/paste, and member creation for supported items
- diagnostics are reflected more consistently in the Explorer, including background-validated files and aggregated parent nodes

### Public Alpha Polish

- tracked curated runtime baselines for representative workspaces:
  - `FO_Standard`
  - `LibraryDev`
- cleaned public documentation links so the repo reads cleanly outside the original development environment
- tightened README, contributing guidance, support materials, and issue templates for outside users and collaborators

## Validation

- `npm run compile`
- `npm test`
- `npm run test:integration`
- `npm run test:perf:guardrails`
- `npm run test:packaging:backend -- --vsix tcview-1.0.0-alpha.3.vsix`

## Scope For This Alpha

- Windows-only
- intended as a TwinCAT XAE companion, not an XAE replacement
- backend-powered library automation remains best-effort alpha functionality
