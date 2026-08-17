# v0.4.0-rc.5

RC.5 extends the first-drift invariant across process death. A protected action
is no longer considered finished merely because the runtime that started it no
longer exists: its checkpoint obligation is durable workspace state.

## What Changed

- Full-Lattice checkout acquires a cross-process workspace lease before the
  graph checkout commits.
- The lease binds the root session, node, graph revision, contract revision and
  digest, owner process, host, and monotonic generation.
- Every guarded tool is durably marked dirty before its body may start. A thrown
  tool remains dirty because a failure can conceal a partial side effect.
- A new process may take over a definitely dead owner after a grace period, but
  a dirty takeover must preserve the exact execution basis and cannot continue
  until the prior action is checkpointed.
- Live owners conflict, stale compare-and-swap claims fail, and dirty leases
  cannot be released by ordinary disposal.
- Reframe acquires a durable workspace fence before publishing the revised
  contract and holds it through graph reconciliation. A concurrent checkout
  cannot appear between the two commits.
- Recovery recognizes both exact two-file crash windows: a clean checkout
  reservation one revision ahead of the graph is rolled back, while checkpoint
  evidence one revision ahead of execution state settles the lease.
- Graph commits use a durable ledger plus revision commit marker. Readers ignore
  uncommitted ledger tails, tolerate a truncated uncommitted tail, recover locks
  owned by definitely dead processes, reject pending graph creation, and compact
  only after commit.
- Directory durability is confirmed after every state rename. A transient
  `fsync` failure is retried; an unconfirmed visible rename retains its sole
  writer fence so a definitely dead owner can recover it without exposing a
  false failure followed by duplicate execution.
- Reframing now reopens every non-archived node, including nodes previously
  complete under the old contract. Historical evidence remains visible but does
  not satisfy the revised contract.
- Empty and all-archived pre-RC.5 graphs fail closed when they cannot prove which
  v2 contract revision they adopted.
- Explicit bypass remains a true bypass, and `controlCeiling: contract` cannot
  be promoted to full Lattice by task text.

## Measured Evidence

The existing deterministic first-drift experiment still reports:

- unsafe stale-basis mutations: native `12/12`, Plan Lattice `0/12`;
- matched legitimate actions: native `7/7`, Plan Lattice `7/7`.

The new deterministic crash-continuity experiment uses real `SIGKILL` and a new
Node.js process against the same Harness workspace:

- unsafe post-crash continuations: native `2/2`, Plan Lattice `0/2`;
- matched legitimate restart controls: native `2/2`, Plan Lattice `2/2`.

The two hazards are a successful side effect with no checkpoint and a failed
tool that already produced a partial side effect. The two controls are a clean
restart and a restart that checkpoints the prior action before continuing.

These are hand-designed mechanism experiments. They establish behavior on the
named invalidation surfaces; they do not estimate general coding quality,
production reliability, model intelligence, or real-world task-success uplift.

## Reproduce

No model call or API key is required:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

The RC.5 checkout passes `436/436` plugin and protocol tests and `55/55`
evaluation-controller tests, followed by both committed mechanism-result checks.

The repository stores the executable drivers and per-arm results:

- [`first-drift-benchmark.json`](../demo/results/first-drift-benchmark.json)
- [`crash-continuity-benchmark.json`](../demo/results/crash-continuity-benchmark.json)
- [`first-drift-benchmark.mjs`](../demo/first-drift-benchmark.mjs)
- [`crash-continuity-benchmark.mjs`](../demo/crash-continuity-benchmark.mjs)

## Install

```sh
gh release download v0.4.0-rc.5 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.4.0-rc.5.tgz
```

## Evidence Boundary

RC.5 remains a prerelease. The frozen RC.4 external-model study has not run and
does not bind this changed runtime. A stable evidence-backed v0.4 still requires
a newly bound external evaluation whose analyzer authorizes release. No general
quality uplift, leaderboard position, or production guarantee is claimed.

Durable ownership serializes cooperating Plan Lattice runtimes in one workspace.
Direct writes by unrelated processes remain a host isolation responsibility.
