# Security Policy

This is the canonical security policy for FlowFi. It defines how vulnerabilities are reported, which versions are supported, and the responsible disclosure process. For contributors and administrators setting up repository security features, see [SECURITY_IMPLEMENTATION_SUMMARY.md](SECURITY_IMPLEMENTATION_SUMMARY.md). For the GitHub setup checklist, see [.github/SECURITY_SETUP_CHECKLIST.md](.github/SECURITY_SETUP_CHECKLIST.md).

## Supported Versions

We actively support the following versions of FlowFi with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of FlowFi seriously. If you discover a security vulnerability, we appreciate your help in disclosing it to us in a responsible manner.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

The preferred and fastest way to report a vulnerability is **GitHub Security Advisories**:

1. Go to the [Security tab](https://github.com/LabsCrypt/flowfi/security) of this repository.
2. Click **"Report a vulnerability"** (or use the direct link: [Report a vulnerability](https://github.com/LabsCrypt/flowfi/security/advisories/new)).
3. Fill in the private advisory form with as much detail as possible (see "What to Include" below).

This opens a private channel between you and the maintainers — nothing is visible publicly until we agree on a disclosure timeline.

If you cannot use GitHub Security Advisories for any reason, you may instead reach out to the maintainers directly through the [community Telegram](https://t.me/+DOylgFv1jyJlNzM0) and request a private contact, or send a message via GitHub Discussions asking to be contacted privately (do not include vulnerability details in the public message).

### What to Include

Please include the following information in your report:

- **Description**: A clear description of the vulnerability
- **Impact**: The potential impact and severity of the issue
- **Reproduction**: Step-by-step instructions to reproduce the vulnerability
- **Environment**: Affected versions, operating systems, or configurations
- **Proof of Concept**: If applicable, include a minimal proof of concept
- **Suggested Fix**: If you have ideas for how to fix the issue

### Response Timeline

We are committed to responding to security reports promptly:

- **Initial Response**: Within 48 hours of receiving your report
- **Status Update**: Within 7 days with our assessment and planned timeline
- **Resolution**: We aim to resolve critical vulnerabilities within 30 days

These targets apply to every reporting channel — private GitHub Security Advisories and non-sensitive public reports filed with the [security issue template](.github/ISSUE_TEMPLATE/security.md), which restates the same timeline. If you update one, update the other so they do not drift.

If you have not heard from us within 48 hours, please reach out through our [community Telegram](https://t.me/+DOylgFv1jyJlNzM0).

### Disclosure Policy

- We follow responsible disclosure practices
- We will work with you to understand and resolve the issue before any public disclosure
- We will credit you in our security advisory (unless you prefer to remain anonymous)
- We ask that you do not publicly disclose the vulnerability until we have had a chance to address it

## Automated Security Scanning Pipeline

FlowFi runs a continuous security scanning pipeline defined in [`.github/workflows/security.yml`](.github/workflows/security.yml). Every pull request targeting `main` or `develop` must pass all four scans before it can be merged. The pipeline also runs automatically on a weekly schedule (Sundays at 02:00 UTC) to catch newly published CVEs in pinned dependencies.

### Scans at a Glance

| Job | Tool | What it checks | Blocks PR? |
|---|---|---|---|
| `dependency-check` | `npm audit` + `cargo audit` | High/critical CVEs in Node.js (frontend, backend) and Rust (contracts) dependencies | Yes |
| `secret-scan` | [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets, tokens, and API keys committed anywhere in git history | Yes |
| `sast` | [Semgrep](https://semgrep.dev) | Static code anti-patterns (OWASP Top-10, Node.js, React, TypeScript, Rust) | Yes |
| `codeql-analysis` | [GitHub CodeQL](https://codeql.github.com) | Deep semantic analysis of JavaScript/TypeScript and Rust code paths | Yes |

### SARIF Security Reports

Semgrep and CodeQL both produce [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) reports that are automatically uploaded to the **GitHub Security tab** (`Security → Code scanning alerts`). Each finding includes the file path, line number, rule description, and remediation guidance.

To view scan results:
1. Navigate to the repository on GitHub.
2. Click the **Security** tab.
3. Select **Code scanning** in the left sidebar.
4. Filter by tool (`CodeQL`, `Semgrep`) or severity.

### Interpreting Dependency Audit Failures

`npm audit` and `cargo audit` are configured to fail on **high** or **critical** severity advisories in production dependencies (`--omit=dev` / `--deny warnings`). If a scan fails:

1. Review the advisory output in the workflow logs.
2. Update the affected dependency to a patched version, or apply an `npm audit fix`.
3. If no patch is available, open a tracking issue with the `security` label and document the accepted risk in a `npm-audit-resolve` entry or Cargo `audit.toml` advisory ignore block.

### Interpreting Secret Scan Failures

If gitleaks flags a finding:

1. Treat the secret as **compromised** — revoke and rotate it immediately.
2. Remove the secret from git history using `git filter-repo` or BFG Repo Cleaner.
3. Force-push the cleaned history (requires admin approval).
4. Verify the secret no longer appears in history before re-opening the PR.

Do **not** simply delete the file in a new commit — the secret remains accessible in git history.

### Suppressing False Positives

**Semgrep** — add a `# nosemgrep: <rule-id>` comment on the flagged line and include a justification comment above it.

**gitleaks** — add a `gitleaks:allow` comment on the same line as the false-positive pattern, or add an entry to a `.gitleaks.toml` allowlist at the repository root.

**CodeQL** — dismiss the alert in the GitHub Security tab with a reason (e.g., "false positive", "risk accepted") and a comment.

All suppressions are reviewed during security audits. Never suppress a finding without understanding the underlying pattern.

### Weekly CVE Sweep

The weekly cron job (`0 2 * * 0`) re-runs all scans against the current `main` branch using the latest advisory databases. Failures create a workflow run that is visible in the **Actions** tab. Maintainers are notified via the standard GitHub Actions notification settings and should address any new findings within the response timeline defined above.

## Security Considerations

### Smart Contract Security

FlowFi uses Soroban smart contracts on the Stellar network. Key security considerations include:

- **Audit Status**: Our smart contracts are currently under development and have not been formally audited
- **Testing**: All contracts undergo extensive testing before deployment
- **Upgrades**: Contract upgrade mechanisms follow secure patterns

### Backend Security

Our backend API implements several security measures:

- **Rate Limiting**: API endpoints are protected against abuse
- **Input Validation**: All inputs are validated using Zod schemas
- **CORS**: Cross-origin requests are properly configured
- **Environment Variables**: Sensitive configuration is stored securely

### Frontend Security

The frontend application follows security best practices:

- **Content Security Policy**: Implemented to prevent XSS attacks
- **Secure Dependencies**: Regular dependency updates and vulnerability scanning
- **Wallet Integration**: Secure handling of wallet connections and transactions

## Security Best Practices for Users

When using FlowFi, please follow these security guidelines:

1. **Wallet Security**: Never share your private keys or seed phrases
2. **Transaction Verification**: Always verify transaction details before signing
3. **Network Security**: Use secure, trusted networks when accessing FlowFi
4. **Software Updates**: Keep your wallet software and browser up to date
5. **Phishing Protection**: Always verify you're on the official FlowFi domain

## Bug Bounty Program

Currently, FlowFi does not have a formal bug bounty program. However, we greatly appreciate security researchers who help improve our security posture and will acknowledge their contributions appropriately.

## Security Updates

Security updates and advisories will be published:

- In this repository's [Security Advisories](https://github.com/LabsCrypt/flowfi/security/advisories)
- In release notes for affected versions
- Through our official communication channels

## Contact

For security-related questions or concerns that are not vulnerabilities, you can:

- Open a public issue with the `security` label using the [security issue template](.github/ISSUE_TEMPLATE/security.md)
- Reach out to the maintainers through GitHub
- Join our community discussions

## Acknowledgments

We thank the security research community for helping keep FlowFi and our users safe. Contributors who responsibly disclose vulnerabilities will be acknowledged in our security advisories and release notes.

---

*This security policy is subject to change. Please check back regularly for updates.*