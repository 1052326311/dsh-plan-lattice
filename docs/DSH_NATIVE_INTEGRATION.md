# DeepSeek Harness Native Integration

This document freezes the architectural boundary used by Plan Lattice against
DeepSeek Harness `dsh-v0.1.0-rc.7` (`99f6f02fec`). The plugin is an extension of
the Harness execution spine, not a second harness.

## First-Principle Boundary

The stable problem is loss of model-visible execution basis across lossy native
transitions. Conversation surface is changeable; DSH's durable human messages,
approved Plan, current-turn Todo, returned foreground child results, and Session
lineage are the native basis that must remain reconstructable.

DeepSeek Harness owns model requests, Session append and replay, compaction,
tool-result pruning, Plan Mode and review, Todo projection, subagent creation,
child prompts, scheduling, tool execution, and result delivery.

In default `activationMode: auto`, Plan Lattice owns only:

- detecting a committed `surfaceOp.replace`, cold resume of replaced history,
  or child-delegation boundary;
- anchoring exact human and child-first-message identities and digests outside
  the workspace; and
- passively re-projecting the relevant DSH-native basis after that boundary.

Only explicit full-Lattice control owns a durable contract, optional revisioned
root-to-leaf address, pre-action authorization, mechanical attempt receipts,
leases, checkpoints, and mutation invalidation.

## Model Request Spine

For every step, the native loop first claims pending inbox input, then assembles
the system prompt, dynamic contexts, and tool schemas, projects changed runtime
context as a sourced user message, and finally runs `agent/pre-step`. A model
tool call ends that step; its tool result enters `next-step`, whose following
step performs a new assembly. Only an `agent/request-error` retry inside the same
step reuses that step's system string and tool schemas while deriving current
Session messages again. This ordering is why rejecting a downstream pre-step
after input was claimed loses accepted work rather than replaying it.

Plan Lattice integrates at the existing seams:

| Native seam | Plan Lattice use |
| --- | --- |
| `agent/inbox/inserted` | Anchor authoritative root input and recover the task-level mode before first assembly; never reject an accepted inbox splice |
| `systemPrompt.section` | Explicit full-Lattice policy only; automatic mode injects no Plan Lattice policy section |
| `systemPrompt.context` | Passive native continuity projection after a real boundary; contract and root-to-leaf state only in explicit full-Lattice mode |
| `agent/pre-step` | Reconstruct continuity state and diagnose explicit-control assembly incompatibility without discarding claimed input |
| `llm/stream` | Attest the deep-frozen AgentLoop request only for explicit full-Lattice/legacy control; automatic mode trusts DSH assembly and has no mutation gate |
| `agent/turn-stopping` | After a recorded `max-tokens` finish on an active controlled task, enqueue at most the configured number of native next-turn `followup()` continuations; never steer inside the sticky turn |
| `planMode.get(agent)` | Yield planning-turn ownership to DSH, including its pending next-step state, without implementing a second plan mode |
| `tools/change` plus the scoped tool registry | Revalidate the affected Agent's exact definition identities without treating another Agent's scoped change as local drift or rerunning prompt assembly |
| scoped tool restrictions | Explicit full-Lattice control only; automatic mode leaves the DSH tool set unchanged |
| tool guard and `tools/execute` middleware | Explicit full-Lattice control only: bind and consume pre-action authority and record the side-effect around-dispatch observation |
| `tools/result` | Observe DSH's frozen model-visible result for conformance only; it is a non-awaitable notification and therefore cannot be the durable side-effect commit point |
| `session/event` | Fold durable native Plan, Todo, human input, foreground child result, and surface-replacement events |
| Agent registry ownership | Verify ordinary one-shot root-to-child ownership |
| `subagents.registerContinuableSetup` | Use the exported, exact-rc.7 pre-publication setup extension to attest a continuable child's durable parent |

