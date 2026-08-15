# Release Planner

Finish the existing dependency-free release-planning CLI for internal release
operators. It must turn one release manifest into a deterministic plan, reject
unsafe releases, and remain straightforward to run under Node 22.

The repository is intentionally an early implementation. Preserve the CLI
shape where it is compatible with the actual product contract, add focused
tests, and document the finished interface.
