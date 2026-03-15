# TcView Performance Baselines

This document defines how alpha testers and CI should capture and compare TcView performance signals.

## Goals

- keep a stable baseline for the synthetic large-workspace workload
- capture representative runtime snapshots from alpha workspaces
- track save-path workload stability in addition to convert/fragment throughput
- make pass/fail guardrails explicit and reproducible

## CI Guardrail Inputs

- Report file: `.test-results/perf/large-workspace.json`
- Budget file: `.github/perf/ci-budget.json`
- Validation command: `npm run test:perf:guardrails`
- Current synthetic guardrail dimensions:
  - full-file conversions
  - fragment extraction
  - repeated save-roundtrip transforms

Default CI thresholds are intentionally conservative and should be tightened as alpha history grows.
Use the updater utility to suggest a tighter `maxElapsedMs` from recent reports:

- dry run: `npm run test:perf:update-budget`
- persist update: `npm run test:perf:update-budget -- --write`
- include custom history dir: `npm run test:perf:update-budget -- --history-dir .test-results/perf/history --write`

## Runtime Service Levels

Runtime baselines now have a machine-readable threshold file:

- Runtime thresholds: `.github/perf/runtime-baselines.json`
- Runtime checker: `npm run test:perf:runtime -- --baseline <path-to-runtime-baseline-or-trace.json>`
- Runtime comparison: `npm run test:perf:runtime:compare -- --baseline <path-a> --baseline <path-b> ...`

The runtime levels mean:

- `ideal`: healthy target for normal development on a representative local Windows workspace
- `acceptable`: usable for alpha; keep tracking, but not necessarily a blocker by itself
- `bad`: investigate; repeated results in this band should block release or trigger targeted perf work

Current runtime thresholds are intentionally realistic, based on the alpha-era traces we have been collecting rather than purely aspirational targets.
They should be revised only after repeated captures across representative workspaces.

### Current Runtime Targets

| Aspect | Metric | Ideal | Acceptable | Bad |
| --- | --- | ---: | ---: | ---: |
| Explorer startup | `tree.discovery.resolveRoot` | `<= 400 ms` | `<= 900 ms` | `> 900 ms` |
| Explorer first paint | `tree.webview.refresh` | `<= 300 ms` | `<= 800 ms` | `> 800 ms` |
| Explorer structure payload | `tree.webview.refresh.postMessage.roots` | `<= 120 ms` | `<= 300 ms` | `> 300 ms` |
| Explorer state payload | `tree.webview.refresh.postMessage.state` | `<= 120 ms` | `<= 300 ms` | `> 300 ms` |
| Root expansion | `tree.refresh.topLevelGroups` | `<= 150 ms` | `<= 400 ms` | `> 400 ms` |
| Folder expansion | `tree.refresh.folderContents` | `<= 20 ms` | `<= 60 ms` | `> 60 ms` |
| Full analyzer rebuild | `reindex.full` | `<= 800 ms` | `<= 1600 ms` | `> 1600 ms` |
| Incremental analyzer update | `reindex.incremental` | `<= 40 ms` | `<= 120 ms` | `> 120 ms` |
| Library metadata refresh item | `reindex.libraryMetadata` | `<= 120 ms` | `<= 300 ms` | `> 300 ms` |
| File open preload | `open.file.preload` | `<= 20 ms` | `<= 60 ms` | `> 60 ms` |
| File open document | `open.file.document` | `<= 10 ms` | `<= 30 ms` | `> 30 ms` |
| File open editor reveal | `open.file.editor` | `<= 75 ms` | `<= 150 ms` | `> 150 ms` |
| Fragment open preload | `open.fragment.preload` | `<= 20 ms` | `<= 50 ms` | `> 50 ms` |
| Fragment open document | `open.fragment.document` | `<= 40 ms` | `<= 100 ms` | `> 100 ms` |
| Fragment open editor reveal | `open.fragment.editor` | `<= 80 ms` | `<= 180 ms` | `> 180 ms` |
| Save back to XML | `save.toOriginalXml` | `<= 80 ms` | `<= 180 ms` | `> 180 ms` |

Use the checker like this:

1. Export a runtime baseline or trace from VS Code:
   - `Export TcView Performance Baseline`
   - or `Export TcView Performance Trace`
2. Classify it:
   - `npm run test:perf:runtime -- --baseline ..\\runtime-baseline.json`

To compare several exported baselines or traces at once:

- `npm run test:perf:runtime:compare -- --baseline .test-results\\perf\\runtime\\FO_Standard\\runtime-baseline.json --baseline .test-results\\perf\\runtime\\LibraryDev\\runtime-baseline.json`

If you want the checker to fail on bad values:

- `npm run test:perf:runtime -- --baseline ..\\runtime-baseline.json --fail-on bad`

## Local Capture Workflow

1. Run regression performance workload and emit report:
   - `set TCVIEW_PERF_REPORT_FILE=.test-results/perf/large-workspace.json`
   - `npm run test:regression`
2. Validate against guardrails:
   - `npm run test:perf:guardrails`
3. Export runtime baseline from VS Code command palette:
   - `Export TcView Performance Baseline`
4. Classify the runtime baseline:
   - `npm run test:perf:runtime -- --baseline <path-to-runtime-baseline-or-trace.json>`
5. Save the exported runtime baseline JSON under a dated folder for the target workspace profile.

Recommended local archive layout:

- `.test-results/perf/runtime/<workspace-profile>/<yyyy-mm-dd>/runtime-baseline.json`
- `.test-results/perf/runtime/<workspace-profile>/<yyyy-mm-dd>/runtime-trace.json`

## Alpha Workspace Profiles

Capture and retain baselines for at least these workspace shapes:

1. standalone PLC project
2. solution with one PLC project and light library usage
3. solution with multiple PLC projects and heavy library usage

Current real workspace candidates we should keep using:

1. `FO_Standard`
   - good representative for solution-backed project loading and startup explorer cost
2. `LibraryDev`
   - good representative for external project references and heavier library resolution paths

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
- update `.github/perf/runtime-baselines.json` only after repeated captures on representative workspaces and a clear reason to tighten or relax a target
- tighten thresholds incrementally to avoid flaky CI failures