Automatic mode has no permanent Plan Lattice policy section. Its mutable
continuity projection is scoped, boundary-triggered, and attributable through
DSH's runtime-context channel. Explicit full-Lattice policy remains deliberately
small and does not inject a second Plan Mode, Todo, compactor, subagent template,
or result channel. This keeps the plugin from competing with native DSH behavior
for the same model attention budget.

### Output-cap continuation

In rc.7, DeepSeek wire `finish_reason: "length"` becomes `max-tokens` and the
AgentLoop ends that turn by default. Calling `steer()` at `agent/turn-stopping`
would only add another step to the same turn, where that terminal result stays
sticky. For explicitly active `contract` and `lattice` control, Plan Lattice records the
exact session/turn/step only after the terminal chunk crosses its observed
`llm/stream` boundary. At `agent/turn-stopping` it checks that no
other plugin already ran a later step, then uses `agent.followup()` to enter a
fresh native turn.

The continuation is deliberately small, bounded, and disabled by default. It
carries no second plan protocol, cannot run in `bypass`, will not run across a pending human reframe,
and is counted from exact plugin-authored durable `user/message` rows. A cold
resume therefore cannot recover more budget. It addresses one known native
termination state; it does not claim to solve model intelligence, task
definition, compaction, or delegation on its own.

Plan Lattice private audit markers also use DSH's known plugin `notice`
`user/message` envelope instead of a private session-event type. That keeps a
fresh DSH process able to load the durable log before the plugin reconstructs
its own review boundary.

### First-turn minimalism

For `activationMode: auto`, the first native request already contains the human
task as its normal DSH user message. Plan Lattice therefore contributes no
policy prose, runtime snapshot, tool schema, state file, write guard, synthetic
tree, or controller call before continuity is lost. DSH prompt assembly, Plan
Mode, Todo, tools, mutations, and result delivery remain native.

Only a durable `user/message` with `surfaceOp: { op: 'replace' }`, a cold resume
of already replaced history, or a fresh delegated child activates the passive
projection. `compaction/summary` and `compaction/prune` are audit records, not
proof that the model-visible surface changed. Ordinary human follow-ups remain
native input and are added to the authority anchor automatically.

At a boundary the plugin folds DSH's append-only Session log and projects exact
anchored human messages, the latest successful native `exit_plan_mode` plan, the
current native Todo if it still belongs to this turn, recent successful
foreground child results already returned through the parent's `tool/result`,
and Session lineage. It does not create a neutral contract or require a
`lattice_refresh_context` call. The external anchor stores message IDs and
digests rather than prompt text, then verifies those identities against DSH's
log before projection.

The plugin neither constructs a child prompt nor changes native Plan Mode,
Todo, compaction, scheduling, or result delivery. `activationMode: always` and
an explicit full-Lattice request retain the separate eager transaction layer.

### Continuity, Not Repetition

The current native DSH basis is already model-visible during a stable segment.
Re-rendering it after every file read, tool result, Plan update, or Todo update
would duplicate tokens and compete with implementation. Automatic mode therefore
emits no continuity projection until a real boundary and no per-file receipts
afterward. It also installs no shell policy or mutation firewall. Explicit full
control may emit stricter receipts, target facts, and a graph leaf under its own
separately selected protocol.

Mechanical receipts deliberately bind the result or thrown error observed by
Plan Lattice's guarded `tools/execute` around-dispatch middleware. After that
middleware returns, DSH privately normalizes authored wrapper results; it may
then change model-visible content through `tools/post-execute` policy or a
definition-owned `finalizeContent`. None of those stages can undo an already
potentially attempted side effect. A downstream wrapper may short-circuit and
return without invoking the body, so the receipt proves durable admission plus
an around-dispatch observation, not body invocation. The digest covers only the
stable `isError`, `content`, conditional `error`, and optional `meta` projection;
it excludes `value`, `additionalContexts`, and `concludesTurn`. A thrown pipeline
error is recorded with a total, plugin-owned error projection before the
original value is rethrown; private `HarnessError` metadata therefore belongs
to DSH's later final result, not this receipt. Persisting only from
`tools/result` would instead introduce an unawaitable crash window because rc.7
publishes that frozen outcome through a synchronous observer whose failures are
logged and ignored. Tests cover short-circuiting, DSH normalization,
presentation transformation, and downstream pipeline failure, and verify that
the receipt remains bound to the earlier admission observation.

