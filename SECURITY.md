# Security policy

## Supported versions

Fixes go into the latest release and `main`.

## Report a vulnerability

Please do not open a public issue. Use **Security → Report a vulnerability** on the [GitHub repository](https://github.com/MS1317/pc-file-bridge-community/security/advisories/new) to send a private report. Include the version or commit, steps to reproduce, the impact, and a suggested fix if you have one.

## Scope

In scope: bypassing authentication, permissions, approvals, or file rules; reading or writing outside registered workspaces through file tools; exposing the bridge's tokens.

Out of scope, by design: anything a terminal command can do once you enable the terminal (commands are not sandboxed), and anything that requires an attacker who already runs code as your user.

The full threat model is in [docs/SECURITY.md](docs/SECURITY.md).
