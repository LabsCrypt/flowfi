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

### Supply Chain Security

Dependency and secret scanning run automatically in CI — see
[Automated Security Scanning](#automated-security-scanning) for what each check
covers and what blocks a merge. [Dependabot](../.github/dependabot.yml) is
configured for both npm and Cargo and should be preferred over manual upgrades,
so that security bumps follow the same review path as any other change.

## Automated Security Scanning

Every pull request and every push to `main`/`develop` runs the
[Security Checks workflow](.github/workflows/security.yml). A weekly cron job
(Mondays 03:17 UTC) re-runs the same pipeline so that CVEs **published after**
the last dependency bump are caught even when no code has changed.

All scan results are published as SARIF to the repository's
[Security tab](https://github.com/LabsCrypt/flowfi/security/code-scanning).

| Check | Tool | Scope | Blocks a merge? |
| --- | --- | --- | --- |
| Dependency CVEs (Node.js) | `npm audit` | Root + `frontend` + `backend` workspaces | Yes, on high/critical |
| Dependency CVEs (Rust) | `cargo audit` | `contracts/` (Soroban SDK + deps) | Yes, on any advisory |
| Secret scanning | TruffleHog | Full git history, all branches | Yes, on **verified** secrets |
| Static analysis (SAST) | Semgrep + CodeQL | `backend`, `frontend`, `contracts` | Yes, for FlowFi-curated rules |
| Security setup config | `npm run verify-security` | Repository security policy files | Yes, if the policy is missing |

### How blocking works

A single **`Security Gate`** job aggregates the results, and it is the status
check to require in branch protection. Requiring the aggregate rather than the
individual jobs means a contributor sees one failure, and it cannot be bypassed
by re-running a single job.

Each individual check also writes a table to the pull request's
[job summary](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands#adding-a-job-summary),
so you can triage without digging through raw logs.

### What blocks, and what does not

Blocking is deliberately limited to high-confidence signals, because a security
gate that cries wolf gets ignored:

- **npm audit** blocks on high and critical advisories in **production**
  dependencies. Dev-dependency advisories are reported but do not block — a
  tooling CVE in a pinned dev tree should not stop a payments hotfix.
- **cargo audit** has no severity model, so any RustSec advisory blocks.
- **TruffleHog** blocks only on secrets it could **verify are live** by
  contacting the issuing provider. Unverified candidates (test fixtures,
  documentation examples) are not reported and do not block a merge.
- **Semgrep** blocks only on `error`-level findings from the curated
  [`.semgrep/flowfi.yml`](.semgrep/flowfi.yml) ruleset. Findings from the
  upstream `p/default` ruleset are uploaded to the Security tab for triage but
  do not block merges, since an unaudited broad ruleset would otherwise fail
  every pull request on day one.

### The curated Semgrep ruleset

`.semgrep/flowfi.yml` holds rules written for this codebase rather than
generically:

- **Credential exposure** — Stellar secret seeds (`S` + 56 base32 characters,
  the key that can sign transactions), private key material, and recognisable
  provider tokens (GitHub, AWS, Slack, npm, Stripe).
- **Injection** — Prisma `$queryRawUnsafe`/`$executeRawUnsafe` called with an
  interpolated string, `child_process` shell execution with a non-literal
  command, `eval`, and JWT verification with the `none` algorithm.
- **XSS** — React `dangerouslySetInnerHTML`.
- **Soroban contracts** — `unsafe` blocks, and `unwrap()`/`expect()` in
  contract code (warning severity; tracked in the Security tab).

The rules distinguish reviewed patterns from unsafe ones. For example, the raw
SQL calls in `stream.controller.ts` and `withdraw.ts` use a static query with
`$1`/`$2`/`$3` placeholders and are **not** flagged; only a `${...}`
interpolation into an unsafe Prisma call is.

To run the same checks locally before pushing:

```bash
# Static analysis (the curated ruleset only)
semgrep scan --config .semgrep/flowfi.yml --metrics=off backend frontend contracts

# Dependency audits
npm audit --omit=dev --audit-level=high
cargo audit --manifest-path contracts/Cargo.toml

# Secret scanning over the full history
trufflehog git file://. --results=verified --fail
```

If you add or change a rule, re-run it against the existing tree before opening
a pull request. A rule that fires on already-reviewed code is a bug in the rule
and will block everyone until it is fixed.

### If the secret scanner finds something

TruffleHog only fails on credentials it confirmed are live, so a finding is
real. Handle it in this order:

1. **Revoke the credential first.** Purging history does not invalidate a key
   that was already pushed.
2. Rotate any related secrets, and check the provider's audit log for use you
   did not initiate.
3. Purge the secret from history with `git filter-repo`, then force-push and ask
   all collaborators to re-clone.
4. Open a security advisory if the credential was ever reachable from a public
   branch.

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