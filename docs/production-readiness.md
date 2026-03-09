# TcView Production Readiness

## Status Key

- `PASS`: implemented and locally verified
- `PARTIAL`: implemented but still needs broader validation
- `TODO`: not yet implemented

## Product Boundary

- `PASS` Windows-only extension distribution is explicit
- `PASS` TcView scope is documented as supplemental to TwinCAT XAE
- `PASS` Current feature set stays code-centric instead of attempting runtime/configuration parity
- `PARTIAL` Optional backend-powered Automation Interface features exist, and Windows alpha packaging now bundles the backend, but the final runtime packaging mode still needs confirmation

## 1. Data Safety

- `PASS` ST edits save back to original TwinCAT XML source
- `PASS` Fragment save path supports methods, properties, actions, transitions
- `PASS` Virtual-file workflow avoids direct raw XML editing during normal use
- `PARTIAL` XML schema compatibility still needs broader multi-version fixture coverage
- `TODO` Golden tests across more TwinCAT versions and artifact variants

## 2. Language Correctness

- `PASS` AST-first diagnostics path covers declarations, duplicate symbols, missing semicolons, unmatched blocks, string issues, and undefined/unused variables
- `PASS` Known IEC/TwinCAT builtins and conversion functions are recognized
- `PASS` Common TwinCAT HRESULT constants and `ANY` members are modeled
- `PARTIAL` Full semantic parity with TwinCAT compiler behavior is not the target and is not yet achieved
- `TODO` Broader coverage for edge-case TwinCAT syntax and library/compiler semantics

## 3. Library Recognition

- `PASS` Project `.tmc` is used as primary project-scoped library API truth
- `PASS` Managed Libraries metadata, built-in metadata, and user/workspace metadata can extend recognition
- `PASS` Global user metadata allows imported library project APIs to be reused across projects on the same machine
- `PARTIAL` Built-in Beckhoff catalog coverage is still incomplete beyond the current core set
- `PARTIAL` Automation Interface install/add/remove library flows need more live validation across TwinCAT/XAE versions
- `TODO` Stronger version-aware metadata and broader Beckhoff/internal library coverage

## 4. Performance

- `PASS` Startup behavior was tightened to avoid eager heavy work on activation
- `PASS` Library analyzer paths are now more local-first and backend-light
- `PASS` CI includes an initial pass/fail large-workspace performance guardrail check
- `PARTIAL` Tree/analyzer invalidation still has room for more granular caching
- `TODO` Explicit performance budgets and larger-project regression coverage

## 5. User Experience

- `PASS` TcView tree enforces real TwinCAT roots instead of treating arbitrary folders as TwinCAT solutions
- `PASS` Welcome/loading/discovery states are implemented
- `PASS` Library viewer exposes metadata source and API coverage cues
- `PARTIAL` Some syntax/theme interactions still need iterative polish as user edge cases surface
- `TODO` More XAE-like navigation polish without expanding scope

## 6. Packaging

- `PASS` VSIX contents are now controlled by a `files` whitelist in [package.json](c:/Users/TwinCAT/Documents/MyStuff/TcView/package.json)
- `PASS` Dev-heavy sources/docs/test assets are not required in the shipped runtime package
- `PASS` Windows alpha VSIX packaging includes the release backend output for Automation Interface commands
- `PASS` Local validation now checks that bundled backend files exist both in build output and inside the packaged VSIX
- `PARTIAL` Bundled backend packaging is currently framework-dependent on `net8.0-windows`; broader release strategy still needs confirmation
- `TODO` Decide whether the shipped backend remains framework-dependent or moves to self-contained packaging before broader distribution

## 7. Alpha Operations

- `PASS` Windows CI runs compile, regression tests, integration smoke tests, performance guardrails, and VSIX packaging validation
- `PASS` Alpha release checklist exists in [alpha-release-checklist.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/alpha-release-checklist.md)
- `PASS` Tester troubleshooting guide exists in [alpha-troubleshooting.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/alpha-troubleshooting.md)
- `PASS` Initial support matrix exists in [support-matrix.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/support-matrix.md)
- `PASS` GitHub issue templates exist for alpha bug and performance reports under `.github/ISSUE_TEMPLATE`
- `PASS` Repo-local governance files now exist for code ownership, PR validation checklist, and recommended GitHub ruleset settings
- `PASS` Local tests now cover bundled-backend resolution, stale override fallback, and missing-runtime guidance paths
- `PARTIAL` Optional backend behavior across backend-present, backend-missing, and backend-failure machine states still needs broader live validation against real Automation Interface environments

## Practical Release Readiness Summary

TcView is ready for:

- local/manual installation
- code-centric TwinCAT editing
- project browsing
- metadata-backed library inspection
- quick solution builds

TcView is not yet ready to claim:

- full XAE-equivalent workflows
- fully turnkey backend-powered library automation for normal end users
- broad compiler-parity semantics across all TwinCAT versions
