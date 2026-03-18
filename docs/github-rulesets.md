# GitHub Rulesets

This repo now tracks the protected-branch baseline needed for GitFlow. GitHub still has to apply those payloads through the repository API or settings UI.

For the practical branch-protection policy and the GitHub UI checklist, see [Branch Protection](./branch-protection.md).

## Tracked Payloads

Protected branches:

- [main.json](../.github/rulesets/main.json)
- [develop.json](../.github/rulesets/develop.json)
- [release.json](../.github/rulesets/release.json)
- [hotfix.json](../.github/rulesets/hotfix.json)
- [support.json](../.github/rulesets/support.json)

Protected tags:

- [tags.json](../.github/rulesets/tags.json)

Repository merge/deletion settings:

- [repository.json](../.github/settings/repository.json)

Apply scripts:

- [apply-github-ruleset.js](../scripts/apply-github-ruleset.js)
- [apply-github-rulesets.js](../scripts/apply-github-rulesets.js)
- [apply-github-repo-settings.js](../scripts/apply-github-repo-settings.js)

## Protected Branch Policy

Rulesets are intended for:

- `main`
- `develop`
- `release/*`
- `hotfix/*`
- `support/*`
- `v*` release tags

Long-lived branches such as `main`, `develop`, and `support/*` should:

1. Block direct deletion
2. Block force pushes
3. Require pull requests
4. Require at least 1 approval
5. Require code owner review
6. Dismiss stale approvals on new commits
7. Require all review threads to be resolved
8. Require the GitFlow PR policy check
9. Require CI to pass before merge
10. Allow merge commits only

Release-management branches such as `release/*` and `hotfix/*` should:

1. Block direct deletion
2. Block force pushes
3. Require CI to pass
4. Remain practical for direct release stabilization work

Important:

- `required_linear_history` is intentionally not used because standard GitFlow depends on merge commits between long-lived branches.
- `release/*` and `hotfix/*` are protected from deletion and force-push, and they require CI to stay green.
- `release/*` and `hotfix/*` intentionally do not require PRs for every update because release stabilization still needs to be practical.
- if you want to limit who can create `release/*` or `hotfix/*`, add actor-based creation restrictions in GitHub after the release-manager team or users are known.
- release tags are protected from deletion and retargeting after publication.
- long-lived branches such as `develop` should not be used as disposable PR head branches for releases

## Required Status Checks

Current required checks:

- `Build, Test, Package`
- `Validate GitFlow PR policy`

Supporting workflow files:

- [windows-ci.yml](../.github/workflows/windows-ci.yml)
- [gitflow-pr-policy.yml](../.github/workflows/gitflow-pr-policy.yml)
- [release-on-main.yml](../.github/workflows/release-on-main.yml)

Supporting governance files:

- [CODEOWNERS](../.github/CODEOWNERS)
- [PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)
- [config.yml](../.github/ISSUE_TEMPLATE/config.yml)

## Repository Settings

Tracked repository settings align GitHub merge behavior with GitFlow:

- allow merge commits
- disable squash merge
- disable rebase merge
- do not delete merged branches automatically
- allow GitHub's update-branch action for stale PRs

## Run It

Dry run:

- PowerShell:
  - `$env:GITHUB_TOKEN='<token-with-repo-admin>'; npm run github:repo-settings`
  - `$env:GITHUB_TOKEN='<token-with-repo-admin>'; npm run github:rulesets`

Apply:

- PowerShell:
  - `$env:GITHUB_TOKEN='<token-with-repo-admin>'; npm run github:repo-settings:apply`
  - `$env:GITHUB_TOKEN='<token-with-repo-admin>'; npm run github:rulesets:apply`

Manual overrides:

- `node scripts/apply-github-repo-settings.js --owner CodePiercerTechnology --repo TcView --apply`
- `node scripts/apply-github-rulesets.js --owner CodePiercerTechnology --repo TcView --apply`

Requirements:

- token must have repository `Administration: write`
- ruleset scripts call `https://api.github.com/repos/{owner}/{repo}/rulesets`
- repository settings script calls `https://api.github.com/repos/{owner}/{repo}`
