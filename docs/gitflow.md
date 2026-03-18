# GitFlow

TcView tracks a GitFlow-style branch model in source so the branch lifecycle is visible and repeatable.

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

## Helper Commands

The repository includes helper commands for creating branches from the intended base:

- `npm run gitflow -- bootstrap`
- `npm run gitflow -- bootstrap --push`
- `npm run gitflow -- start feature webview-perf`
- `npm run gitflow -- start release 1.0.0-alpha.3`
- `npm run gitflow -- start hotfix 1.0.1`

Helper script:

- [gitflow.js](../scripts/gitflow.js)

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

- [gitflow-pr-policy.yml](../.github/workflows/gitflow-pr-policy.yml)

In this model:

- `release/<version>` is the normal release PR source branch into `main`
- `main` is synchronized back into `develop` after each release
- this keeps `develop` from being treated like a disposable release branch
- `release/*` and `hotfix/*` are maintainer-managed branches rather than general-purpose shared working branches

## Release Flow

1. Branch `release/<version>` from `develop`
2. Bump `package.json` version and update [CHANGELOG.md](../CHANGELOG.md)
3. Merge `release/<version>` into `main`
4. GitHub creates tag `v<version>` if it does not already exist
5. GitHub builds the VSIX and publishes a GitHub Release for that tag
6. GitHub opens or reuses a `main` -> `develop` sync PR

Workflow:

- [release-on-main.yml](../.github/workflows/release-on-main.yml)

Protection note:

- tracked rulesets now apply stricter protection to `release/*` and `hotfix/*`
- they block deletion and force-push and require CI
- they intentionally do not require PRs for every stabilization commit on those branches

## Maintenance Branches

The current remote branch names `v1.0` and `v2.0` do not match GitFlow naming.

If those are meant to stay as maintained release lines, the GitFlow naming form is:

- `support/1.0`
- `support/2.0`

Temporary branches outside that naming scheme can be retired once the branch model is fully in use.
