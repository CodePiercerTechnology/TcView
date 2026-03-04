# Contributing to TcView

## Development Setup

1. Install Node.js 20+
2. Run `npm install`
3. Run `npm run compile`
4. Run `npm test`
5. Run `npm run test:integration`
6. Press `F5` in VS Code to launch an Extension Development Host

## Before Opening a PR

- keep the change focused
- add or update tests when behavior changes
- update docs when commands, settings, or user-visible behavior changes
- make sure these pass:
  - `npm run compile`
  - `npm test`
  - `npm run test:integration` (or note why it could not run in your environment)

## Backend Work

If your change touches TwinCAT Automation Interface commands, also validate the backend project:

- [backend/TcView.Backend](c:/Users/TwinCAT/Documents/MyStuff/TcView/backend/TcView.Backend)

Current note:

- backend features are optional
- the VSIX does not currently ship a backend executable
- do not document backend-powered commands as turnkey unless packaging changes too

## Scope Discipline

TcView is intentionally a supplemental TwinCAT tool, not a full XAE replacement.

When proposing changes:

- prefer code editing, navigation, library recognition, and lightweight build workflows
- avoid expanding casually into runtime/configuration/device-engineering scope

If a change moves toward XAE-style workflows, document the scope tradeoff explicitly.
