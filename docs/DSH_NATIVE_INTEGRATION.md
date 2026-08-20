# DeepSeek Harness Native Integration

This document freezes the architectural boundary used by Plan Lattice against
DeepSeek Harness `dsh-v0.1.0-rc.7` (`99f6f02fec`). The plugin is an extension of
the Harness execution spine, not a second harness.

## First-Principle Boundary

The stable problem is not merely context loss. It is **execution without a
current, authoritative cursor**. Long tasks drift when the model can mutate,
advance, delegate, or stop after the exact requirement, accepted Plan, current
work item, or evidence for that item has disappeared from its effective basis.
Compaction, restart, delegation, and changing requirements are different ways
to create that same invalid state.

Conversation surface is changeable. The immutable root input and the accepted
Plan define what must remain true. The latest native Todo defines the current
execution position. Native tool results define what was actually observed,
changed, and verified. Plan Lattice joins those existing DSH records; it does
not create another planner, scheduler, child protocol, or workspace plan file.

DeepSeek Harness owns model requests, Session append and replay, compaction,
tool-result pruning, Plan Mode and review, Todo projection, subagent creation,
child prompts, scheduling, tool execution, and result delivery.

In default `activationMode: auto`, a routed complex task uses one DSH-native
workflow:

- anchor the exact root-task user-message boundary outside the workspace;
- require an initial native Todo with at least two ordered items and exactly one
  `in_progress` item;
- allow protected mutation only while one valid item is active;
- require verification to start after the latest mutation settles and then
  succeed before that item can complete;
- allow at most the next pending item to become active in the same whole-list
  update;
- require `lattice_refresh_context` before any Todo content, order, or length
  changes, so replan starts from the exact root request and successful native
  `exit_plan_mode` Plan;
- refuse an unchanged completion claim while work or evidence debt remains;
- restore the same task-scoped authority, Todo, and evidence after compaction,
  restart, max-token continuation, and delegation; and
- give a fresh child a separately sourced capsule while preserving its original
  DSH user prompt, scheduling, and result path.

Simple bounded tasks remain true bypass: no policy, no Lattice tool, no guard,
no extra model call, and no `.dsh` workspace state.

Only explicit full-Lattice control owns a durable contract, optional revisioned
root-to-leaf address, pre-action authorization, mechanical attempt receipts,
leases, checkpoints, and mutation invalidation.

## Native RC.7 Failure Surface

The integration is derived from these observed rc.7 mechanics:

