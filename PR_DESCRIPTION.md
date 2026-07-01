## Description
This PR resolves four CI/CD and infrastructure issues:
1. **Issue #897 [CI] Frontend tests run without coverage and are never uploaded to Codecov**: Added frontend test coverage to CI workflow and configured Codecov to track frontend coverage.
2. **Issue #894 [Infra] No .dockerignore for the backend build context**: Created `.dockerignore` for backend to exclude unnecessary files from Docker build context.
3. **Issue #892 [CI] Workflows have no concurrency control**: Added concurrency control to `ci.yml` and `security.yml` workflows to cancel superseded runs.
4. **Issue #891 [CI] pr-test-gate.yml fully duplicates ci.yml's backend and contracts jobs**: Removed `pr-test-gate.yml` as it duplicates tests already covered by `ci.yml`.

## Type of Change
<!-- Mark the relevant option with an 'x' -->

- [x] 🔧 Infrastructure/CI improvements
- [x] 🐛 Bug fix (non-breaking change which fixes an issue)
- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] 📚 Documentation update
- [ ] ⚡ Performance improvement
- [ ] 🧪 Test addition or update

## Related Issues
<!-- Link related issues using keywords like "Closes", "Fixes", "Resolves" -->
<!-- Example: Closes #123, Fixes #456 -->

Closes #897
Closes #894
Closes #892
Closes #891

## Changes Made
- **Frontend Test Coverage (#897)**:
  - Updated `.github/workflows/ci.yml` to run `npm run test:coverage` instead of `npm test` for frontend
  - Added frontend coverage upload step to Codecov with `frontend` flag
  - Updated `.github/codecov.yml` to include frontend project status with `target: auto`
- **Docker Build Optimization (#894)**:
  - Created `backend/.dockerignore` to exclude: `node_modules`, `dist`, `coverage`, `.env*`, `*.log`, `src/generated`
  - This reduces Docker build context size and prevents secrets from being sent to build cache
- **Concurrency Control (#892)**:
  - Added `concurrency` block to `.github/workflows/ci.yml` with `cancel-in-progress: true`
  - Added `concurrency` block to `.github/workflows/security.yml` with `cancel-in-progress: true`
  - Both workflows use group: `${{ github.workflow }}-${{ github.ref }}`
- **Remove Duplicate Workflow (#891)**:
  - Deleted `.github/workflows/pr-test-gate.yml` as it duplicated backend and contracts tests already in `ci.yml`
  - This eliminates duplicate Postgres services and redundant test runs on PRs to main

## Testing
<!-- Describe the tests you ran and how to verify your changes -->

### Test Coverage
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [x] Manual testing performed

### Test Steps
<!-- If applicable, provide steps to test the changes -->
1. Verify frontend tests run with coverage in CI by checking workflow logs
2. Verify frontend coverage appears in Codecov dashboard
3. Verify Docker build context size is reduced by checking build logs
4. Verify concurrent workflow runs cancel previous runs by pushing multiple commits to same branch
5. Verify PRs to main no longer launch duplicate Postgres services

## Breaking Changes
<!-- If this PR includes breaking changes, describe them here -->
<!-- If none, you can remove this section -->

None. Branch protection rules should be updated to point to `ci.yml` jobs instead of `pr-test-gate.yml` if they were previously configured.

## Screenshots/Demo
<!-- If applicable, add screenshots or a link to a demo -->

## Checklist
<!-- Mark completed items with an 'x' -->

- [x] My code follows the project's style guidelines
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [x] Any dependent changes have been merged and published
- [x] I have checked for breaking changes and documented them if applicable

## Additional Notes
<!-- Any additional information that reviewers should know -->
- Branch protection rules may need to be updated to reference `ci.yml` jobs instead of the removed `pr-test-gate.yml` workflow
- Frontend coverage threshold is set to `auto` in Codecov to allow establishing a baseline before setting specific targets
