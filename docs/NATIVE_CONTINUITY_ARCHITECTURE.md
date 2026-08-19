# Native Continuity Architecture

## First Principle

Long-task drift is not primarily a missing planning-field problem. It occurs
when a later model request can no longer reconstruct the same execution basis
that governed an earlier request. In DSH this happens at concrete native
boundaries: a Session surface replacement, a cold resume of replaced history,
or a fresh subagent Session that cannot see the complete current parent basis.

Plan Lattice therefore extends DSH's native control flow. It does not replace
it.

## Ownership Boundary

| DSH owns | Plan Lattice auto owns |
| --- | --- |
| Inbox claiming and turn/step lifecycle | Detecting a committed native continuity boundary |
| Session append, surface replacement, replay, and repair | Anchoring exact human-message identities and digests outside the workspace |
| Plan Mode, review, and `exit_plan_mode` | Re-projecting the latest DSH-approved plan after continuity loss |
| `todo/write` and its one-turn projection | Re-projecting the current native Todo without changing it |
| Subagent creation, prompt delivery, scheduling, and foreground result return through parent `tool/result` | Verifying the exact first child message identity and projecting native branch results |
| Tool calls, results, and mutation execution | Nothing in automatic mode: no mutation guard or plugin control tool |

The plugin never appends a private Session event. DSH has no public third-party
event-registration contract, and unknown non-ignorable events fail persistence.

## Automatic Mode

Before a boundary, a clear task is byte-for-byte native from the model's point
of view. After a boundary, Plan Lattice contributes one scoped runtime-context
projection assembled from DSH's append-only log:

1. exact human-authored authority selected by immutable Session message IDs;
2. the latest successfully reviewed native `exit_plan_mode` plan;
3. the current native `todo/write` projection, if still in the same turn;
4. recent foreground subagent results already returned through parent
   `tool/result` events; and
5. the native parent/root/child Session identity and child first-message digest;
   after the child message itself has been replaced, its exact original text is
   re-projected from the child Session event identified by that digest.

Automatic mode creates no workspace `.dsh` files, injects no Plan Lattice policy
section, exposes no `lattice_*` tools, blocks no DSH tools, and requires no
model-authored refresh, intake, reframe, receipt, lease, checkpoint, or graph
operation. New human messages are appended to the immutable authority anchor
automatically; they never require a model to translate them into a second
contract.

For a same-step context-overflow retry, rc.7 cannot rebuild its private runtime
projection. The plugin appends the complete passive projection as an ordinary
DSH plugin `user/message` and verifies that exact message on the original native
wire. Automatic mode does not turn that host limitation into a write guard or a
private request builder.

## Explicit Full Control

`activationMode: always` and the explicit instruction `use full Plan Lattice`
retain the contract, graph, mutation basis, and crash-safety mechanisms. Those
mechanisms are an opt-in transaction layer for irreversible or externally
coordinated work. They are not the default long-task planner.

## Evaluation Consequence

A valid long-system comparison must use the model-facing DSH `subagent` tool in
both arms. The child output must return to the parent as the matching native
`tool/result`; calling `ctx.subagents.start()` from the driver and printing its
result outside the parent Session does not test DSH delegation continuity.

V18 made that driver error. Native scored 88 with one hard miss; the candidate
scored 75 with two hard misses. The candidate's lower token use is not an uplift
result. V18 is retained negative evidence, must not be rerun under the same
identity, and must not be used in release or promotional claims.
