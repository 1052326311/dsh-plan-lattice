# DSH rc.7 Native Long-Task Control Map

Reviewed checkout:
`/Users/xin/Documents/openclaw开源贡献/deepseek-harness-architecture-20260819`
at `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` (`dsh-v0.1.0-rc.7`).

This map defines the compatibility boundary for Plan Lattice. Automatic mode
extends the facts and lifecycle DSH already owns. It does not replace them with
a second planner, scheduler, transcript, or child protocol.

## Request Assembly And Durable History

- `packages/core/agent-loop/src/agent.ts:225-243` claims native Inbox input,
  assembles the scoped system prompt and tools, renders dynamic runtime context,
  and appends a runtime-context snapshot only when it changed.
- `packages/core/agent-loop/src/agent.ts:279-299` appends accepted input to the
  Session surface, runs the model step, executes native tool calls, and closes
  the step and turn.
- `packages/core/agent-loop/src/agent.ts:332-400` derives every model request
  from `session.deriveMessages()` and sends tool calls through DSH's scheduler.
- `packages/core/agent-loop/src/agent.ts:407-494` freezes and records the exact
  request header, system prompt, tool schemas, route, and model configuration.
- `packages/core/agent-loop/src/runtime-context.ts:24-75` tracks DSH's retained
  runtime-context snapshot. A replacement that shadows that snapshot clears the
  projection, so the next assembly may append a current snapshot.
- `packages/core/system-prompt/src/index.ts:337-542` is the native registry for
  static prompt sections, dynamic contexts, variables, and tool schemas. Its
  scoped assembly and waterfall remain authoritative.
- `packages/core/session/src/index.ts:701-746` derives model-visible messages
  only from the current Session surface. The append-only log is retained even
  when a surface node is replaced.

Plan Lattice auto contributes only a boundary-frozen, source-surface-deduped
dynamic context after a proven continuity boundary. Before that boundary its
model-facing contribution is empty and its tools are absent. A later native
Todo update, user message, or child result does not mutate that recovery
snapshot; those facts already travel through DSH's own messages.

## Compaction And Context Replacement

- `packages/compaction/compaction-basic/src/index.ts:147-165` checks pressure at
  the native pre-step boundary. `:179-223` handles provider-confirmed context
  overflow and retries only after durable surface progress.
- `packages/compaction/compaction-basic/src/index.ts:226-245` summarizes through
  DSH's own routed request prefix, system prompt, tools, and messages.
- `packages/compaction/compaction-basic/src/region.ts:447-465` appends the
  `compaction/summary`, then appends the checkpoint as a normal `user/message`
  whose `surfaceOp` is `{ op: 'replace', start, end }`.
- `packages/core/session/src/surface.ts:320-379` validates and applies that
  positional replacement. `replaceGeneration` increments only after the
  replacement enters the canonical surface.
- `packages/core/session/src/index.ts:708-746` rebuilds derived model history
  when `replaceGeneration` changes. The original events remain in the durable
  Session log but no longer appear on the model surface.

The real drift boundary is therefore the committed replacement event, not a
token estimate, elapsed time, arbitrary step count, process restart, or fresh
child creation. Automatic continuity anchors exact human message identities
outside the agent-writable workspace and reprojects original Session text only
when the corresponding source seq has actually left `session.surface.nodes`.
A cold resume reconstructs the durable replacement and retained runtime
snapshot; it does not create a second boundary or append the same payload.

## Native Plan Mode

- `packages/plan/plan-mode/src/index.ts:1-18` states the native ownership rule:
  plan state is folded from `plan/mode`; the exit tool remains stable in the
  request catalog.
- `packages/plan/plan-mode/src/index.ts:205-233` commits pending mode changes at
  accepted pre-step and contributes DSH's `plan:policy` section.
- `packages/plan/plan-mode/src/index.ts:305-393` asks the user to review the
  exact model-authored plan. A successful `exit_plan_mode` call and result are
  the durable approval evidence.
- `packages/plan/plan-mode/src/index.ts:396-459` restores and transitions native
  plan state without a process-local mirror.

Plan Lattice auto never creates a replacement plan. After continuity loss it
may project the latest successful `exit_plan_mode` call argument and matching
result from the Session log.

## Native Todo

- `packages/todo/tool-todo/src/index.ts:45-77` defines the model-facing
  whole-list replacement contract.
- `packages/todo/tool-todo/src/index.ts:128-147` folds the latest `todo/write`
  inside one turn and clears it at the next `turn/start`.
- `packages/todo/tool-todo/src/index.ts:149-225` validates and appends the
  native Todo snapshot to the calling Session.

Plan Lattice auto may audit this fold but never writes, extends, or reprojects
it. A Todo is execution-local progress, not durable human authority. DSH owns
its current-turn lifetime, and automatic continuity must not turn it into a
cross-turn plan or cause a full authority snapshot whenever the list changes.