| Native mechanism | Long-task consequence | Minimal plugin correction |
| --- | --- | --- |
| `plan/mode` persists only mode state; accepted Plan text lives in successful `exit_plan_mode` arguments | The Plan can disappear from later model context | Recover the exact successful native Plan after the current root-task boundary |
| `todo/write` has no item ID, replaces the whole list, and is last-write-wins | Items can be skipped, renamed, reordered, or declared complete without a legal transition | Validate the whole-list transition against the previous native event fold |
| Native Todo is a UI projection and is not a durable cross-turn execution gate | A later turn can continue or stop without the current item | Fold the latest task-scoped Todo across turns and render it on every controlled step |
| Todo does not bind mutation or verification evidence | A model can complete implementation after only reading, or after a failed command | Bind successful native tool call/result pairs to the active item's activation sequence |
| One assistant step may emit Todo and execution calls together | The model can advance and start the next item before the Todo boundary settles | Reject batches that combine `todo_write` with another tool |
| `agent/turn-stopping` does not inspect Todo | A text completion can abandon unresolved work | Steer once from changed durable state, then close the same unchanged false completion as a native blocked turn |
| Code Mode records nested calls as log-only `tool/code-dispatch-*`, not ordinary `tool/call` / `tool/result` | One `run_code` program can cross Todo and evidence boundaries before its outer result | Guard each nested call globally, fold start/settle pairs as evidence, and forbid mixing `todo_write` with another action in one program |
| Native Todo has only prose `content` and `status` | Event order cannot prove that an edit semantically belongs to the active item | State the limit; require explicit full Lattice when exact path, resource, or host-state binding matters |
| `subagent_fork` seeds only completed parent turns | A child may miss the current root request, Plan, Todo, and evidence debt | Add a read-only root execution capsule without rewriting the child prompt or result channel |
| Continuable `subagent` and background Bash can return before work settles | The parent can verify or advance Todo while a child or shell still mutates the workspace | Require foreground execution in auto workflow mode; unsupported background transports fail before dispatch |
| User-question answers return in `tool/result`, not `user/message` | A changed requirement can be used without invalidating the old Todo | Fold the answer as visible evidence and require authority refresh plus Todo reaffirmation or suffix replacement |
| A new request can follow an all-complete Todo in the same Session | Old Plan, Todo, and evidence can authorize an unrelated task | Close the old task epoch, reroute the new request, and replace the exact authority anchor |
| Surface replacement and cold resume preserve events but may hide their authority from the model | Every later layer can inherit an increasingly lossy summary | Reproject exact task-scoped native records from the append-only Session log |

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
| `systemPrompt.section` | Short native-workflow invariant for complex auto tasks; explicit transaction policy for full Lattice; nothing for bypass |
| `systemPrompt.context` | Current task-scoped Todo/evidence on complex auto steps, exact recovery at a continuity boundary, and contract/root-to-leaf state only in explicit full-Lattice mode |
| `agent/pre-step` | Reconstruct continuity state and diagnose explicit-control assembly incompatibility without discarding claimed input |
| `llm/stream` | Attest explicit full-Lattice/legacy requests; automatic native workflow keeps DSH request construction and relies on independent tool guards |
| `agent/turn-stopping` | Continue unresolved native Todo from changed durable state, close repeated unchanged false completion as blocked, and optionally enqueue bounded next-turn max-token continuation |
| `planMode.get(agent)` | Yield planning-turn ownership to DSH, including its pending next-step state, without implementing a second plan mode |
| `tools/change` plus the scoped tool registry | Revalidate the affected Agent's exact definition identities without treating another Agent's scoped change as local drift or rerunning prompt assembly |
| scoped tool restrictions | Complex auto exposes only `lattice_refresh_context`; bypass is unchanged; explicit modes expose their full protocol |
| tool guard and `tools/execute` middleware | Validate auto Todo transitions and block protected mutation without an active cursor; explicit control additionally binds one-use pre-action authority |
| `tools/result` | Observe DSH's frozen model-visible result for conformance only; it is a non-awaitable notification and therefore cannot be the durable side-effect commit point |
| `session/event` | Fold durable native Plan, Todo, human input, foreground child result, and surface-replacement events |
| Agent registry ownership | Verify ordinary one-shot root-to-child ownership |
| `subagents.registerContinuableSetup` | Use the exported, exact-rc.7 pre-publication setup extension to attest a continuable child's durable parent |

Automatic complex-task control has one short stable policy and one mutable
task-scoped native-workflow projection. It still injects no second Plan Mode,
Todo implementation, compactor, subagent template, scheduler, or result
channel. Explicit full-Lattice policy remains a separate transaction layer.

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

For a bypass task, `activationMode: auto` contributes nothing. For a routed
complex task, the first request already contains the human task as its normal
DSH user message, so Plan Lattice adds only the fixed native-workflow invariant,
the current native Todo/evidence projection, the Todo transition guard, and the
single replan refresh tool. It creates no contract, graph, lease, receipt,
workspace state, replacement Plan Mode, or extra model turn.

The workflow projection is present from the first complex-task step because the
Todo is an execution cursor, not only recovery prose. A durable
`surfaceOp.replace`, cold resume, or fresh delegated child additionally
activates exact authority recovery. `compaction/summary` and
`compaction/prune` remain audit records, not proof that the model-visible surface
changed. Ordinary human follow-ups remain native input and are added to the
same task authority, but after a Todo exists they create persistent replan debt
until an exact refresh and Todo reaffirmation or suffix replacement.
Native user-question answers create the same debt even though rc.7 stores them
as tool results rather than root user messages.

