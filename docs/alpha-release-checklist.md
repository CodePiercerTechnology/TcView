# TcView Alpha Release Checklist

Use this checklist before publishing an alpha VSIX to testers.

## Release Inputs

- candidate commit: `<sha>`
- candidate VSIX: `<path>`
- release notes/changelog updated: `yes` / `no`
- support matrix reviewed: [support-matrix.md](./support-matrix.md)

## 1. Build and Package

- `PASS` / `FAIL` `npm run compile`
- `PASS` / `FAIL` `npm test`
- `PASS` / `FAIL` `npm run test:integration`
- `PASS` / `FAIL` `npm run vscode:prepublish`
- `PASS` / `FAIL` VSIX packaged successfully
- `PASS` / `FAIL` `npm run test:packaging:backend -- --vsix <candidate.vsix>`
- `PASS` / `FAIL` packaged VSIX installs into a clean VS Code profile

Failure in any item above blocks alpha release.

## 2. Core Editing Flow

Verify against at least one solution-shaped workspace and one standalone PLC project if available.

- `PASS` / `FAIL` TcView discovers the workspace and shows the expected tree roots
- `PASS` / `FAIL` opening a `.TcPOU` or `.TcDUT` file shows virtual ST instead of raw XML
- `PASS` / `FAIL` switching back to XML works
- `PASS` / `FAIL` editing ST and saving persists the change back to source XML
- `PASS` / `FAIL` fragment editing works for at least one method or property fragment
- `PASS` / `FAIL` diagnostics appear in the editor and TcView tree for a known error case

## 3. Library and Build Flow

- `PASS` / `FAIL` library viewer opens from a `References` tree node
- `PASS` / `FAIL` project library metadata import works on a known sample
- `PASS` / `FAIL` solution build command succeeds on a known-buildable workspace

If backend commands are included in test scope:

- `PASS` / `FAIL` bundled-backend machine: library install/add/remove commands work
- `PASS` / `FAIL` runtime-missing or stale-override scenario: commands fail with clear user guidance
- `PASS` / `FAIL` backend-failure simulation: launch/runtime errors surface actionable messages

## 4. Performance Gate

- `PASS` / `FAIL` `npm run test:perf:guardrails`
- `PASS` / `FAIL` current performance report archived if this candidate is shared with testers
- `PASS` / `FAIL` at least one runtime baseline exported from VS Code on a representative alpha workspace
- `PASS` / `FAIL` slow-trace capture tested if any runtime operation exceeded threshold expectations

For runtime baseline and trace capture, follow:

- [performance-baselines.md](./performance-baselines.md)
- [performance-trace-triage.md](./performance-trace-triage.md)

## 5. Tester-Facing Artifacts

- `PASS` / `FAIL` troubleshooting guide reviewed: [alpha-troubleshooting.md](./alpha-troubleshooting.md)
- `PASS` / `FAIL` support matrix reviewed: [support-matrix.md](./support-matrix.md)
- `PASS` / `FAIL` GitHub issue templates present for bug and performance reports

## Signoff

- release owner: `<name>`
- date: `<yyyy-mm-dd>`
- decision: `ship alpha` / `hold`
- blocking issues:
  - `<issue or none>`
