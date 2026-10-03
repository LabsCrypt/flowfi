# GitHub Security Setup Checklist

This checklist helps repository administrators ensure that GitHub's security features are properly configured for the FlowFi repository. For the canonical security policy (reporting guidelines, supported versions, response timelines), see [SECURITY.md](../SECURITY.md). For the implementation status and next steps, see [SECURITY_IMPLEMENTATION_SUMMARY.md](../SECURITY_IMPLEMENTATION_SUMMARY.md).

## Repository Security Settings

### Required Actions (Repository Admin)

- [ ] **Enable Private Vulnerability Reporting**
  - Go to Settings → Security & analysis
  - Enable "Private vulnerability reporting"
  - This allows security researchers to privately report vulnerabilities

- [ ] **Enable Dependency Graph**
  - Go to Settings → Security & analysis
  - Enable "Dependency graph"
  - This helps track project dependencies

- [ ] **Enable Dependabot Alerts**
  - Go to Settings → Security & analysis
  - Enable "Dependabot alerts"
  - This provides automatic vulnerability alerts for dependencies

- [ ] **Enable Dependabot Security Updates**
  - Go to Settings → Security & analysis
  - Enable "Dependabot security updates"
  - This automatically creates PRs to fix vulnerable dependencies

- [ ] **Enable Code Scanning (CodeQL)**
  - Go to Settings → Security & analysis
  - Enable "Code scanning"
  - The security.yml workflow should handle this automatically

- [ ] **Configure Branch Protection**
  - Go to Settings → Branches
  - Add protection rules for `main` branch
  - Require status checks to pass (including security checks)

### Optional but Recommended

- [ ] **Enable Secret Scanning**
  - Go to Settings → Security & analysis
  - Enable "Secret scanning"
  - This detects accidentally committed secrets

- [ ] **Set up Security Policy Link**
  - Verify that SECURITY.md appears in the repository's Security tab
  - GitHub should automatically detect and link to it

## Verification Steps

### 1. Check Security Tab
- [ ] Navigate to the repository's "Security" tab
- [ ] Verify that "Security policy" section shows a link to SECURITY.md
- [ ] Confirm that "Report a vulnerability" button is available

### 2. Test Private Reporting
- [ ] Click "Report a vulnerability" in the Security tab
- [ ] Verify that it opens the private advisory creation form
- [ ] Cancel without submitting (this is just a test)

### 3. Verify Workflows
- [ ] Check that `.github/workflows/security.yml` is running on PRs
- [ ] Confirm that security checks appear in PR status checks
- [ ] Review any security alerts in the Security tab

## Maintenance Tasks

### Weekly
- [ ] Review any new Dependabot alerts
- [ ] Check for new security advisories

### Monthly
- [ ] Review and update security policy if needed
- [ ] Audit repository access permissions
- [ ] Review security workflow results

### Before Major Releases
- [ ] Run comprehensive security audit
- [ ] Update supported versions in SECURITY.md
- [ ] Review and test incident response procedures

## Contact Information

Update the following when repository ownership or contact methods change:

- [ ] Security email in SECURITY.md
- [ ] Repository maintainer list
- [ ] Emergency contact procedures

## Notes

- This checklist should be reviewed whenever repository settings change
- New team members should be familiar with the security policy
- Consider setting up notifications for security alerts

---

*Last updated: [DATE] by [MAINTAINER]*