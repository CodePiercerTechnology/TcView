# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

### Added
- Added a production-alpha readiness gate to the roadmap with required CI, validation, support-matrix, and release-process items
- Added a Windows GitHub Actions CI workflow that runs compile, regression tests, integration smoke tests, and VSIX packaging validation on pull requests and pushes to `main`
- Added a synthetic large-workspace regression test with golden digest validation and configurable runtime threshold
- Added integration smoke coverage for a synthetic large-workspace tree refresh/open path
- Added optional JSON performance reporting for the large-workspace regression workload and CI artifact upload for baseline tracking
- Added `Export TcView Performance Baseline` command to write a JSON runtime telemetry snapshot for baseline/trend analysis
- Added `Export TcView Performance Trace` command to write threshold-based slow-operation trace events with baseline context

### Changed
- Added mtime-based caching for `.plcproj`/`.tsproj`/`.tspproj` metadata reads in the project analyzer
- Added mtime-based XML parse caching for `.plcproj`/`.tsproj` in the TcView tree provider
- Reduced repeated workspace solution/marker scans in extension activation flows via lightweight caching with watcher-driven invalidation
- Improved tree metadata invalidation so `.plcproj`/`.tsproj` changes clear related caches and refresh grouping/reference views
- Reduced no-op analyzer invalidation churn by publishing incremental index refresh events only when file contributions actually mutate
- Reduced tree-view invalidation churn by differentiating content-only file changes from structural tree changes
- Improved integration test TLS handling by auto-detecting a local CA PEM (`TCVIEW_NODE_EXTRA_CA_CERTS` or `C:\certs\zscaler.pem`) and relaunching with `NODE_EXTRA_CA_CERTS`
- Reduced repeated tree provider directory scans by adding mtime-based directory-entry caching and explicit create/delete invalidation
- Added stable runtime perf metric families (`open.*`, `reindex.*`, `tree.*`, `save.*`) and baseline rollups for open/reindex/tree refresh analysis
- Added configurable slow-trace capture (`twincat.performanceTraceThresholdMs`) for targeted profiling of real-world workspace hot paths
- Improved tree-view visual polish with clearer TwinCAT artifact icon differentiation, folder-first ordering, and concise file-kind labels
- Aligned TwinCAT tree naming with XAE-style browsing by showing extensionless artifact names in file nodes

## [0.0.5] - 2026-03-03

### Fixed
- Improved TwinCAT Automation Interface project opening for library operations by trying both `tsproj` and `sln` targets and emitting detailed open-attempt diagnostics

## [0.0.4] - 2026-03-03

### Fixed
- Prevented backend request ID parsing failures by using a safe client-side counter and 64-bit request ID parsing in the backend

## [0.0.3] - 2026-03-03

### Changed
- Limited `Add TwinCAT Library To Project` to the `References` context area instead of exposing it as a top-level sidebar action
- Fixed standalone TwinCAT `.plcproj` workspaces so PLC project files appear in the TcView tree
- Packaged the TcView backend build output in the VSIX and wired prepublish to build it automatically so library install/add/remove commands can run after install

## [0.0.2] - 2026-03-03

### Added
- Layered library recognition from `.tmc`, Managed Libraries metadata, built-in Beckhoff catalog metadata, and per-user/workspace metadata files
- Library project metadata import into a global per-user TcView metadata catalog
- TwinCAT Automation Interface commands for library install/add/remove through the optional backend
- System-global `Tc3_GlobalTypes` family handling, including support for post-build-4026 virtual child libraries
- Project-scoped library API viewer with metadata/source coverage cues

### Changed
- Tightened TwinCAT root detection so only real TwinCAT solution/project roots activate project-aware TcView behavior
- Improved syntax recognition for conversion builtins and block comments
- Expanded built-in Beckhoff metadata coverage, including common `Tc3_Module` HRESULT constants
- Reorganized repository documentation around user guide, architecture, library metadata, development, and release readiness
- Fixed VSIX packaging so runtime XML parser dependencies are shipped and the tree view commands/providers register correctly after install

## [0.0.1] - 2026-02-27

### Added
- Initial extension implementation and language tooling.
