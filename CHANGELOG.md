# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

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
- Tightened VSIX contents with a runtime-focused `files` whitelist

## [0.0.1] - 2026-02-27

### Added
- Initial extension implementation and language tooling.
