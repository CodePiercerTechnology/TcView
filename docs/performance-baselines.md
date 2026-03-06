# TcView Performance Baselines

This document defines how alpha testers and CI should capture and compare TcView performance signals.

## Goals

- keep a stable baseline for the synthetic large-workspace workload
- capture representative runtime snapshots from alpha workspaces
- make pass/fail guardrails explicit and reproducible

## CI Guardrail Inputs

- Report file: `.test-results/perf/large-workspace.json`
- Budget file: `.github/perf/ci-budget.json`
- Validation command: `npm run test:perf:guardrails`

Default CI thresholds are intentionally conservative and should be tightened as alpha history grows.
Use the updater utility to suggest a tighter `maxElapsedMs` from recent reports:

- dry run: `npm run test:perf:update-budget`
- persist update: `npm run test:perf:update-budget -- --write`
- include custom history dir: `npm run test:perf:update-budget -- --history-dir .test-results/perf/history --write`

## Local Capture Workflow

1. Run regression performance workload and emit report:
   - `set TCVIEW_PERF_REPORT_FILE=.test-results/perf/large-workspace.json`
   - `npm run test:regression`
2. Validate against guardrails:
   - `npm run test:perf:guardrails`
3. Export runtime baseline from VS Code command palette:
   - `Export TcView Performance Baseline`
4. Save the exported runtime baseline JSON under a dated folder for the target workspace profile.

## Alpha Workspace Profiles

Capture and retain baselines for at least these workspace shapes:

1. standalone PLC project
2. solution with one PLC project and light library usage
3. solution with multiple PLC projects and heavy library usage

For each profile, store:

- TwinCAT/XAE version
- VS Code version
- machine CPU/RAM
- report JSON (`large-workspace.json`)
- runtime baseline export (`runtime-baseline.json`)
- optional runtime trace export (`runtime-trace.json`)

## Baseline Review Cadence

- review trend deltas weekly during alpha
- update `.github/perf/ci-budget.json` only after at least three consistent runs (the updater defaults to `--min-samples 3`)
- tighten thresholds incrementally to avoid flaky CI failures
