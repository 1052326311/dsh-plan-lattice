# Contributing

Plan Lattice accepts focused bug fixes, compatibility repairs, documentation
corrections, and proposals that strengthen long-task execution continuity.

## Before Opening A Change

Open an issue first when a change affects the contract format, router policy,
guarded-tool semantics, recovery rules, or external evaluation protocol. Small
reproducible defects can go directly to a pull request.

Every behavioral change should state:

- the exact Harness and Plan Lattice versions;
- the stale or incomplete action basis that can currently execute;
- the observable wrong outcome;
- the intended invariant and recovery path; and
- why existing bypass, contract, or lattice behavior is insufficient.

Do not rewrite frozen benchmark tasks, graders, thresholds, result files, or
protocol tags to improve a reported result. Negative results are retained.

## Development

Use Node.js 22.19 or newer and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

Production fixes should include a focused regression and, where relevant, a
real Harness integration test. A guard that blocks stale work must also show
that the matched current-basis action still executes.

Keep generated evaluation evidence and credentials outside the repository.
Never place API keys, signing keys, private benchmark assets, or raw paid-run
logs in a pull request.

## Pull Requests

Keep changes scoped to one behavior. Include the exact commands run and call
out any untested boundary. A passing unit test is not sufficient evidence for
a model-facing or installed-artifact change; exercise the rendered tool result
or packaged plugin path as well.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