In native tool mode the exact required `lattice_*` schema must be on the final
wire. When an exact callable `run_code` schema is present, Plan Lattice prefers
that bridge even if a transform also injected the native schema: pure Code Mode
rejects model-direct native dispatch, while Code Mode remains executable in
`both`. The plugin captures DSH's code-only selection from the registry assembly
before cooperative prompt transforms run. A transform cannot remove `run_code`
and substitute an exact native schema, because the registry's executor still
rejects that model-direct call. The runtime snapshot carries only the current
underlying `tools.lattice_*` call and its exact parameter schema. DSH uses the
same turn
`AbortSignal` for prompt assembly and `agent/pre-step`; Plan Lattice uses that
native identity as an early capability handshake, then validates the
deep-frozen request again at `llm/stream`. If a preset suppresses runtime
context, replaces a required schema, or removes the callable transport, the
adapter is not invoked.

### rc.7 final-boundary limits

Two public-seam limits remain and are fail-closed or explicitly bounded rather
than hidden:

1. `SystemPrompt.assemble()` restores an effective `complete` section after
   the `system-prompt/assemble` waterfall returns. A listener can observe the
   pre-restoration assembly or the later request string, but rc.7 exposes no
   event that binds both. Request-attested full Lattice rejects this mismatch;
   automatic mode does not participate in this request-attestation state machine.
   A future
   post-final-assembly event should publish the final `PromptAssembly` with the
   same turn signal.
2. `session-checkpoint-policy` awaits `ctx.sessions.flush()` inside its
   `llm/stream` async iterator. Cordis has no priority or named ordering API and
   rc.7 has no pre-adapter event. Plan Lattice therefore validates once before
   downstream iteration and again immediately before yielding each chunk to the
   AgentLoop. The tested checkpoint-window change is detected before the first
   chunk append. rc.7 still has a smaller non-atomic gap between middleware
   yield and AgentLoop `assistant/chunk` append. A change in that gap can leave a
   stale chunk event. When the admitted chunk is the terminal `finish`, the
   AgentLoop can also assemble and append a complete stale `assistant/message`
   before the plugin has another observation point. Any protected tool calls in
   that message still face the independent `tools` guard before side effects,
   but the message itself is model-visible surface on a later step. Future
   synchronous, AND-composed adapter-dispatch and chunk-admission guards would
   close both gaps without making prompt middleware run twice.

Context-window overflow is a separate native same-step path. The request-error
retry reuses that step's already assembled system string and tool schemas; rc.7
exposes no public operation that can safely rebuild `RuntimeContextProjection`
inside the retry. Plan Lattice therefore never constructs a replacement request.
Likewise, pressure compaction may land downstream of prompt assembly after the
inbox was already claimed. Rejecting that pre-step would durably consume
accepted input, so the plugin preserves DSH's retry decision. An explicitly
controlled stale request is rejected at final request admission; the next
native step rebuilds its explicit-control projection. Automatic mode has no
request guard or tool wire to rebuild.

For an auto native-first same-step retry, rc.7 cannot rebuild a new
`RuntimeContextProjection`. Plan Lattice folds the complete passive basis from
the current append-only Session events, appends it as an ordinary DSH plugin
`user/message`, verifies that exact message reaches the retry's final model
request, and leaves the retry on its original native system and tool wire. This
is a documented same-step limitation; automatic mode does not add a request or
mutation guard. The rc.7
integration tests mount published `@deepseek-ai/dsh-compaction-basic` and
`@deepseek-ai/dsh-token-meter`, force real balanced-prefix replacement, and
cover rejected controlled retries and native-first recovery.

