# Security Policy

## Supported Versions

The latest stable release receives compatibility and security fixes. Public
release candidates are supported for evaluation but may change before the next
stable release.

## Reporting A Vulnerability

Do not open a public issue for a vulnerability that could expose credentials,
bypass a guarded mutation, forge a contract or graph revision, escape the
declared workspace, impersonate a parent session, or corrupt evaluation
evidence.

Use GitHub's private vulnerability reporting flow from the repository Security
tab. Include the affected version, a minimal reproduction, the expected
invariant, and whether the issue is exploitable through an untrusted task or
plugin. Please avoid including real credentials or private workspace data.

Public correctness bugs without a security impact can use the bug report
template.
