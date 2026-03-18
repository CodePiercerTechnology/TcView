# Branch Protection

This repo uses a GitFlow-style model with two long-lived branches:

- `main`: release history only
- `develop`: integration branch for the next release

To keep those branches safe, GitHub branch protection and repository merge settings should be configured so:

- long-lived branches are never deleted automatically
- release work goes through `release/<version>` branches
- `main` only receives release or hotfix pull requests
- `develop` only receives feature work and post-release sync merges from `main`

## Recommended Repository Settings

Apply these repository-wide settings in GitHub `Settings` -> `General`:

- Allow merge commits: `on`
- Allow squash merge: `off`
- Allow rebase merge: `off`
- Always suggest updating pull request branches: `on`
- Automatically delete head branches: `off`

Why `Automatically delete head branches` should be off:

- `develop` is a long-lived branch and should not be treated as disposable
- GitHub will delete the PR head branch after merge if this is enabled
- If a release is opened directly from `develop` into `main`, GitHub can delete `develop`

If you prefer automatic deletion for temporary branches, keep this off globally and delete `feature/*` or `release/*` branches intentionally after merge.

## Protected Branches

Protect these branches:

- `main`
- `develop`
- `release/*`
- `hotfix/*`

Optional protected maintenance branches:

- `support/*`

Normal working branches such as `feature/*`, `docs/*`, and `perf/*` do not need the same protections as long-lived or release-management branches.

## `main` Protection

Recommended settings for `main` in GitHub `Settings` -> `Rules` -> `Rulesets`:

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

Recommended required checks:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

`main` should receive:

- `release/<version>` -> `main`
- `hotfix/*` -> `main`

Do not use `develop` -> `main` as the normal release PR path.

## `develop` Protection

Recommended settings for `develop`:

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

Recommended required checks:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

`develop` should receive:

- `feature/*` -> `develop`
- `bugfix/*` -> `develop`
- `docs/*` -> `develop`
- `perf/*` -> `develop`
- `main` -> `develop` after each release or hotfix lands

## `release/*` Protection

`release/*` branches should be protected fairly strictly, but still remain practical for release stabilization work.

Recommended settings for `release/*`:

- Block deletions
- Block force pushes
- Require status checks to pass
- Keep merge-commit-based GitFlow enabled
- Do not require pull requests for every update to the release branch itself

Why PRs are not required for every `release/*` update:

- release branches are often stabilized with a small number of direct versioning or release-candidate fixes
- requiring a pull request for every update to the release branch adds friction without much additional safety
- the actual promotion into `main` still happens through a PR

Recommended required checks:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

Creation restriction note:

- if you want only release managers to create `release/*` branches, configure actor-based creation restrictions in GitHub
- that requires repository-specific team or user IDs, so it is documented rather than hard-coded in the tracked JSON

Recommended operational rule:

- only maintainers or release managers should create and push `release/*`
- everyone else should contribute fixes through PRs targeting the release branch if needed

## `hotfix/*` Protection

`hotfix/*` branches should follow the same model as `release/*`:

- block deletions
- block force pushes
- require CI to stay green
- allow practical stabilization work before promotion into `main`

Recommended required checks:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

Creation restriction note:

- if only a small maintainer group should create `hotfix/*`, set actor-based creation restrictions in GitHub once the maintainer team is defined

## Correct Release Flow

Use this sequence for normal releases:

1. Branch `release/<version>` from `develop`
2. Stabilize the release on `release/<version>`
3. Open PR `release/<version>` -> `main`
4. Merge the release PR into `main`
5. Tag `v<version>` and publish the release
6. Merge `main` back into `develop`
7. Delete the temporary `release/<version>` branch

This keeps `develop` alive and avoids accidental branch deletion.

## GitHub UI Checklist

Use this checklist when configuring the repo in GitHub:

1. Open `Settings` -> `General`
2. Set:
   - `Allow merge commits` -> on
   - `Allow squash merge` -> off
   - `Allow rebase merge` -> off
   - `Automatically delete head branches` -> off
3. Open `Settings` -> `Rules` -> `Rulesets`
4. Ensure a ruleset exists for `main`
5. Ensure a ruleset exists for `develop`
6. Ensure a ruleset exists for `release/*`
7. Ensure a ruleset exists for `hotfix/*`
8. For `main` and `develop`, confirm:
   - deletion blocked
   - non-fast-forward pushes blocked
   - pull requests required
   - 1 approval required
   - stale approvals dismissed
   - code owner review required
   - review thread resolution required
   - required status checks configured
9. For `release/*` and `hotfix/*`, confirm:
   - deletion blocked
   - non-fast-forward pushes blocked
   - required status checks configured
   - pull requests are still required when promoting into `main`
10. Confirm required checks include:
   - `Build, Test, Package`
   - `Validate GitFlow PR policy`
11. If desired, add actor-based creation restrictions for `release/*` and `hotfix/*`
12. Verify `develop` is not used as a disposable release branch
13. Verify the next release will use `release/<version>` -> `main`

## Tracked Repo Automation

This repo already tracks the intended GitHub settings in source:

- [repository.json](../.github/settings/repository.json)
- [main.json](../.github/rulesets/main.json)
- [develop.json](../.github/rulesets/develop.json)
- [release.json](../.github/rulesets/release.json)
- [hotfix.json](../.github/rulesets/hotfix.json)
- [support.json](../.github/rulesets/support.json)
- [tags.json](../.github/rulesets/tags.json)

Supporting docs:

- [GitHub Rulesets](./github-rulesets.md)
- [GitFlow](./gitflow.md)
