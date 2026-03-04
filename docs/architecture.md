# TcView Architecture

## Scope Boundary

TcView is a code-centric TwinCAT companion for VS Code.

It is designed around:

- editing TwinCAT PLC source in ST form
- project browsing and navigation
- metadata-backed library recognition
- quick solution build support

It is not designed to replace TwinCAT XAE runtime, configuration, or device-engineering workflows.

## Main Components

### Extension Host

Primary implementation lives in the TypeScript extension.

Key files:

- [extension.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/extension.ts)
- [tcViewFileExplorerProvider.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewFileExplorerProvider.ts)
- [tcViewFileSystemProvider.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewFileSystemProvider.ts)
- [tcViewProjectAnalyzer.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewProjectAnalyzer.ts)
- [iecStLanguageFeatures.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/iecStLanguageFeatures.ts)

Responsibilities:

- workspace/root detection
- tree view population
- virtual ST file handling
- save-back to XML
- diagnostics, completion, hover, rename, references, folding, semantic tokens
- local project and library metadata analysis
- library viewer webview generation
- solution build orchestration

### Virtual ST Layer

TcView does not edit TwinCAT XML directly in the visible editor surface.

Flow:

1. XML source is converted into ST text
2. ST is edited in a virtual document
3. save writes the ST back into the original XML structure

Key files:

- [tcViewXmlConverter.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewXmlConverter.ts)
- [tcViewFragmentCodec.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewFragmentCodec.ts)
- [tcViewFileSystemProvider.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewFileSystemProvider.ts)

### Project Analyzer

The analyzer builds the symbol/type view used by diagnostics, completion, hover, and library inspection.

Sources merged by the analyzer:

1. local TwinCAT source files
2. project `.plcproj` references
3. project `.tmc`
4. installed Managed Libraries metadata
5. built-in catalog metadata
6. global/workspace metadata files

Key file:

- [tcViewProjectAnalyzer.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/tcViewProjectAnalyzer.ts)

### Optional Backend

The backend is not required for normal editing.

Current backend usage is limited to TwinCAT Automation Interface operations:

- install library project
- add library reference to project
- remove library reference from project

Key files:

- [tcViewBackendClient.ts](c:/Users/TwinCAT/Documents/MyStuff/TcView/src/backend/tcViewBackendClient.ts)
- [Program.cs](c:/Users/TwinCAT/Documents/MyStuff/TcView/backend/TcView.Backend/Program.cs)

Current packaging note:

- backend source exists in the repo
- the shipped VSIX does not currently include a backend executable
- backend commands require a locally built backend and `twincat.backend.executablePath`

## TwinCAT Root Detection

TcView intentionally avoids treating arbitrary folders as TwinCAT roots.

Valid roots:

- solution root:
  - contains `.sln` and `.tsproj` or `.tspproj`
- standalone PLC root:
  - contains `.plcproj`

Anything else remains a normal VS Code folder, with TcView inactive or in welcome state.
The `Open TwinCAT Solution` command accepts `.sln` only.

## Tree View Model

TcView groups detected TwinCAT content into:

- `SYSTEM`
- `PLC`
- `I/O`

Rules:

- solution-like roots show all three groups, even when empty
- standalone PLC roots show only `PLC`
- hidden/internal folders starting with `.` or `_` are excluded

Each PLC project folder can expose:

- source folders/files
- `References`

`References` can include:

- explicit `.plcproj` placeholder references
- synthetic system-global libraries such as `Tc3_GlobalTypes` family entries

## Library Recognition Model

TcView treats library knowledge as layered provenance, not a single binary “known/unknown” state.

Important provenance categories:

- `tmc`
- `managed_libraries`
- `built_in`
- `user`
- `system_global`

This is important because:

- `.tmc` is closest to project truth
- built-in/user metadata is useful earlier, but not compiler-validated
- system-global libraries like `Tc3_GlobalTypes` behave differently from ordinary references

## Build Model

Current build support is intentionally narrow:

- build active TwinCAT solution with MSBuild

There is no current attempt to reproduce full XAE deploy/runtime workflows.

That boundary is deliberate.

## Why the Repo Still Contains a Backend Solution

[TcView.sln](c:/Users/TwinCAT/Documents/MyStuff/TcView/TcView.sln) exists to support backend development in Visual Studio.

It is not the main build entrypoint for the VS Code extension itself.

Extension build/test remains:

- `npm run compile`
- `npm test`
