# Contributing to TcView

Thanks for contributing.

TcView is a code-first companion to TwinCAT XAE, so the most helpful changes usually improve editing, navigation, diagnostics, metadata recognition, and lightweight build workflows inside VS Code.

## Getting Started

1. Install Node.js 20+
2. Run `npm install`
3. Run `npm run compile`
4. Run `npm test`
5. Run `npm run test:integration`
6. Press `F5` in VS Code to launch an Extension Development Host

## Pull Requests

- Keep each change focused and reviewable
- Target `develop` for normal feature and fix work
- Use `release/*` and `hotfix/*` only for release-management flows
- Add or update tests when behavior changes
- Update user-facing docs when commands, settings, or visible behavior change

Before opening a PR, the expected checks are:

- `npm run compile`
- `npm test`
- `npm run test:integration`

If an integration run is not practical in your environment, note that clearly in the PR.

## Backend Changes

Changes that touch TwinCAT Automation Interface behavior should also validate the backend project:

- [backend/TcView.Backend](../backend/TcView.Backend)

Useful context:

- backend-powered features are optional
- the VSIX ships the release backend for Windows builds
- `twincat.backend.executablePath` is mainly for override and test scenarios

## Scope

TcView intentionally stays focused on code-centric TwinCAT workflows.

Changes are most likely to fit well when they improve:

- ST editing and save-back
- project browsing and navigation
- diagnostics and semantic understanding
- metadata-backed library inspection
- lightweight build workflows

Changes that move toward full XAE-style runtime, configuration, or device-engineering workflows should explain that tradeoff clearly.
