# TcView

TcView is a Visual Studio Code extension for viewing and editing TwinCAT XML artifacts as IEC 61131-3 Structured Text (ST).

## Features

- Open TwinCAT source files (`.TcPOU`, `.TcGVL`, `.TcDUT`, `.TcPRG`, `.TcAPP`, `.TcCOM`, `.TcVAR`, `.TcGDS`, `.TcIO`, `.TcITF`) directly in ST view.
- Navigate POU fragments (methods, properties, actions, transitions) from the explorer tree.
- Save ST edits back to source XML.
- IEC ST language support: diagnostics, completions, formatting, hovers, code actions.
- Performance and indexing telemetry commands for troubleshooting.

## Install

### From Source

1. Clone the repository.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` in VS Code to launch an Extension Development Host.

### Package for Distribution

1. Install VSCE: `npm install -g @vscode/vsce`
2. Build package: `vsce package`
3. Install generated `.vsix` in VS Code.

## Usage

1. Open a workspace containing TwinCAT XML files.
2. Use the `TcView` activity bar container and select a file.
3. Or right-click a supported file in Explorer and choose `Open in TcView`.
4. Edit ST and save to persist changes back into XML.

## Commands

- `twincat.refreshFiles`: Refresh the TcView file tree
- `twincat.openFile`: Open file or fragment in TcView
- `twincat.openFromExplorer`: Open selected file in TcView
- `twincat.saveToXml`: Save ST content back to XML
- `twincat.switchToXml`: Switch between virtual ST and source XML
- `twincat.validateSyntax`: Run ST diagnostics
- `twincat.showIndexStats`: Show symbol index stats
- `twincat.checkLspStatus`: Show language feature status
- `twincat.showPerfStats`: Show performance summary

## Development

- Compile: `npm run compile`
- Unit tests: `npm test`
- Integration tests: `npm run test:integration`

## Repository Docs

- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Production Readiness Notes](docs/production-readiness.md)

## License

MIT. See [LICENSE](LICENSE).
