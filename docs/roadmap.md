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
- user-imported library project metadata is stored globally per user

### Automation and Build

- TwinCAT solution build is available through MSBuild
- optional Automation Interface commands exist for:
  - install library project
  - add library reference
  - remove library reference
- backend support is opt-in and currently requires a locally built backend executable

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

## Next Priorities

### Performance

1. Add pass/fail guardrails for CI performance metrics once baseline history is established
2. Continue collecting representative workspace baseline documents for alpha test environments and tighten guardrail thresholds from observed history
3. Keep trace triage guidance aligned with new metric families and alpha issue patterns

### Library Metadata

1. Expand built-in Beckhoff internal API coverage beyond the current core set
2. Improve version-aware metadata where Beckhoff library behavior changes by TwinCAT build
3. Surface provenance more clearly in completions/hover, not only the library viewer
4. Reindex library metadata more selectively after imports and `.tmc` updates
5. Validate the Automation Interface library workflows across more TwinCAT/XAE versions

### Editor Quality

1. Continue tightening semantic-token coverage for TwinCAT-specific syntax edge cases
2. Improve Outline/document symbol experience for XAE-like code navigation
3. Expand known system/global type/member modeling where TwinCAT compiler behavior is predictable
4. Add more regression tests for user-reported diagnostics and save issues

### Tree View UX

#### Near-Term

1. Expand tree and explorer context menus with authoring actions such as add folder, add POU, add DUT, and related TwinCAT item creation flows
2. Automatically switch focus to the TcView container when a TwinCAT solution or project is opened, including after reload when the workspace was opened directly through TcView
3. Add a guided "Add PLC Project to Solution" workflow with options to either copy the PLC project into the solution structure or reference the original project directory in place

#### Later Polish

1. Continue refining naming/grouping/icon polish using alpha-workspace feedback while keeping scope narrow
2. Revisit tree diagnostic presentation with a `resourceUri` or hybrid decoration approach so warning/error markers can get closer to native Explorer behavior without regressing TwinCAT-specific icons
3. Evaluate a custom webview-based TwinCAT explorer only if native tree constraints keep blocking diagnostics/icon UX goals, and treat it as an explicit architectural tradeoff rather than incremental polish

### Packaging and Release

1. Decide whether backend-enabled releases will ship:
   - self-contained backend
   - framework-dependent backend
   - or no backend in the VSIX
2. Document that release choice explicitly before publishing beyond local/manual installs

## Production Alpha Readiness Gate

### Required for Alpha

1. Establish a Windows CI pipeline that runs compile, regression tests, integration smoke tests, and VSIX packaging validation on every PR
2. Add an alpha release checklist with explicit pass/fail criteria for build, install, open/edit/save, library operations, and solution build flows
3. Validate optional backend behavior across supported machine states (backend present, backend missing, backend launch/runtime failure) with clear user-facing error guidance
4. Add a tester-facing troubleshooting guide that covers required toolchain versions (VS Code, TwinCAT/XAE, .NET runtime/MSBuild) and expected workspace layouts
5. Add issue templates for alpha testers that capture environment/version metadata and minimal reproduction artifacts
6. Define an initial support matrix (TwinCAT build range, VS Code versions, workspace shape: solution vs standalone PLC project)

### Before Public Preview

1. Decide and document telemetry/error-reporting policy for alpha builds, including privacy notes and opt-in/opt-out behavior
2. Add signed/reproducible release packaging and a documented rollback process

## Later Work

1. Add richer navigation from library viewer items back to source or owning project artifacts
2. Add clearer project header/status UX in the TcView sidebar
3. Add more XAE-like naming/icon polish without expanding into runtime/configuration scope
4. Revisit broader XAE-adjacent workflows only after an explicit scope/design pass
