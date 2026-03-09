# GitHub Ruleset Baseline

This repo cannot enforce GitHub branch rulesets from tracked source files alone. Apply the following ruleset in the GitHub repository settings for `main`.

## Target

- branch pattern: `main`
- enforcement: active

## Recommended Standard Rules

1. Restrict direct pushes to `main`
2. Require a pull request before merge
3. Require at least 1 approval
4. Dismiss stale approvals when new commits are pushed
5. Require all conversations to be resolved before merge
6. Require status checks to pass before merge
7. Require linear history
8. Block force pushes
9. Block branch deletion

## Required Status Checks

At minimum, require:

- `Build, Test, Package`

If CI is later split into multiple jobs, require the specific job names that cover:

- compile
- non-UI tests
- integration smoke tests
- performance guardrails
- VSIX packaging validation
- bundled backend packaging validation

## Supporting In-Repo Files

These repo files are intended to work with the ruleset above:

- [CODEOWNERS](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/CODEOWNERS)
- [PULL_REQUEST_TEMPLATE.md](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/PULL_REQUEST_TEMPLATE.md)
- [config.yml](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/ISSUE_TEMPLATE/config.yml)
- [windows-ci.yml](c:/Users/TwinCAT/Documents/MyStuff/TcView/.github/workflows/windows-ci.yml)

## Notes

- `CODEOWNERS` only takes effect when GitHub branch protection or rulesets require code owner review.
- If you later add release branches, clone this ruleset for `release/*` and keep the same required checks.
- Signed-commit enforcement is reasonable, but keep it optional until contributor workflow is stable.
