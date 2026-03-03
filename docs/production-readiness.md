# TcView Production Readiness

## Release Gates

Status key:
- `PASS`: implemented and verified
- `PARTIAL`: implemented but needs broader validation
- `TODO`: not yet implemented

## Platform Boundary

- `PASS` Extension distribution is explicitly Windows-only.
- `PASS` Current feature set is aligned with TwinCAT XAE and MSBuild operating constraints on Windows.
- `PASS` Product scope is supplemental to TwinCAT XAE, not a full XAE replacement.
- `PARTIAL` The optional backend is now used for TwinCAT Automation Interface library operations. A release decision is still needed on whether it is shipped self-contained or requires a user-installed `.NET` runtime.

### 1) Reliability and Data Safety
- `PASS` Fragment save support for `METHOD`, `PROPERTY`, `GET`, `SET`, `ACTION`, `TRANSITION`.
- `PASS` Atomic XML write with backup rollback in filesystem provider.
- `PARTIAL` XML formatting/element ordering stability (works for current parser/builder shape, needs fixture comparison across TwinCAT variants).
- `TODO` XML schema compatibility test suite across multiple TwinCAT versions.

Acceptance checks:
- Save from each fragment type updates only expected XML nodes.
- Injected failure during write does not corrupt the original file.

### 2) Language Correctness
- `PASS` AST-first diagnostics path for semicolons, blocks, strings, parentheses, duplicate declarations, undefined/unused variables.
- `PASS` Case label and multiline expression handling improvements.
- `PASS` Named-argument parsing for multiline FB/function calls.
- `PARTIAL` Full project-wide symbol resolution (inheritance/interfaces/library metadata still limited).
- `TODO` Strict grammar-level parser and semantic model parity with full IEC/TwinCAT compiler behavior.

Acceptance checks:
- Regression snippets in tests remain green.
- No false positive semicolon diagnostics for declaration/control headers.

### 3) Performance and Scale
- `PASS` Operation timing metrics for open/save paths.
- `PASS` Command to inspect performance summary (`tcview.showPerfStats`).
- `PARTIAL` Indexing and diagnostics are optimized but not yet full incremental graph-based.
- `TODO` performance budgets and hard fail thresholds in CI.

Acceptance checks:
- Open/save perf metrics are recorded and inspectable.
- Large project indexing does not block UI thread beyond acceptable thresholds.

### 4) UX and Diagnostics
- `PASS` Quick fixes for missing semicolons, unmatched parentheses, unclosed strings, duplicate/unused declarations, missing variable declaration.
- `PASS` Property tree UX: only `Get`/`Set` nodes open editors.
- `PASS` Project-scoped library API viewer backed by local `.tmc` metadata.
- `PARTIAL` richer symbol docs/signature help for external libraries and deeper library navigation.
- `TODO` broader library coverage when current PLC `.tmc` only exposes a subset of referenced APIs.

Acceptance checks:
- Lightbulb fixes appear via `Ctrl+.`.
- Tree behavior matches user expectations for fragments.

### 5) Automated Quality
- `PASS` compile + unit test scripts.
- `PASS` CI workflow (Ubuntu + Windows) for compile/test.
- `PARTIAL` focused regression tests in one test entrypoint.
- `TODO` end-to-end extension host tests and XML fixture goldens.

Acceptance checks:
- CI required checks must pass on PR.
- Regression tests include user-reported bug snippets.

## Test Commands

- Unit/regression: `npm test`
- Integration (extension host): `npm run test:integration`
  - Note: first run downloads a VS Code test binary via `vscode-test`.

## Near-Term Roadmap (Implementation Order)

1. Add XML fixture-based golden tests for fragment round-trip saves.
2. Add project symbol graph cache with incremental updates by changed file.
3. Add cross-file semantic checks for interface and inheritance contracts.
4. Add CI perf budget smoke gate for parse/diagnostics latency.
5. Add extension-host integration tests for tree open/save flows.