At every controlled step the plugin folds the task-scoped native Todo and
successful evidence across turns. At a continuity boundary it also projects
exact anchored human messages, the latest successful native `exit_plan_mode`
plan after that root-task boundary, recent successful foreground child results
already returned through the parent's `tool/result`, and Session lineage.
`lattice_refresh_context` is required before changing Todo content or order and
after a failed mutation, non-zero command, later root user message, or explicit
blocker. The completed prefix cannot be deleted, renamed, or reordered. The
external anchor stores message IDs and digests rather than prompt text, then
verifies those identities against DSH's log before projection.

The plugin neither constructs a child prompt nor changes native Plan Mode,
Todo, compaction, scheduling, or result delivery. `activationMode: always` and
an explicit full-Lattice request retain the separate eager transaction layer.

### Cursor Continuity, Not Repetition

The full root request and approved Plan are already model-visible during a
stable segment, so they are not repeated after every tool. The compact
Todo/evidence cursor is re-rendered because it is the state required to choose
the next legal action. Exact root authority and Plan are restored only at a
continuity boundary or explicit replan refresh. Automatic mode creates no
per-file receipt or graph checkpoint; unknown capabilities default to mutation.
Code Mode folds `tool/code-dispatch-*` and separates Todo transition programs
from execution programs. Only exact known reader names are observation; unknown
names containing `read`, `grep`, `glob`, or `view` remain mutations. PowerShell
subexpressions/call operators, background Bash, `terminal_send`, `workflow`,
and `ralph` fail closed because their detached lifecycle is not an ordinary
settled action. A continuable rc.7 `subagent` must explicitly set
`run_in_background: false` in auto workflow mode. Explicit full control may add
stricter receipts, target facts, and a graph leaf.

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
native step rebuilds its explicit-control projection. Automatic mode does not
replace that request, but protected tools still face an independent guard.

For an auto complex-task same-step retry, rc.7 cannot rebuild a new
`RuntimeContextProjection`. Plan Lattice folds the complete task-scoped basis from
the current append-only Session events, appends it as an ordinary DSH plugin
`user/message`, verifies that exact message reaches the retry's final model
request, and leaves the retry on its original native system and tool wire. This
is a documented same-step limitation; the independent native-workflow tool
guard remains active. The rc.7
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
automatic mode restores exact root authority while continuing to project its
task-scoped Todo/evidence cursor;
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

Native Todo is Session-local, no-ID, whole-list, latest-write-wins state from
`todo/write`; DSH's ordinary UI projection clears at the next `turn/start`.
For a routed complex task, automatic mode folds the latest Todo after the exact
root-task boundary across turns and validates every later whole-list transition.
This remains the native Todo event stream, not a mirrored workspace graph.
Explicit full-Lattice mode may separately have a persistent graph, but that
graph does not replace native Todo.

The ordinary DSH UI projection still clears Todo at `turn/start`; the guard's
cross-turn projection intentionally does not. It replays the same native
`todo/write` events from the current root-task epoch. Once every item is
complete, a later root request opens a fresh epoch, replaces the authority
anchor, reroutes independently, and starts with no old Plan, Todo, or evidence.

Because the native item has no structured scope or acceptance field, the auto
gate does not claim semantic target binding. It proves ordering and evidence
timing only. A task requiring exact artifact or external-resource ownership must
select explicit full Lattice rather than relying on text matching.

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
first-message ID and digest. It does not rewrite the child user message. The
child receives a separately sourced execution capsule containing exact root
authority, the task-scoped approved Plan, current root Todo, evidence debt, and
lineage. The child cannot edit the root Todo or ask the human; missing boundaries
return through DSH's native result channel. Explicit full-Lattice mode may
additionally project its assigned root-to-leaf address.

Foreground completion is part of the same native lifecycle. The child result
must return to the parent through the matching DSH `tool/result`. Calling
`ctx.subagents.start()` externally and printing its return value does not put
that result in the parent Session and therefore does not test model-facing
delegation continuity.

In rc.7 continuable mode the model-facing `subagent` defaults to background
execution when `run_in_background` is omitted. Auto workflow control therefore
requires the explicit value `false`; otherwise the guard rejects the call
before DSH creates the child. This preserves DSH's prompt and result channel
while making settlement observable before Todo verification or advancement.

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