## Compaction And Pruning

`compaction-basic` runs at `agent/pre-step` for pressure and at
`agent/request-error` for context-window overflow. It summarizes a balanced
surface prefix with the current routed request envelope. The optional
`compaction-tool-result-pruner` performs deterministic model-free pruning while
preserving tool-result identity and immutable source events.

Plan Lattice does not rewrite the Session surface. It treats only the native
surface operation `surfaceOp.replace` as continuity invalidation. The nearby
`compaction/summary` and `compaction/prune` events remain useful provenance but
do not prove the model-visible surface changed. After a real replacement,
automatic mode passively restores DSH-native basis once for the new segment;
explicit full-Lattice mode may also revoke its transaction authority and rebuild
its current lineage and exact targets.

## Native Plan And Todo

Plan Mode is durable native collaboration state persisted through `plan/mode`.
DSH alone owns its policy, review flow, transitions, and `exit_plan_mode`. The
approved plan text remains recoverable in the successful `exit_plan_mode` tool
call arguments. After a continuity boundary, automatic mode projects the latest
such approved plan; it does not parse it into nodes, add a second policy section,
or block native Plan Mode. Explicit full-Lattice control may separately enforce
its transaction state without taking ownership of planning.

Native Todo is Session-local, latest-write-wins state from `todo/write`, and is
cleared by the next `turn/start`. Automatic mode folds exactly that lifecycle and
projects the current Todo only while it is still current. It never mirrors Todo
into a long-horizon graph. Explicit full-Lattice mode may have its own graph,
but that graph does not replace native Todo.

## Native Subagent Composition

Plan Lattice never constructs a child prompt, starts or schedules a child, or
delivers child output. Those operations belong to DSH.

The model-facing path is the published rc.7
`@deepseek-ai/dsh-tool-subagent` tool. The parent model's `prompt` argument
becomes the child's first own user message byte-for-byte. Plan Lattice neither
prefixes nor rewrites it. Spawn starts without parent conversation; fork seeds
only completed parent turns and excludes the current delegation turn. In both
cases DSH composes provider, model, limits, cwd, `parentSession`, persona, tool
filter, sandbox, and approval policy.

Automatic mode persists only child, root, and parent Session IDs plus the exact
first-message ID and digest. It copies no prompt text. The child receives a
separately sourced passive runtime-context projection containing the relevant
native authority, approved Plan, current Todo, recent returned child results,
and lineage. Explicit full-Lattice mode may additionally project its assigned
root-to-leaf address and enforce that transaction scope.

Foreground completion is part of the same native lifecycle. The child result
must return to the parent through the matching DSH `tool/result`. Calling
`ctx.subagents.start()` externally and printing its return value does not put
that result in the parent Session and therefore does not test model-facing
delegation continuity.

The retained V18 comparison made exactly that driver error. Native scored 88
with one hard miss; the candidate scored 75 with two hard misses. Although the
candidate used fewer input tokens, V18 is negative evidence and an invalid test
of foreground delegation continuity. It must not be rerun under the same
identity and cannot support an uplift claim.

## Non-Goals

The plugin must not add:

- a custom conversation summarizer or tool-result surface compactor;
- a replacement plan-mode or todo state machine;
- a parallel subagent scheduler, prompt template, or conversation transport;
- model-authored copies of the full human request in every graph node; or
- checkpoints after every tool merely to narrate that the tool ran.

Any future feature that overlaps a native DSH service must first show why the
native lifecycle hook cannot express the required invariant. Otherwise the
correct change is integration or an upstream Harness fix, not another protocol.

The package peers are pinned to exact `0.1.0-rc.7` DSH versions. The integration
uses rc.7 request ordering and a private runtime-snapshot source constant, so a
future RC must be re-audited and tested before widening compatibility.
