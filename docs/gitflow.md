# GitFlow

TcView now tracks a standard GitFlow-style branch model in source so the branch lifecycle is repeatable instead of living only in repo settings or tribal knowledge.

## Branch Model

- `main`: production/release history only
- `develop`: integration branch for the next release
- `feature/*`: normal feature or bugfix work, branched from `develop`, merged back into `develop`
- `release/*`: release stabilization branches, branched from `develop`, merged into `main`
- `hotfix/*`: urgent production fixes, branched from `main`, merged into `main`
- `support/*`: optional long-lived maintenance lines for older trains

Tag format:

- `v<package.json version>`
- examples: `v1.0.0`, `v1.0.0-alpha.3`

## Local Helper Commands

Bootstrap `develop` from `main`:

- `npm run gitflow -- bootstrap`
- `npm run gitflow -- bootstrap --push`

Create working branches from the correct base:

- `npm run gitflow -- start feature webview-perf`
- `npm run gitflow -- start release 1.0.0-alpha.3`
- `npm run gitflow -- start hotfix 1.0.1`

Helper script:

- [gitflow.js](c:/Users/TwinCAT/Documents/MyStuff/TcView/scripts/gitflow.js)

Notes:

- the helper requires a clean worktree before it changes branches
- `--push` creates the remote branch and sets upstream tracking
- release and hotfix completion still happens through pull requests so GitHub protections and CI stay in the loop

## Pull Request Targets

- `feature/*`, `bugfix/*`, `chore/*`, `docs/*`, `refactor/*`, `test/*`, `perf/*` -> `develop`
- `release/*` -> `main`
- `hotfix/*` -> `main`
- `main` -> `develop` after each release or hotfix lands
- `hotfix/*` -> `support/*` when an older maintenance line needs the same fix

GitHub validates these pairings in:

- [gitflow-pr-policy.yml](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/workflows/gitflow-pr-policy.yml)

## Release Flow

1. Branch `release/<version>` from `develop`
2. Bump `package.json` version and update [CHANGELOG.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/CHANGELOG.md)
3. Merge `release/<version>` into `main`
4. GitHub creates tag `v<version>` if it does not already exist
5. GitHub builds the VSIX and publishes a GitHub Release for that tag
6. GitHub opens or reuses a `main` -> `develop` sync PR

Workflow:

- [release-on-main.yml](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/workflows/release-on-main.yml)

## Maintenance Branches

The current remote branch names `v1.0` and `v2.0` do not match GitFlow naming.

If those are meant to stay as maintained release lines, rename them to:

- `support/1.0`
- `support/2.0`

If they were temporary branches, remove them after the new flow is in place.

## One-Time Migration

1. Create and push `develop` from `main`:
   - `npm run gitflow -- bootstrap --push`
2. Apply GitHub repository settings:
   - `npm run github:repo-settings`
   - `npm run github:repo-settings:apply`
3. Apply tracked rulesets:
   - `npm run github:rulesets`
   - `npm run github:rulesets:apply`
4. Rename or retire non-standard maintenance branches such as `v1.0` and `v2.0`

The apply commands require `GITHUB_TOKEN` with repository `Administration: write`.
