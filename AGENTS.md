# Repository Workflow

## Repository Guidance

- Read `README.md` and relevant repository documentation before making changes.
- Follow any component-specific requirements, validation commands, and versioning rules documented there.

## Git Workflow

- Start each change from an up-to-date `origin/main`.
- If `origin/main` advances after a pull request is opened, report the drift before final review or merge.
- Do not commit or push directly to `main`.
- Create a dedicated branch for each logical change.
- Keep unrelated changes in separate branches and pull requests.
- Preserve unrelated working-tree changes.
- Review the complete diff before committing or opening a pull request.
- Run relevant automated checks before opening a pull request.
- Re-run relevant automated checks after material changes or base updates and before merging.
- Manual validation is optional unless explicitly requested.
- Create a pull request only when requested or when the agreed workflow explicitly requires one.
- Before merging, confirm that the pull request is not a draft, is mergeable, has passed required checks, has no unresolved review conversations, and reports current validation results.
- Do not merge a pull request without explicit user approval.
- Use a merge commit unless another merge strategy is explicitly requested.
- Delete the source branch after merging only when requested.

## Commits

- Follow the style established by the recent commit history.
- Keep each commit focused on one logical change.
- Use a concise, imperative subject that describes the result.
- Include the motivation, significant implementation details, and validation results in the body when useful.
- Preserve the pull request's commit history; do not rebase, amend, squash, force-push, or otherwise rewrite its commits unless explicitly requested.
- Do not include credentials, personal paths, sensitive data, or identifying sample data.

## Pull Requests

- Use a concise title that describes the primary result.
- Include Summary and Validation sections in the description, and add Changes, Scope, Safety, Compatibility, or other sections when relevant.
- Report only checks that were actually performed.
- Keep the description and validation results current as the pull request changes.
- Clearly state any untested behavior, compatibility concern, or remaining risk.
- Exclude unrelated changes from the pull request.
- Do not include credentials, personal paths, sensitive data, or identifying sample data.

## Versioning

- Follow the versioning policy documented in `README.md` and relevant repository documentation.
- Change the version only when required by that policy.
- Apply a version change once per logical release change.
- Use the repository's canonical version source when one exists.
- Do not change the version for documentation-only changes unless explicitly required.

## Code Review

- Check for correctness, regressions, security issues, and unintended behavior changes.
- Verify that error handling and fallback behavior remain safe.
- Confirm that tests cover the changed behavior where practical.
- Treat missing validation and unresolved risks as review findings.
- Keep review feedback focused, actionable, and supported by the code or test results.
