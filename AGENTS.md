# Repository Workflow

## Git Workflow

- Start each change from an up-to-date `origin/main`.
- Do not commit or push directly to `main`.
- Create a dedicated branch for each logical change.
- Keep unrelated changes in separate branches and pull requests.
- Preserve unrelated working-tree changes.
- Review the complete diff before committing or opening a pull request.
- Run relevant automated and manual checks before opening a pull request.
- Create a pull request only when requested or when the agreed workflow explicitly requires one.
- Review the pull request, validation results, and unresolved comments before merging.
- Do not merge a pull request without explicit user approval.
- Prefer squash merging unless another merge strategy is explicitly requested.
- Delete the source branch after merging only when requested.

## Commits

- Follow the style established by the recent commit history.
- Keep each commit focused on one logical change.
- Use a concise, imperative subject that describes the result.
- Include the motivation, significant implementation details, and validation results in the body when useful.
- Amend or squash temporary and work-in-progress commits before merging.
- Do not include credentials, personal paths, sensitive data, or identifying sample data.

## Pull Requests

- Use a concise title that describes the primary result.
- Include Summary, Changes, and Validation sections in the description.
- Report only checks that were actually performed.
- Clearly state any untested behavior, compatibility concern, or remaining risk.
- Exclude unrelated changes from the pull request.
- Do not include credentials, personal paths, sensitive data, or identifying sample data.

## Versioning

- Change the version only when required by the repository's release policy.
- Apply a version change once per logical release change.
- Use the repository's canonical version source when one exists.
- Do not change the version for documentation-only changes unless explicitly required.

## Code Review

- Check for correctness, regressions, security issues, and unintended behavior changes.
- Verify that error handling and fallback behavior remain safe.
- Confirm that tests cover the changed behavior where practical.
- Treat missing validation and unresolved risks as review findings.
- Keep review feedback focused, actionable, and supported by the code or test results.
