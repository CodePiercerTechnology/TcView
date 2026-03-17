# TcView Initial Alpha Support Matrix

This matrix is intentionally narrow. Anything outside it may still work, but is not the primary alpha target.

## Platform

| Area | Status | Notes |
| --- | --- | --- |
| Windows | Target | Extension manifest is Windows-only |
| macOS | Unsupported | Extension is not packaged for non-Windows OS |
| Linux | Unsupported | Extension is not packaged for non-Windows OS |

## VS Code

| Area | Status | Notes |
| --- | --- | --- |
| VS Code `^1.80.0` | Target | Matches `package.json` engine requirement |
| Latest stable VS Code on Windows | Recommended | Preferred alpha test baseline |
| Insiders builds | Best effort | Not part of the primary support claim |

## Workspace Shape

| Area | Status | Notes |
| --- | --- | --- |
| `.sln` + `.tsproj` / `.tspproj` + `.plcproj` | Target | Primary solution workflow |
| standalone `.plcproj` workspace | Target | Browse/edit/save focus; some solution-only features do not apply |
| arbitrary folder with TwinCAT-like files only | Unsupported | TcView intentionally requires real TwinCAT roots |

## Feature Surface

| Area | Status | Notes |
| --- | --- | --- |
| ST browsing, editing, save-back | Target | Core alpha workflow |
| diagnostics, hover, completion, rename, references | Target | Core editor feature set |
| library viewer / metadata-backed inspection | Target | Works without backend |
| MSBuild solution build | Target | Requires TwinCAT/XAE/MSBuild on test machine |
| backend library install/add/remove automation | Best effort | Bundled backend ships in Windows alpha builds; runtime/tooling validation is still ongoing |

## TwinCAT / Backend Assumptions

| Area | Status | Notes |
| --- | --- | --- |
| TwinCAT 3 XML project artifacts (`.plcproj`, `.tsproj`, `.tspproj`, `.tmc`) | Target | Current parser/indexer scope |
| older/non-standard project layouts | Best effort | Validate before broad claims |
| bundled backend executable in VSIX | Target | Windows alpha VSIX includes backend release output |
| backend target `net8.0-windows` | Target | Current backend build/runtime target |

## Reporting Rule

Alpha issues should always include:

- VS Code version
- TcView version or commit
- TwinCAT/XAE version when relevant
- workspace shape
- backend configured: `yes` / `no`
