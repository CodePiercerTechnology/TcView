# TcView

TcView is a Windows-only VS Code extension for working with TwinCAT PLC artifacts in Structured Text instead of raw TwinCAT XML.

It is intended to be a supplemental code-centric tool alongside TwinCAT XAE, not a replacement for XAE.

## What TcView Is

- An ST-first editor for TwinCAT XML-backed PLC source files
- A TwinCAT-aware tree view for valid TwinCAT solutions and PLC project roots
- A lightweight code-navigation and library-inspection tool
- A quick way to build the active TwinCAT solution from VS Code

## What TcView Is Not

- Not a full TwinCAT XAE replacement
- Not a device/configuration engineering environment
- Not a runtime administration or online-debugging workstation

Use TcView for editing, navigation, metadata-backed recognition, and quick inspection.
Use TwinCAT XAE for device engineering, configuration activation, runtime control, and full compiler/runtime truth.

## Current Feature Set

- Open supported TwinCAT XML artifacts as editable ST
- Save ST changes back to the original XML source
- Browse TwinCAT projects in a `SYSTEM` / `PLC` / `I/O` tree
- Show per-PLC `References` and open library references in an API-style viewer
- Build the active TwinCAT solution with MSBuild
- Run language features in the editor:
  - diagnostics
  - completion
  - hover
  - rename/references
  - symbols/folding/code actions
- Recognize libraries from layered metadata:
  - current PLC `.tmc`
  - installed Managed Libraries metadata
  - built-in Beckhoff catalog metadata
  - per-user and optional workspace metadata files
- Import library project metadata by scanning a selected `.plcproj` or project folder and storing the extracted public API in TcView's global metadata catalog
- Update or remove user library metadata entries from the TcView metadata catalog when project-source metadata changes
- Prune unused user library metadata entries for the current workspace or selected PLC project
- Use optional TwinCAT Automation Interface commands for add/remove library reference through the bundled backend

## Supported Roots

TcView activates on real TwinCAT roots only:

- TwinCAT solution root:
  - contains `.sln` plus `.tsproj` or `.tspproj`
- Standalone PLC project root:
  - contains `.plcproj`

A plain `.sln` without a `.tsproj` or `.tspproj` is not treated as a TwinCAT solution.
The `Open TwinCAT Solution` command only opens `.sln` files.

## Supported File Types

| Type | Extension |
| --- | --- |
| POU | `.TcPOU` |
| Global Variable List | `.TcGVL` |
| Data Type | `.TcDUT` |
| Program | `.TcPRG` |
| Application | `.TcAPP` |
| Communication | `.TcCOM` |
| Variable Container | `.TcVAR` |
| I/O | `.TcIO` |
| Interface | `.TcITF` |

## Install

### From Source

1. `npm install`
2. `npm run compile`
3. Press `F5` in VS Code

### Package As VSIX

1. `npm install -g @vscode/vsce`
2. `vsce package`
3. Install the generated `.vsix` in VS Code

## Bundled Backend

Most TcView features run entirely in the VS Code extension host.

The backend is only needed for TwinCAT Automation Interface operations such as:

- `Add TwinCAT Library To Project`
- `Remove TwinCAT Library From Project`

Important:

- The packaged extension ships a bundled backend for these commands.
- The bundled backend currently targets `net8.0-windows`.
- `twincat.backend.executablePath` is an override for advanced/custom backend scenarios, not a normal user requirement.
- If the bundled backend cannot launch, verify the required .NET runtime is installed and capture the exact error text.

## Settings You Will Likely Care About

| Setting | Purpose |
| --- | --- |
| `twincat.build.msbuildPath` | Explicit MSBuild path override |
| `twincat.backend.tmcRoots` | Additional `.tmc` lookup roots |
| `twincat.library.managedRoots` | Additional Managed Libraries roots |
| `twincat.library.metadataFiles` | Additional library metadata JSON files |
| `twincat.backend.executablePath` | Optional override path for a custom TcView backend executable |

## Library Metadata

TcView resolves libraries from several sources in order of confidence:

1. Project/local source
2. Current PLC `.tmc`
3. Installed Managed Libraries metadata
4. Built-in catalog metadata
5. User/workspace metadata

In practice:

- some core Beckhoff libraries already ship with built-in metadata
- project-local or internal libraries usually need manual metadata import from source
- `.tmc` only reflects what the current consuming project has compiled/exposed, not a complete external library catalog

Global user metadata lives at:

- `%APPDATA%\\TcView\\tcview.libraries.json`

For details, see [Library Metadata](docs/library-metadata.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Library Metadata](docs/library-metadata.md)
- [Development](docs/development.md)
- [Production Readiness](docs/production-readiness.md)
- [GitFlow](docs/gitflow.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](docs/contributing.md)
- [Security Policy](docs/security.md)
- [Code of Conduct](docs/code-of-conduct.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
