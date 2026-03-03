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

## Next Priorities

### Performance

1. Cache parsed `.tsproj` and `.plcproj` content by `mtime`
2. Reduce repeated workspace/root scans
3. Narrow analyzer/tree invalidation further on file change
4. Add regression checks for larger TwinCAT workspaces

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

### Packaging and Release

1. Decide whether backend-enabled releases will ship:
   - self-contained backend
   - framework-dependent backend
   - or no backend in the VSIX
2. Document that release choice explicitly before publishing beyond local/manual installs

## Later Work

1. Add richer navigation from library viewer items back to source or owning project artifacts
2. Add clearer project header/status UX in the TcView sidebar
3. Add more XAE-like naming/icon polish without expanding into runtime/configuration scope
4. Revisit broader XAE-adjacent workflows only after an explicit scope/design pass