## Model-Facing Foreground Delegation

- `packages/subagent/tool-subagent/src/index.ts:299-367` registers the native
  model tool and its `description`, `prompt`, and `run_in_background` fields.
- `packages/subagent/tool-subagent/src/index.ts:371-387` maps the model's raw
  `args.prompt` directly to one child text block and binds the live parent.
- `packages/subagent/tool-subagent/src/index.ts:389-431` selects the scheduling
  path. `run_in_background: false` calls `ctx.subagents.start()` inside the
  model tool and waits for the result.
- `packages/subagent/subagent-in-process-driver/src/index.ts:102-147` creates a
  fresh child with DSH-owned composition and metadata.
- `packages/subagent/subagent-in-process-driver/src/index.ts:154-203` delivers
  the exact provider prompt as the child's first ordinary `user/message`, waits
  for the child, and disposes it only after the result lifecycle settles.
- `packages/subagent/subagent/src/child-agent.ts:102-119` records the workspace,
  direct `parentSession`, `origin: subagent`, and delegation depth.
- `packages/core/agent-loop/src/tool-calls.ts:164-175` appends the parent
  `tool/call` before dispatch and commits settled results in model order.
- `packages/core/agent-loop/src/tool-calls.ts:261-288` appends the matching
  parent `tool/result` with the same call id and `sourceEventSeqs: [callSeq]`.

A valid evaluation must make the root model emit this tool call. Calling
`ctx.subagents.start()` from the evaluator skips the parent AgentLoop pair and
is not evidence of real DSH delegation. V20 therefore compares the raw parent
tool-call prompt to the child's first message, requires a completed child
`turn/end`, and requires the matching parent result before scoring.

A fresh child is not a continuity loss: its exact standalone instruction is
already the first ordinary DSH user message. Automatic Plan Lattice therefore
adds no root authority, root plan, or recovery capsule to that first child
request. Only a later replacement in the child Session may restore the exact
delegated instruction that the replacement removed.

## Plugin Ownership Boundary

| DSH owns | Plan Lattice `auto` may do |
| --- | --- |
| Session append, persistence, surface, replay, and repair | Observe durable replacement and resume boundaries |
| Prompt assembly, Plan Mode, Todo, tools, and model routing | Add one scoped continuity projection after a boundary |
| Child creation, composition, prompt, scheduling, and result delivery | Verify child identity; restore hidden child input only after a child replacement |
| Ordinary execution and workspace mutation | Nothing: expose no `lattice_*`, install no mutation guard, write no `.dsh` |

Full contracts, graph nodes, leases, mutation receipts, and checkpoints remain
available only through `activationMode: always` or an explicit full-Lattice
request. They are a separate opt-in transaction layer, not the automatic DSH
long-task path.

## V20 Evidence Boundary

The free V20 gate uses the exact rc.7 runtime artifact and headless CLI for five
separate process epochs. Before lifecycle scoring, each arm must make a real
model-facing Bash call that mutates its workspace, runs `node --test`, and
proves the outer evaluator sandbox denies an otherwise-readable repository
file. DSH uses `danger-full-access` only inside that outer Darwin sandbox so it
does not attempt unsupported nested sandboxing. The gate then requires two real
compactions, two canonical surface replacements, one model-facing foreground
delegation, durable child completion, matching native subagent schemas in both
arms, and no candidate `lattice_*` calls. The paid pair uses the same path with
the frozen model, budget, task, fixture, grader, and revision sequence.

These checks can support a result about continuity on that frozen task. They do
not by themselves establish a global ranking, general coding quality, or a
universal long-task uplift.

## V20 Negative Result And Correction

The retained V20 pair scored 100/100 in both workspaces, but the candidate
exceeded the 4,000,000 input-token ceiling and did not execute final
integration. The result permits no positive uplift claim; see `RESULT.md`.

V20 exposed two separate effects. Agent path variance produced extra model
turns in Foundation and Material Revision. The automatic continuity payload
then amplified those turns because DSH runtime-context updates append durable
snapshots: the root accumulated 67,631 characters and the child accumulated
61,934 characters before the second compaction. Todo changes, returned child
results, ordinary process restarts, and new human input each rebuilt the full
payload.

The successor behavior freezes projection state at the exact replacement seq,
checks source seqs against the current native surface, passes fresh child
requests through unchanged, reuses the durable replacement identity on cold
resume, and suppresses a normal runtime snapshot while an identical direct
overflow-recovery message remains visible. Replaying the V20 event structure
under these rules reduces pre-second-compaction continuity payload from
129,565 characters to approximately 4,958 characters (96.2%). This is a
structural counterfactual, not a measured model-quality or token-uplift claim.
