# TcView Roadmap

## Scope Guardrails

TcView should remain:

- a code-centric TwinCAT companion inside VS Code
- focused on ST-first editing, navigation, metadata-backed recognition, and quick inspection

TcView should not drift into:

- full XAE replacement
- device/configuration engineering
- runtime administration and online-debugging parity with XAE

## Current State

### Editing and Navigation

- ST-first editing works for supported TwinCAT XML artifacts
- save-back to XML is in place
- fragment editing works for methods, properties, actions, and transitions
- TwinCAT-aware tree view groups content into `SYSTEM`, `PLC`, and `I/O`
- tree explorer now uses clearer TwinCAT artifact icon differentiation and folder-first ordering in filesystem groups
- tree explorer file labels now default to extensionless TwinCAT artifact names with concise type badges
- tree explorer now surfaces warning/error markers from active diagnostics on TwinCAT files and parent tree nodes
- the default TcView Explorer is now the webview-backed tree and supports rename, create, delete, and copy/cut/paste flows for supported TwinCAT items
- the Explorer now supports type-specific authoring flows for TwinCAT files and members instead of a single generic create path
- valid TwinCAT root detection is enforced
- `References` tree nodes open an API-style library viewer

### Language Features

- diagnostics, hover, completion, rename/references, folding, semantic tokens, and code actions are in place
- conversion builtins and block comments are recognized in the editor
- common system-global/library constants such as `E_FAIL` and `S_OK` are recognized
- `Tc3_GlobalTypes` is treated as a special system-global family, including build-4026+ virtual child libraries

### Library Recognition

- library recognition is layered across:
  - project source
  - `.tmc`
  - Managed Libraries metadata
  - built-in catalog metadata
  - global/workspace metadata
- built-in Beckhoff catalog includes core libraries such as:
  - `Tc2_Standard`
  - `Tc2_System`
  - `Tc2_Utilities`
  - `Tc3_GlobalTypes`
  - `Tc3_Module`
- PLC-project metadata import now scans `.plcproj` or project folders directly and stores extracted API metadata in the per-user TcView catalog
- project metadata import explicitly warns that it does not install or update the actual TwinCAT library

### Automation and Build

- TwinCAT solution build is available through MSBuild
- optional Automation Interface commands exist for:
  - add library reference
  - remove library reference
- library-project install/export remains an advanced Beckhoff/XAE-hosted path and is not currently exposed in the TcView UI
- Windows alpha packaging now ships a bundled backend for Automation Interface commands by default

### Alpha Readiness

- Windows CI now runs compile, regression tests, integration smoke tests, performance guardrails, and VSIX packaging validation
- user-facing troubleshooting guidance, support matrix, and release notes are now in place for public alpha use
- GitHub issue templates now exist for alpha bug and performance reports
- repo-local governance files now cover CODEOWNERS, PR validation checklist, and branch/ruleset guidance
- local validation now checks that the bundled backend is present in both release output and packaged VSIX artifacts
- backend validation coverage now includes bundled-backend and failure-path checks for alpha machines

### Performance Baseline

- `.plcproj`/`.tsproj`/`.tspproj` project metadata parsing now uses mtime-based caching in core analyzer/tree paths
- workspace solution and marker discovery now uses lightweight caching plus watcher-driven invalidation to reduce repeated scans
- analyzer incremental file updates now only publish index refresh events when file contributions actually changed
- tree watcher refresh now distinguishes content-only changes from structural changes to reduce full cache invalidation churn
- regression suite now includes a synthetic large-workspace conversion/fragment workload with a golden digest and configurable runtime threshold
- tree provider directory entry scans now use mtime-based caching for high-frequency folder/plc-project discovery paths
- integration smoke tests now include a synthetic large-workspace refresh/open path for extension-host coverage
- CI now publishes large-workspace regression performance output as an artifact to support trend tracking
- runtime telemetry now records stable `open.*`, `reindex.*`, `tree.*`, and `save.*` metric families and computes baseline rollups
- TcView now supports exporting a JSON performance baseline snapshot from the command palette
- runtime telemetry now captures threshold-based slow-operation trace events for open/reindex/tree/save flows and supports JSON trace export
- CI now enforces an initial pass/fail performance budget for the large-workspace regression report
- alpha-facing performance baseline capture guidance and trace triage runbook are now documented
- perf budget updater utility now computes tighten-only `maxElapsedMs` suggestions from recent reports
- synthetic large-workspace regression coverage now also includes repeated save-roundtrip transforms so perf guardrails cover save-path churn in addition to open/fragment work
- perf history tooling now supports archiving current reports and skips incompatible history when workload digests change, including save-path coverage changes
- webview explorer refresh now records dedicated `tree.webview.*` runtime metrics, and the synthetic large-workspace perf report now includes a webview-tree structure/state benchmark for `alpha.2` explorer tuning
- startup explorer performance now reuses cached TwinCAT root, `.tsproj`, and top-level directory metadata so first paint and analyzer warmup are substantially faster on representative workspaces
- background validation now narrows refresh work to changed files, affected projects, and lightweight dependent-file sets instead of repeatedly rescanning the full workspace

