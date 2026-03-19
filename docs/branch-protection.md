# Branch Protection

This repository uses a GitFlow-style model with two long-lived branches:

- `main`: release history only
- `develop`: integration branch for the next release

The tracked branch governance is built around these expectations:

- long-lived branches are never deleted automatically
- release work goes through `release/<version>` branches
- `main` only receives release or hotfix pull requests
- `develop` only receives feature work and post-release sync merges from `main`

## Repository Settings

The repository-level merge settings tracked in source are:

- Allow merge commits: `on`
- Allow squash merge: `off`
- Allow rebase merge: `off`
- Always suggest updating pull request branches: `on`
- Automatically delete head branches: `off`

`Automatically delete head branches` remains off because:

- `develop` is a long-lived branch and should not be treated as disposable
- GitHub will delete the PR head branch after merge if this is enabled
- If a release is opened directly from `develop` into `main`, GitHub can delete `develop`

## Protected Branches

The tracked governance covers:

- `main`
- `develop`
- `release/*`
- `hotfix/*`

Optional protected maintenance branches:

- `support/*`

Normal working branches such as `feature/*`, `docs/*`, and `perf/*` do not need the same protections as long-lived or release-management branches.

## `main` Rules

The `main` branch policy requires:

- Require a pull request before merging
- Require approvals: `1`
- Dismiss stale approvals when new commits are pushed
- Require code owner review
- Require conversation resolution before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Block force pushes
- Block deletions
- Allow merge commits only

The tracked required checks are:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

In this model, `main` receives:

- `release/<version>` -> `main`
- `hotfix/*` -> `main`

Release promotion is modeled through `release/<version>` -> `main` rather than `develop` -> `main`.

## `develop` Rules

The `develop` branch policy requires:

- Require a pull request before merging
- Require approvals: `0`
- Dismiss stale approvals when new commits are pushed
- Require conversation resolution before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Block force pushes
- Block deletions
- Allow merge commits only

The tracked required checks are:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

This keeps `develop` practical for a solo-maintainer or small-team workflow while preserving PR history, CI gating, and branch safety.

In this model, `develop` receives:

- `feature/*` -> `develop`
- `bugfix/*` -> `develop`
- `docs/*` -> `develop`
- `perf/*` -> `develop`
- `main` -> `develop` after each release or hotfix lands

## `release/*` Rules

`release/*` branches are treated as strict release-management branches while still allowing practical stabilization work.

The tracked policy for `release/*`:

- Block deletions
- Block force pushes
- Require status checks to pass
- Keep merge-commit-based GitFlow enabled
- Do not require pull requests for every update to the release branch itself

Pull requests are not required for every `release/*` update because:

- release branches are often stabilized with a small number of direct versioning or release-candidate fixes
- requiring a pull request for every update to the release branch adds friction without much additional safety
- the actual promotion into `main` still happens through a PR

The tracked required checks are:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

Creation restrictions for `release/*` are intentionally left to GitHub actor configuration rather than being hard-coded in the tracked JSON:

- if you want only release managers to create `release/*` branches, configure actor-based creation restrictions in GitHub
- that requires repository-specific team or user IDs, so it is documented rather than hard-coded in the tracked JSON

## `hotfix/*` Rules

`hotfix/*` follows the same general model as `release/*`:

- block deletions
- block force pushes
- require CI to stay green
- allow practical stabilization work before promotion into `main`

The tracked required checks are:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

Creation restrictions for `hotfix/*` are likewise left to GitHub actor configuration:

- if only a small maintainer group should create `hotfix/*`, set actor-based creation restrictions in GitHub once the maintainer team is defined

## Release Flow

Normal releases follow this sequence:

1. Branch `release/<version>` from `develop`
2. Stabilize the release on `release/<version>`
3. Open PR `release/<version>` -> `main`
4. Merge the release PR into `main`
5. Tag `v<version>` and publish the release
6. Merge `main` back into `develop`
7. Delete the temporary `release/<version>` branch

This keeps `develop` alive and avoids accidental branch deletion.

## Tracked Repo Automation

This repo already tracks the intended GitHub settings in source:

- [repository.json](../.github/settings/repository.json)
- [main.json](../.github/rulesets/main.json)
- [develop.json](../.github/rulesets/develop.json)
- [release.json](../.github/rulesets/release.json)
- [hotfix.json](../.github/rulesets/hotfix.json)
- [support.json](../.github/rulesets/support.json)
- [tags.json](../.github/rulesets/tags.json)
