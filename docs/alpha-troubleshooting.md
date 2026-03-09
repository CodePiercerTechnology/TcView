# TcView Alpha Troubleshooting

Use this guide when alpha testers cannot build, install, open, or diagnose a TcView workspace.

## Required Environment

- OS: Windows
- VS Code: version compatible with `^1.80.0`
- Workspace artifacts:
  - solution flow: `.sln` plus `.tsproj` or `.tspproj`
  - standalone PLC flow: `.plcproj`
- Optional build flow:
  - TwinCAT XAE / MSBuild available for solution build testing
- Optional backend flow:
  - bundled backend included with the VSIX
  - .NET runtime compatible with the bundled `net8.0-windows` backend

## Expected Workspace Layouts

Supported first:

- solution root containing:
  - `.sln`
  - `.tsproj` or `.tspproj`
  - one or more PLC project folders containing `.plcproj`
- standalone PLC project folder containing:
  - `.plcproj`
  - TwinCAT XML artifacts such as `.TcPOU`, `.TcDUT`, `.TcGVL`

Less predictable layouts:

- deeply nested solution roots
- mixed repositories where TwinCAT files are not near the discovered root
- partial checkouts missing sibling project metadata

## Common Problems

### TcView tree shows no TwinCAT content

Check:

- the opened folder is the solution root or a direct parent within a shallow nesting level
- required `.sln`, `.tsproj`/`.tspproj`, or `.plcproj` files exist
- the workspace is on local disk and not a partially synced placeholder folder

Actions:

1. Run `Refresh TcView Files`
2. Reload the VS Code window
3. Open the actual solution or PLC project root instead of a higher monorepo folder

### Build command is unavailable or fails immediately

Check:

- workspace is a solution-shaped TwinCAT workspace
- `MSBuild.exe` is discoverable, or `twincat.build.msbuildPath` is set
- TwinCAT/XAE is installed on the machine being tested

Actions:

1. Set `twincat.build.msbuildPath` if auto-discovery misses MSBuild
2. Retry on a machine with TwinCAT/XAE installed
3. Capture the output/error text in the alpha issue report

### Backend commands fail or are missing

Current alpha reality:

- backend-powered library automation is optional
- the shipped VSIX includes the bundled backend for these commands

Check:

- the machine has the runtime needed for the bundled `net8.0-windows` backend
- if `twincat.backend.executablePath` is set, it points to a valid override executable or `.dll`

Actions:

1. Clear `twincat.backend.executablePath` if an old override path is stale
2. Verify the required .NET runtime is installed
3. If testing from source, rebuild backend with `npm run vscode:prepublish` or `dotnet build`
4. Include backend-present vs backend-failure details in the report

### Performance feels slow

Capture:

1. `Export TcView Performance Baseline`
2. `Export TcView Performance Trace`
3. the workspace shape:
   - solution
   - standalone PLC
   - large/multi-project

Then compare using:

- [performance-baselines.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/performance-baselines.md)
- [performance-trace-triage.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/performance-trace-triage.md)

## Report Checklist

Before filing an alpha issue, capture:

- VS Code version
- TcView version or commit
- TwinCAT/XAE version if relevant
- workspace shape
- whether backend is configured
- exact reproduction steps
- sample file or minimal project, if shareable
- baseline/trace JSON for performance issues
