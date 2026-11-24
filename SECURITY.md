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

This opens a private channel between you and the maintainers — nothing is visible publicly until we agree on a disclosure timeline. If that button is missing from the page, private vulnerability reporting has not been switched on for this repository yet (it is still an unchecked box in [.github/SECURITY_SETUP_CHECKLIST.md](.github/SECURITY_SETUP_CHECKLIST.md)); use the fallback below until it is.

If you cannot use GitHub Security Advisories for any reason, open a **non-sensitive** [GitHub issue](https://github.com/LabsCrypt/flowfi/issues/new) titled `[security] private report channel requested` asking the maintainers for a private contact channel. Do not include vulnerability details, and never post them in public issues or chat groups (including Telegram). GitHub Discussions are disabled on this repository, so a discussion is not a fallback here.

Conduct and community reports take a different path: see the Enforcement section of [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#enforcement). Keep vulnerability details out of the Telegram group, and keep conduct reports out of the advisory form.

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

These targets apply to private GitHub Security Advisories, the single intake path for vulnerability reports. The [security hardening question template](.github/ISSUE_TEMPLATE/security.md) is for non-sensitive questions only and is not a vulnerability intake.

If you have not heard from us within 48 hours, add a comment on your private advisory. Do not escalate through public channels.

### Disclosure Policy

- We follow responsible disclosure practices
- We will work with you to understand and resolve the issue before any public disclosure
- We will credit you in our security advisory (unless you prefer to remain anonymous)
- We ask that you do not publicly disclose the vulnerability until we have had a chance to address it

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

## Automated Static Security Analysis & Vulnerability Scanning Pipeline

To protect financial payment infrastructure and detect supply chain vulnerabilities, secret leaks, and static code issues early, FlowFi runs an automated continuous security pipeline on all pull requests and on a weekly recurring schedule:

1. **Supply Chain & Dependency Audits**:
   - **Rust Smart Contracts**: Automated `cargo audit` scanning Soroban contracts for known dependency vulnerabilities.
   - **Node.js Workspaces**: Automated `npm audit --audit-level=high` auditing dependencies across root, frontend, and backend packages.
2. **Secret Leak Detection**:
   - Automated `Gitleaks` scanning the complete commit history on all pull requests to block accidental commits of API keys, private credentials, or secrets.
3. **Static Application Security Testing (SAST)**:
   - **Semgrep SAST**: Automated pattern scanning across TypeScript, React, and Rust code to detect insecure idioms, improper state mutations, and common web/smart contract anti-patterns.
   - **SARIF Security Reporting**: Automated SARIF file generation uploaded directly to the repository's GitHub Security tab.
   - **GitHub CodeQL Analysis**: In-depth semantic code analysis across JavaScript, TypeScript, and Rust.
4. **Automated Weekly Recurring Scans**:
   - Scheduled weekly audit runs (`cron: '0 0 * * 0'`) to detect newly disclosed CVEs against existing stable dependencies.

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