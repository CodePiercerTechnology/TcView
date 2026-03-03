# TcView Development

## Main Build Commands

- Compile: `npm run compile`
- Unit/regression tests: `npm test`
- Integration tests: `npm run test:integration`
- Package VSIX: `npx @vscode/vsce package`

## Extension Development Host

Typical workflow:

1. `npm install`
2. `npm run compile`
3. Press `F5` in VS Code

The development host is the fastest way to test:

- virtual ST editing
- tree view behavior
- diagnostics and semantic tokens
- library viewer behavior

## Backend Development

The backend project lives in:

- [backend/TcView.Backend](c:/Users/TwinCAT/Documents/MyStuff/TcView/backend/TcView.Backend)

Supporting solution:

- [TcView.sln](c:/Users/TwinCAT/Documents/MyStuff/TcView/TcView.sln)

Use this when working on TwinCAT Automation Interface features such as:

- install library project
- add library reference
- remove library reference

Current reality:

- the repo contains backend source
- the packaged VSIX does not currently ship the backend executable
- backend commands require a local backend build and `twincat.backend.executablePath`

## Packaging

The extension now uses a `files` whitelist in [package.json](c:/Users/TwinCAT/Documents/MyStuff/TcView/package.json) to keep the VSIX focused on runtime assets.

That means the shipped package contains:

- compiled extension output
- runtime resources
- syntax files
- top-level package metadata/docs needed by VS Code

and does not need to rely on a large ignore-only package layout.

## Documentation Layout

- [README.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/README.md): user-facing overview and install/use guidance
- [architecture.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/architecture.md): implementation structure and boundaries
- [library-metadata.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/library-metadata.md): metadata model and library recognition
- [production-readiness.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/production-readiness.md): release gates and remaining risk areas
- [roadmap.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/docs/roadmap.md): roadmap and planned work

## Cleanup Notes

Current audit result:

- no obvious source files are safe to delete right now without removing active runtime or optional backend behavior
- the backend source still has value because library Automation Interface commands depend on it during development
- the main cleanup gain at this stage is clearer packaging and clearer documentation, not aggressive source deletion
