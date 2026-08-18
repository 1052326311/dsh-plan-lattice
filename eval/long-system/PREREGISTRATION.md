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

## V1 through V5 retained outcomes

The first v1 execution was retained and retired before model execution. Both
arms created root Session IDs beginning with `long-system-`, while the already
frozen credential proxy admitted only the `plan-lattice-` Session namespace.
The proxy rejected both first requests locally with `contractValid: false`:
there were zero admitted agent requests, zero input and output tokens, no
completed stages, and no model-generated workspace changes. The resulting
fixture score is therefore not a model outcome and is excluded from comparison.

V2 changed only the root Session prefix to
`plan-lattice-long-system-`. Candidate commit, task, fixture, grader, Harness,
model, arm order, tools, budgets, and thresholds remain unchanged. The v1
manifest is preserved as `frozen-manifest-v1.json`; the public failure record
binds the raw local report and audits by SHA256.

V2 then produced a valid negative result and is preserved as
`frozen-manifest-v2.json` plus `results/v2-budget-failure.json`. Both arms
exhausted the same one-million-input-token limit during stage one. The v2
candidate scored 5/100 versus native at 25/100 because its initial control
bootstrap consumed most useful requests and context before production work.
That result is not an infrastructure rerun and may not be replaced.

V3 changed only the committed candidate implementation. It binds the complete
human request to immutable durable Session events, distinguishes first-contract
bootstrap from reframe, permits a compact question-free intake, infers known
open fields, and focuses the selected initial leaf. Task, fixture, hidden grader,
Harness, model, arm order, tools, budgets, thresholds, and failure-retention
policy remained unchanged.

V3 produced a second valid negative result and is preserved as
`frozen-manifest-v3.json` plus
`results/v3-control-friction-failure.json`. Neither arm completed stage one and
both scored 5/100. Candidate used 26 requests, 1,025,104 input tokens, and 30,124
output tokens; native used three requests, 16,896 input tokens, and 33,238 output
tokens. The candidate's separate intake turn emitted 20,043 output tokens, Bash
required complete commands to be duplicated into authorization arguments, and
an operational repeat-tool reminder was incorrectly classified as product
change. This is outcome evidence against v3 and may not be replaced.

V4 changed only the committed candidate implementation and the candidate host
adapter needed to exercise that implementation. Question-free full-Lattice work
established its compact contract inside `lattice_open`, operational plugin
messages cannot revise human authority, parent selections resolve to a
deterministic executable leaf, refresh preserves current focus, and the Bash
adapter may bind the current non-control workspace scope before the model emits
one exact normalized action. The guard still rejects unsupported execution
metadata, rechecks the scope, consumes one authorization epoch, and locks the
full emitted call identity before dispatch. Task, fixture, hidden grader,
Harness, model, arm order, visible tools, budgets, thresholds, and
failure-retention policy remained unchanged.

V4 produced a third valid negative result and is preserved as
`frozen-manifest-v4.json` plus
`results/v4-max-token-planning-failure.json`. Neither arm completed stage one
and both scored 5/100. Candidate used four requests, 37,375 input tokens, and
33,327 output tokens; native used three requests, 16,811 input tokens, and
33,225 output tokens. After two blocked Bash probes, one glob, and four focused
reads, the candidate emitted 32,766 tokens of design reasoning without calling
`lattice_open` or changing the workspace. Native also ended at max tokens. This
is outcome evidence against V4 and may not be replaced.

V5 changes only the committed candidate implementation and the candidate
wrapper prompt needed to exercise it. A fresh question-free task can call
`lattice_open {}` before inspection or design narration. The controller binds
immutable human Session authority and creates a generic accepted-outcome root
plus one focused executable leaf. The model may refine that leaf later from
repository evidence but no longer has to author a complete initial graph before
execution. Explicit initial plans remain supported, and legacy intake keeps its
required title and objective. Task, fixture, hidden grader, Harness, model, arm
order, visible tools, budgets, thresholds, and failure-retention policy remain
unchanged. V5 prospectively tests whether controller-owned minimal bootstrap
converts preserved authority into production progress on the same external
outcome.

V5 produced a fourth valid negative result and is preserved as
`frozen-manifest-v5.json` plus
`results/v5-history-amplification-failure.json`. Neither arm completed stage
one and both scored 5/100. Candidate used 29 requests and 1,017,437 input
tokens while native used three requests and 16,774 input tokens. Repeated
refresh/checkpoint turns and raw model-visible tool history amplified the same
execution payload until the candidate exhausted its budget. This is outcome
evidence against V5 and may not be replaced.

V6 changes only the committed candidate implementation and the candidate
wrapper required to exercise the native rc.7 lifecycle. Human authority,
contract, plan address, acceptance, and semantic evidence remain durable;
mechanical attempts use crash-recoverable receipts and release markers;
conversation history and bulky tool results remain DSH-owned. The candidate
projects stable policy through DSH system-prompt assembly and mutable control
through its native runtime context, preserves DSH plan mode, compaction,
subagent construction, and scheduling, and reserves checkpoints for verified
semantic progress. Task, fixture, hidden grader, Harness, model, arm order,
visible tools, budgets, thresholds, and failure-retention policy remain
unchanged. V6 prospectively tests whether the narrower controller avoids V5
history amplification without weakening the long-task authority boundary.

V6 was frozen but no model request was started. Its unexecuted manifest remains
as `frozen-manifest-v6.json`. V7 is a pre-run evaluation hardening amendment,
not a candidate replacement: it retains the same candidate commit, task,
grader, Harness commit, model, arm order, budget, and thresholds. It adds the
SHA-256 and runtime metadata for a host Harness archive built from the exact
rc.7 Git commit, requires the driver to match those bytes before execution, and
adds a zero-model preflight that reports credential, runtime, lock, and lineage
failures before either arm can start. No V6 outcome exists to replace.

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
