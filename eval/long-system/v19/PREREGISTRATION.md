# Native Foreground Long-System V19 Preregistration

Status: **DRIVER READY FOR FREE GATE; NOT YET FROZEN OR EXECUTABLE.**

Final identity after the free gate and lock commit:
`plan-lattice-rc7-native-foreground-long-system-v19`.

No paid call may use this identity until `FREE_SMOKE.json` and
`frozen-manifest.json` are generated from a clean committed driver and the
manifest verifier passes. V18 remains immutable negative evidence and cannot be
rerun or reinterpreted.

## Question

On the same bounded written system-delivery task, does passive Plan Lattice
continuity improve final behavior after native DSH compaction, cold resume,
model-authored foreground delegation, and a later material human revision?

The intended treatment is narrow. Both arms use DSH's Session, Plan Mode, Todo,
prompt assembly, tools, compaction, process recovery, and subagent scheduler.
The candidate adds only a post-boundary projection of exact DSH-owned authority
and execution facts. It creates no contract, graph, lease, checkpoint, `.dsh`
file, mutation guard, or `lattice_*` tool in automatic mode.

## Fixed Arms

Both arms use the exact DSH rc.7 runtime, `deepseek-v4-flash`, temperature 0,
the same agent and compaction token limits, workspace shell boundary, fixture,
hidden grader, stage order, timeout, request budget, and token budget.

1. `native`: no Plan Lattice plugin.
2. `v0.4-native-continuity`: candidate commit
   `41b315f6f77a8b660018d4b67cfb095eea5adde4`, `activationMode: auto`,
   `clarificationPolicy: never`, `controlCeiling: lattice`.

Order is fixed as native then candidate. Each arm receives a clean copy of the
same fixture and an isolated DSH home, Session store, process home, and artifact
directory. The second arm cannot read the first arm's artifacts.

## Five Native Stages

The root receives Foundation, then DSH performs a real compaction and a cold
process resume before Transitions. The root then receives a delegation-stage
message requiring one foreground native `subagent` call. The child implements
historical summary behavior in the shared workspace and its result returns
through the parent's matching `tool/result`. A later human message replaces
checkout with adjust-start. DSH performs a second real compaction and cold
resume before final integration.

Every stage runs in a new Harness process. Stage messages marked `source:
plugin` add no product requirement; the original human authority and material
revision remain the only requirement sources.

## Required Foreground Evidence

The delegated stage is invalid unless durable Session artifacts prove all of:

- exactly one parent `tool/call` named `subagent`;
- valid raw model JSON containing non-empty `description`, non-empty `prompt`,
  and `run_in_background: false`;
- a preceding native `request/header` exposing exactly one `subagent` schema;
- exactly one successful parent `tool/result` with the same call id, turn, and
  step, citing the call event in `sourceEventSeqs`;
- exactly one direct depth-1 child with `origin: subagent`;
- a one-shot `subagent/descriptor` for provider `spawn` whose label equals the
  model-authored description;
- a first child ordinary `user/message` containing exactly the raw
  model-authored prompt; and
- a durable child `turn/end` whose reason is `completed`.

The evaluator must never call `ctx.subagents.start()`, create a child Session,
rewrite a child prompt, or print child output into the parent path. Absence of
the parent pair is conclusive invalidation.

## Free Gate And Freeze

Before freeze, a zero-paid-call local SSE model runs both arms through the exact
rc.7 headless CLI and all five process epochs. It must prove:

- candidate tarball installation into a clean profile;
- five completed stages and five process epochs per arm;
- at least two `compaction/summary` events and two canonical surface
  replacements per arm;
- exactly one durable model-facing foreground delegation per arm;
- byte identity between parent tool-call prompt and child first message;
- identical native subagent tool-schema digests across arms; and
- no candidate `lattice_*` call.

After the free gate passes, the driver commit, candidate commit, Harness
commit, runtime tarball, profile inputs, task, fixture, grader, wrappers,
budgets, order, thresholds, and free-smoke digest are written into one immutable
manifest. Only the later lock commit may add `FREE_SMOKE.json` and
`frozen-manifest.json`; any source change requires a new protocol identity.

## Paid Gates

The one paired execution may support a positive targeted result only when all
of the following pass:

- both arms complete all five stages inside the frozen budget and lifecycle;
- both arms expose the same native subagent schema and one durable foreground
  child;
- candidate final score is 100;
- candidate score exceeds native by at least 15 points;
- candidate misses zero hard requirements and retains zero stale requirements;
- delegated reporting behavior remains present in the final workspace;
- candidate input tokens remain below 4,000,000;
- candidate asks zero clarification questions under the closed written task;
- candidate makes zero forbidden automatic Plan Lattice control calls; and
- candidate records at least two summaries, two replacements, and five process
  epochs.

Failure is retained as the V19 result. The task, grader, threshold, or execution
order may not be edited and rerun under the same identity.

## Claim Boundary

A passing pair supports only this statement: under the frozen DSH rc.7 model,
budget, and five-stage task, the candidate preserved long-task authority better
than native by the observed score delta while using the same DSH control path.

It cannot establish a global ranking, universal coding-quality uplift,
statistical generalization, or superiority over Codex, Claude Code, or other
products. Those claims require a broader independently reproducible benchmark.
