# Long-System Exploratory Pair Preregistration

## Claim under test

With the same DeepSeek Harness commit, model, budget, tools, workspace, stage
messages, process boundaries, compactions, and delegated child stage, Plan
Lattice should preserve more of a complete accepted system contract than native
Harness after the original prompt leaves the visible context and a later human
revision invalidates one prior rule.

This first pair is a targeted exploratory experiment, not an estimate of general
coding quality and not sufficient for a global ranking claim.

## Two-stage code freeze

The plugin candidate is committed first and identified by `candidateCommit`.
The deterministic manifest is then generated from that clean candidate tree and
committed in a later driver commit. A valid run requires a clean driver checkout,
requires `candidateCommit` to be its strict ancestor, verifies every driver,
task, fixture, wrapper, and grader digest against the manifest, and builds the
candidate package from `candidateCommit` rather than from the driver checkout.
The report records both commits. This avoids a self-referential manifest while
preventing post-freeze candidate or evaluator changes.

## V1 infrastructure retirement

The first v1 execution was retained and retired before model execution. Both
arms created root Session IDs beginning with `long-system-`, while the already
frozen credential proxy admitted only the `plan-lattice-` Session namespace.
The proxy rejected both first requests locally with `contractValid: false`:
there were zero admitted agent requests, zero input and output tokens, no
completed stages, and no model-generated workspace changes. The resulting
fixture score is therefore not a model outcome and is excluded from comparison.

V2 changes only the root Session prefix to
`plan-lattice-long-system-`. Candidate commit, task, fixture, grader, Harness,
model, arm order, tools, budgets, and thresholds remain unchanged. The v1
manifest is preserved as `frozen-manifest-v1.json`; the public failure record
binds the raw local report and audits by SHA256. V2 is the sole eligible
exploratory pair, under the predeclared infrastructure-failure rerun policy.

## Frozen interventions

1. Root process receives the complete contract and implements only foundation.
2. A real Harness manual compaction runs before a new root process implements the
   remaining state machine.
3. A live parent creates a real child Session with durable `parentSession`; the
   child implements reporting without receiving the original contract again.
4. A new human message replaces `reopen` with `requeue`.
5. A second real compaction runs before a final root process integrates and
   verifies the system.

The original contract is absent from the starter repository. The hidden grader
and this repository are denied to the model process by the host sandbox.

## Paired arms and budget

- `native`: no Plan Lattice plugin.
- `v0.4-lattice`: candidate package with `activationMode=always`,
  `clarificationPolicy=never`, and `controlCeiling=lattice`.
- Both use `deepseek-v4-flash`, temperature zero, 60 agent requests, 1,000,000
  observed input tokens, 80,000 observed output tokens, and a one-hour wall
  limit. Official Harness compaction requests use its fixed 8,192-token cap and
  are counted in the same request and token budget. No requirement questions or
  external network tools are available.

## Frozen outcome measures

- Hidden functional score from 0 to 100.
- Seeded hard-constraint misses.
- Whether stale `reopen` behavior survives the revision.
- Coverage of the four revision-affected artifacts named in the contract.
- Whether reporting checks that passed in the child snapshot regress after root
  integration.
- Model turns, input/output tokens, duration, process epochs, real compaction
  summaries, and durable parent/child lineage.

The exploratory signal is positive only when both attempts stay inside budget,
the candidate scores at least 15 points and 30% relatively above native,
candidate hard-constraint misses fall by at least half, candidate retains no
stale `reopen` behavior, and final integration does not regress child reporting.
No stable release or broad superiority claim follows from one pair.