## Next Priorities

### Performance

1. Continue collecting representative workspace baseline documents for alpha test environments and tighten guardrail thresholds from observed history
2. Keep trace triage guidance aligned with new metric families and alpha issue patterns
3. Reduce post-`openFolder` TcView activation/focus latency so opening a TwinCAT solution from TcView returns to the TcView container with less visible startup lag
4. Keep watching startup and webview refresh regressions as the explorer evolves so the recent gains hold up under new UX work

### Library Metadata

1. Expand built-in Beckhoff internal API coverage beyond the current core set
2. Improve version-aware metadata where Beckhoff library behavior changes by TwinCAT build
3. Surface provenance more clearly in completions/hover, not only the library viewer
4. Reindex library metadata more selectively after imports and `.tmc` updates
5. Validate the Automation Interface library workflows across more TwinCAT/XAE versions
6. Continue tightening PLC-project metadata import coverage and provenance details from source scanning
7. Evaluate offline/semi-automated metadata generation for selected Beckhoff libraries and versions, potentially from official InfoSys content, only if the source structure and licensing make it maintainable
8. Harden the DTE-hosted library-project install/export path only if the automation value still justifies the XAE-host bootstrap complexity
9. Add a workflow to treat a library project as a reference project from TcView, so solution library references can stay aligned with that source project over time
10. Add a guided/manual way to populate or override required library identity metadata for project-source import when `Title`, `Company`, or `LibraryCategory Version` are missing or need correction

### Editor Quality

1. Continue tightening semantic-token coverage for TwinCAT-specific syntax edge cases
2. Improve Outline/document symbol experience for XAE-like code navigation
3. Expand known system/global type/member modeling where TwinCAT compiler behavior is predictable
4. Add more regression tests for user-reported diagnostics and save issues
5. Proactively scan project files for diagnostics on initial load and subsequent file changes so warnings/errors appear in TcView without requiring the file to be opened first
6. Improve workspace Problems integration so TcView diagnostics behave more like project-wide TwinCAT issues, including Beckhoff pragma-aware suppression and rule shaping
7. Add Beckhoff pragma-aware diagnostics for semantically important attributes such as `qualified_only` and `strict`, rather than limiting pragma support to comment-style suppression

### Tree View UX

#### Near-Term

1. Continue closing remaining authoring workflow gaps above the current file/member creation support, especially at the solution/project level
2. Automatically switch focus to the TcView container when a TwinCAT solution or project is opened, including after reload when the workspace was opened directly through TcView
3. Add a guided "Add PLC Project to Solution" workflow with options to either copy the PLC project into the solution structure or reference the original project directory in place

#### Later Polish

1. Continue refining naming/grouping/icon polish using alpha-workspace feedback while keeping scope narrow
2. Revisit tree diagnostic presentation with a `resourceUri` or hybrid decoration approach so warning/error markers can get closer to native Explorer behavior without regressing TwinCAT-specific icons
3. Continue tightening webview explorer parity for drag/drop-style authoring, richer breadcrumbs, and context-sensitive creation flows without expanding scope into full XAE replacement behavior
4. Keep the native/tree-model and webview-renderer split explicit so future explorer work can stay performance-focused and testable

### Packaging and Release

1. Decide whether the shipped backend remains:
   - framework-dependent
   - or moves to self-contained packaging
2. Document that bundled-backend release choice explicitly before publishing beyond local/manual installs

## Production Alpha Readiness Gate

### Required for Alpha

1. Validate optional backend behavior across supported machine states (backend present, backend missing, backend launch/runtime failure) with clear user-facing error guidance

### Before Public Preview

1. Decide and document telemetry/error-reporting policy for alpha builds, including privacy notes and opt-in/opt-out behavior
2. Add signed/reproducible release packaging and a documented rollback process

## Later Work

1. Add richer navigation from library viewer items back to source or owning project artifacts
2. Add clearer project header/status UX in the TcView sidebar
3. Add more XAE-like naming/icon polish without expanding into runtime/configuration scope
4. Revisit broader XAE-adjacent workflows only after an explicit scope/design pass
5. Surface `.tmc` files directly in TcView with an inspection-first UI for symbols and data types, and only consider editing through a structured interface rather than raw source editing
