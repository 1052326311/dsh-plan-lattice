# v0.4.0-rc.4

RC.4 tightens the point where accepted human intent, repository evidence, and
delegated execution become mutation authority.

## What Changed

- Polite English and Chinese requests to build an underspecified system now
  enter `contract` control instead of bypassing orchestration.
- An outcome-critical product-definition gap cannot commit with zero questions
  under `clarificationPolicy: critical`.
- User-question answers are checked against offered options and selection
  cardinality. The persisted authority is a canonical statement derived from
  the exact question and human answer; a model-authored rewrite is rejected.
- A `ready` contract cannot retain unresolved unknowns, and a critical answer
  cannot be rebound as an unknown.
- `lattice_route` is now a two-stage protocol. `inspect` reads the complete
  declared repository files and returns a one-use digest receipt; `resolve`
  fails if the receipt was consumed, authority changed, or any file changed.
- Explicit `bypass` no longer freezes arguments or changes downstream Harness
  middleware behavior.
- Delegated-agent capsules retain the parent node id, title, acceptance
  criteria, and graph revision across handoff invalidation without inheriting
  mutation authority.
- Resume fails closed when an interrupted reframe leaves a new contract over an
  unreconciled old graph.

## Measured Evidence

The deterministic first-drift mechanism stress test uses real Harness runtime
services. In its 12 engineered stale-basis hazards, native Harness entered the
unsafe mutation body in `12/12` cases and Plan Lattice in `0/12`. Both arms
executed `7/7` matched legitimate controls.

This is a deliberately constructed mechanism test. It does not estimate general
coding quality, real-world task success, or production uplift.

The exact RC.4 checkout passes:

- `337/337` plugin and protocol tests;
- `52/52` evaluation-controller tests, including the frozen headless Harness
  integration fixture;
- type-check, build, package, clean-install, diff, and secret checks.

## Install

```sh
gh release download v0.4.0-rc.4 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.4.0-rc.4.tgz
```

## Evidence Boundary

The older 90-run external-model manifest binds commit
`dc55716525987fcb7cb46579a9c957877cbd23c2` from the RC.3 line. It does not bind
RC.4 and is not RC.4 outcome evidence. A new candidate freeze is required before
any broader model-quality claim.

The prospective V14 router evaluation now supplies that RC.4-specific freeze.
The public
[`router-v14-rc4-candidate-freeze`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v14-rc4-candidate-freeze)
release binds RC.4 commit `7cb3c77f9dab6ef193eb77318fb87389b877b526`,
and the separate
[`router-v14-protocol-freeze`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v14-protocol-freeze)
release binds the evaluation protocol before any V13 reveal. V14 must reuse the
exact future V13 corpus, V13 must reveal first, and both outcomes must remain
public. This measures automatic-control routing only, not general coding-task
quality.

The root README is part of that historical protocol checksum, so RC.4 leaves it
byte-for-byte unchanged. Current release documentation lives here, in
[`BENCHMARK.md`](https://github.com/1052326311/dsh-plan-lattice/blob/main/BENCHMARK.md),
and in the GitHub release.

## Host Boundaries

- Every third-party mutation tool must be declared in `guardedTools`; direct
  process writes outside the Harness tool registry require host isolation.
- Default `strictBash` fails closed unless the host supplies a precondition
  adapter for general shell side effects.
- A guarded tool body that throws still dirties the lease because partial side
  effects cannot be ruled out; evidence must be checkpointed before continuing.
