# TcView Production Readiness

## Status Key

- `PASS`: implemented and locally verified
- `PARTIAL`: implemented but still needs broader validation
- `TODO`: not yet implemented

## Product Boundary

- `PASS` Windows-only extension distribution is explicit
- `PASS` TcView scope is documented as supplemental to TwinCAT XAE
- `PASS` Current feature set stays code-centric instead of attempting runtime/configuration parity
- `PARTIAL` Optional backend-powered Automation Interface features exist, but backend packaging/distribution is not finalized

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
- `PARTIAL` Backend is not currently shipped in the VSIX, so backend-powered commands depend on a locally built/configured backend
- `TODO` Finalize backend release strategy before broader distribution

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
