# TcView Roadmap

## Scope

TcView is intended to be a supplemental TwinCAT development tool inside VS Code.

It is for:
- ST-first editing of TwinCAT XML artifacts
- project browsing and code navigation
- lightweight solution-aware inspection
- library/reference inspection
- quick solution builds from VS Code

It is not intended to be:
- a full TwinCAT XAE replacement
- a runtime/configuration/deployment workstation
- a substitute for Visual Studio + XAE when device configuration, activation, online change, login, or runtime administration is required

## Current State

- ST-first editing is in place for supported TwinCAT XML artifacts.
- Save-back to the original XML source is working.
- The TcView tree detects valid TwinCAT roots and groups content into `SYSTEM`, `PLC`, and `I/O`.
- Standalone PLC project roots are supported.
- Per-PLC `References` nodes are available.
- Library references open in a project-scoped API viewer backed by local `.tmc` metadata.
- Library references are enriched from local Managed Libraries metadata, a built-in catalog, and optional workspace/user metadata files.
- The built-in Beckhoff catalog now includes a broader seed with category and product metadata, including core Beckhoff libraries such as `Tc2_Standard`, `Tc2_System`, `Tc2_Utilities`, `Tc3_GlobalTypes`, and `Tc3_Module`.
- Workspace library metadata files can be scaffolded and seeded from local managed library folders/packages.
- TwinCAT library project source can be imported into the per-user global metadata catalog so internal FBs, types, functions, programs, and globals are available before a consuming project `.tmc` exposes them.
- `Tc3_GlobalTypes` is handled as a special system-global type family, including the post-build-4026 virtual child library pattern via `Tc3_GlobalTypes_Global` and catalog entries that declare `virtualParent: "Tc3_GlobalTypes"`.
- Initial TwinCAT Automation Interface commands exist for:
  - install a library project
  - add a library reference to a PLC project
  - remove a library reference from a PLC project
- Solution build is available through `MSBuild`.
- Problems diagnostics include missing `.tmc` output and non-solution project warnings.
- TcView is explicitly Windows-only.

## Near-Term Improvements

### Performance

1. Add narrower invalidation for tree and analyzer refresh paths.
2. Cache parsed `.tsproj` and `.plcproj` data by `mtime`.
3. Reduce repeated workspace scans during solution/project detection.
4. Add performance regression checks for large TwinCAT workspaces.

### XAE-Like Feel Without XAE Scope Creep

1. Refine `SYSTEM` / `PLC` / `I/O` structure from `.tsproj` content instead of filesystem heuristics where possible.
2. Add more XAE-like naming and icons for PLC, GVL, DUT, task, and reference nodes.
3. Add a project header/status area in TcView showing:
   - active TwinCAT solution
   - active PLC project count
   - build availability
   - missing `.tmc` state
4. Improve the `References` experience with clearer library/source/TMC status labels.
5. Add quick navigation commands for:
   - jump to declaration section
   - jump to implementation
   - jump to owning PLC project

### Libraries and Metadata

1. Add a layered library catalog so TcView can distinguish:
   - referenced in project
   - resolved in current `.tmc`
   - installed locally in Managed Libraries
   - known by built-in metadata only
2. Ship a curated built-in metadata catalog for common Beckhoff libraries so types/functions can be recognized even before a PLC build pulls them into the project `.tmc`.
3. Expand the built-in metadata catalog beyond the current seed set for common Beckhoff libraries.
4. Harden the TwinCAT Automation Interface library workflow:
   - validate tree-item lookup across more TwinCAT/XAE versions
   - support placeholder-oriented add/reference flows where appropriate
   - distinguish install success from reference success more clearly in the UI
   - refresh global metadata from the installed library project
   - keep project-source metadata and installed-library metadata distinct
5. Add clearer provenance in the library viewer and completions:
   - `TMC-resolved`
   - `Installed locally`
   - `Built-in metadata`
   - `User metadata`
6. Allow library metadata refresh/reindex on demand after installs, upgrades, or repository changes.
7. Expand the Beckhoff built-in catalog beyond the current core set and add stricter version-aware metadata where it materially improves symbol recognition.

### Editor Workflow

1. Improve Outline/document symbols so POU structure feels closer to XAE navigation.
2. Expand folding/sticky-scroll usefulness for declarations and implementation sections.
3. Add more TwinCAT-specific snippets, pragmas, and code actions.
4. Improve library member completion from `.tmc` data.

### Reliability and Coverage

1. Add XML fixture-based golden tests for fragment round-trip saves.
2. Add broader TwinCAT schema compatibility tests across versions.
3. Improve project-scoped library viewer coverage where `.tmc` exposes partial APIs.
4. Add more regression tests for user-reported parsing and save issues.

## Later Work

1. Design a separate, explicitly scoped XAE-style workflow plan before reintroducing any activate/login/start functionality.
2. Add richer source/TMC cross-navigation from library API items.
3. Add broader symbol/type coverage for external libraries from `.tmc`.
4. Add optional workspace summary views for PLC projects, libraries, and generated outputs.

## Explicit Non-Goals

These should stay outside normal TcView scope unless there is a deliberate product-direction change:

- TwinCAT runtime activation and state management
- target route administration
- device tree configuration editing
- EtherCAT/fieldbus commissioning workflows
- online monitoring/debugging intended to replace XAE
