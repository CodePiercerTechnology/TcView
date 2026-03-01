# TcView Roadmap

## Current State

- ST-first editing for TwinCAT XML artifacts is in place.
- TcView sidebar is solution/project aware and groups content into `SYSTEM`, `PLC`, and `I/O`.
- Library references can be opened in a project-scoped API viewer backed by local `.tmc` data.
- Solution build is available through `MSBuild`.

## Near-Term Work

1. Tighten library viewer coverage and presentation.
2. Add more fixture-based save and parsing regressions.
3. Improve large-workspace scan/index performance.
4. Expand `.tsproj`-driven tree structure beyond top-level grouping.

## Later Work

1. Design a TwinCAT XAE-style runtime/configuration workflow before reintroducing activate/login/start actions.
2. Add richer source/TMC cross-navigation from library API items.
3. Add broader TwinCAT schema compatibility testing across versions.
