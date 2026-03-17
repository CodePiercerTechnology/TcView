# TcView Development

## Main Build Commands

- Compile: `npm run compile`
- Functionality tests: `npm run test:functionality`
- Regression tests: `npm run test:regression`
- Update regression goldens: `npm run test:regression:update`
- Performance guardrails: `npm run test:perf:guardrails`
- Performance budget updater (dry run): `npm run test:perf:update-budget`
- Combined non-UI test suite: `npm test`
- Integration tests: `npm run test:integration`
- Full matrix (functionality + regression + integration): `npm run test:all`
- Package VSIX: `npx @vscode/vsce package`
- Runtime perf baseline export (from VS Code command palette): `Export TcView Performance Baseline`
- Runtime perf trace export (from VS Code command palette): `Export TcView Performance Trace`

If integration runtime download fails with TLS trust errors in a locked-down network, run:

- configure your system/Node trust chain so `NODE_EXTRA_CA_CERTS` or OS trust includes your organization CA
- `npm run test:integration`

or as a fallback:

- `TCVIEW_INTEGRATION_ALLOW_INSECURE_TLS=1 npm run test:integration`

Regression golden baselines live under:

- `src/tests/regression/golden`

Optional: export a machine-readable performance snapshot from the large-workspace regression check:

- `set TCVIEW_PERF_REPORT_FILE=.test-results/perf/large-workspace.json`
- `npm run test:regression`
- `npm run test:perf:guardrails`

Performance process documents:

- [performance-baselines.md](./performance-baselines.md)
- [performance-trace-triage.md](./performance-trace-triage.md)
- Backend validation helper: `npm run test:backend:validate`

Curated tracked runtime baselines live under:

- `.tests/perf/runtime/fo_standard_runtime-baseline.json`
- `.tests/perf/runtime/libraryDev_runtime-baseline.json`

Ad hoc local exports can still use:

- `.tests/perf/runtime/runtime-baseline.json`

## Extension Development Host

Typical workflow:

1. `npm install`
2. `npm run compile`
3. Press `F5` in VS Code

The development host is the fastest way to test:

- virtual ST editing
- tree view behavior
- diagnostics and semantic tokens
- library viewer behavior

## Backend Development

The backend project lives in:

- [backend/TcView.Backend](../backend/TcView.Backend)

Supporting solution:

- [TcView.sln](../TcView.sln)

Use this when working on TwinCAT Automation Interface features such as:

- install library project
- add library reference
- remove library reference

Current reality:

- the repo contains backend source
- the packaged VSIX ships the release backend output for Windows alpha builds
- backend commands should work against the bundled backend by default
- `twincat.backend.executablePath` is an override when testing a custom backend

## Packaging

The extension now uses a `files` whitelist in [package.json](../package.json) to keep the VSIX focused on runtime assets.

That means the shipped package contains:

- compiled extension output
- runtime resources
- syntax files
- top-level package metadata/docs needed by VS Code

and does not need to rely on a large ignore-only package layout.

## Documentation Layout

- [README.md](../README.md): user-facing overview and install/use guidance
- [architecture.md](./architecture.md): implementation structure and boundaries
- [library-metadata.md](./library-metadata.md): metadata model and library recognition
- [performance-baselines.md](./performance-baselines.md): baseline capture process and CI guardrail inputs
- [performance-trace-triage.md](./performance-trace-triage.md): runtime trace triage checklist for alpha issues
- [alpha-release-checklist.md](./alpha-release-checklist.md): pre-alpha ship checklist with build/install/function/perf gates
- [alpha-troubleshooting.md](./alpha-troubleshooting.md): tester troubleshooting and environment capture guide
- [backend-validation.md](./backend-validation.md): backend success/failure validation runbook for alpha machines
- [support-matrix.md](./support-matrix.md): initial alpha support boundary
- [gitflow.md](./gitflow.md): branch model, local helper commands, release tags, and back-merge policy
- [github-rulesets.md](./github-rulesets.md): protected-branch and repository-settings baseline for GitFlow
- [production-readiness.md](./production-readiness.md): release gates and remaining risk areas
- [roadmap.md](./roadmap.md): roadmap and planned work

## Cleanup Notes

Current audit result:

- no obvious source files are safe to delete right now without removing active runtime or optional backend behavior
- the backend source still has value because library Automation Interface commands depend on it during development
- the main cleanup gain at this stage is clearer packaging and clearer documentation, not aggressive source deletion
