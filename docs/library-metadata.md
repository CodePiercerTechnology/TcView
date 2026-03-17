# TcView Library Metadata

## Purpose

TwinCAT library recognition is not reliable if TcView only looks at the current PLC project's `.tmc`.

`.tmc` is useful, but it is project-scoped and often partial.

TcView therefore uses a layered metadata model so a referenced library can still be recognized before every symbol is pulled into the current project's compiled output.

## Resolution Layers

TcView merges these sources in descending order of confidence:

1. local project source
2. current PLC `.tmc`
3. installed Managed Libraries metadata
4. built-in TcView catalog metadata
5. per-user and optional workspace metadata files

This distinction matters because:

- `.tmc` is closest to project-usable truth
- metadata is useful for recognition, linting, and navigation
- metadata is not the same thing as compiler validation

## Built-In Catalog

TcView ships with a built-in metadata catalog at:

- [library-metadata.json](../resources/library-metadata.json)

Current built-in Beckhoff coverage includes core libraries such as:

- `Tc2_Standard`
- `Tc2_System`
- `Tc2_Utilities`
- `Tc3_GlobalTypes`
- `Tc3_Module`

The built-in catalog is intended to be conservative:

- useful enough for recognition and editor assistance
- not a claim of perfect compiler parity

## Global User Metadata

TcView stores user-added metadata in:

- `%APPDATA%\\TcView\\tcview.libraries.json`

This lets a user import a library project once and reuse that metadata across TwinCAT projects on the same machine.

## Optional Workspace Metadata

Additional metadata files can be configured with:

- `twincat.library.metadataFiles`

Use this when a team wants project-local overrides or workspace-specific metadata not suitable for the per-user global file.

## Managed Libraries Metadata

TcView can also enrich library references from local TwinCAT Managed Libraries roots.

That metadata is useful for:

- vendor
- version
- install path
- dependency names

It is not treated as the primary API truth source.

## Import Paths

TcView currently supports two metadata-oriented flows:

### Import TwinCAT Library Metadata

Use when you want to seed metadata from a managed library folder or package shape.

This is best for:

- vendor/version/dependency enrichment
- quick catalog seeding

### Import TwinCAT Library Project Metadata

Use when you have the source TwinCAT library project and want real internal library API metadata.

This is best for:

- FBs
- functions
- programs
- data types
- globals

This is the preferred path for non-Beckhoff or internal libraries when you want editor features before `.tmc` exposes them in a consuming project.

## System Global Libraries

`Tc3_GlobalTypes` is handled specially.

Behavior:

- it is treated as an implicit system-global library family
- for TwinCAT build `4026` and later, virtual child libraries can exist beneath it
- TcView supports metadata entries that declare:
  - `"virtualParent": "Tc3_GlobalTypes"`

Example:

```json
{
  "libraries": [
    {
      "name": "MyNamespace_GlobalTypes",
      "virtualParent": "Tc3_GlobalTypes",
      "dataTypes": [
        {
          "name": "ST_SystemWideConfig",
          "kind": "struct",
          "members": {
            "bEnabled": "BOOL"
          }
        }
      ]
    }
  ]
}
```

## Practical Expectation

If a library is identified in the project and TcView has good metadata for it, then TcView should be able to provide:

- no undeclared errors for known library symbols
- completions
- hover
- basic member resolution
- type recognition

The remaining limiter is metadata completeness, not the merge model itself.

## Current Limitation

Metadata-backed recognition improves editor behavior, but it is not the same as full TwinCAT compiler truth.

Treat the sources this way:

- `.tmc`: closest to project truth
- metadata: best-effort recognition and navigation

That distinction is intentional and should stay visible in the UI.
