# DeepSeek Harness Native Integration

This document freezes the architectural boundary used by Plan Lattice against
DeepSeek Harness `dsh-v0.1.0-rc.7` (`99f6f02fec`). The plugin is an extension of
the Harness execution spine, not a second harness.

## First-Principle Boundary

The stable problem is loss of execution authority across lossy context
transitions. Conversation text, summaries, tool output, implementation plans,
and delegation prompts are changeable representations. Human authority, the
accepted outcome, current contract revision, current plan address, and exact
pre-action facts are the state that must remain reconstructable.

Therefore Plan Lattice owns only:

- binding human Session authority to a durable execution contract;
- a revisioned root-to-leaf execution address and semantic acceptance evidence;
- pre-action authorization bound to exact targets and host preconditions;
- mechanical attempt receipts needed to prevent unsafe crash replay; and
- invalidating old authorization at native history, input, delegation, and
  lifecycle boundaries.

DeepSeek Harness continues to own model requests, conversation history,
compaction, tool-result pruning, plan collaboration mode, todo projection,
subagent creation, child prompts, policy inheritance, and scheduling.

## Model Request Spine

The native loop assembles the system prompt, dynamic contexts, and tool schemas
once at each `agent/pre-step` boundary. It appends any changed runtime-context
snapshot as a sourced user message. Repeated model/tool cycles inside that step
reuse the same system prompt and tool schemas while deriving the current Session
messages again before every request.

Plan Lattice integrates at the existing seams:

| Native seam | Plan Lattice use |
| --- | --- |
| `agent/inbox/inserted` | Zero-model-call first-message routing and immediate authority invalidation; observation is synchronous and never rejects an already-accepted inbox splice |
| `systemPrompt.section` | Stable control rules for the selected tier |
| `systemPrompt.context` | Mutable contract revision, root-to-leaf execution path, acceptance, unknowns, and reframe state |
| `agent/pre-step` | Diagnose assembly incompatibility, confirm deferred one-shot lifecycle evidence, and re-project mutable context when native pressure compaction lands after assembly |
| `llm/stream` | Attest the deep-frozen AgentLoop request before downstream work and before accepting every returned chunk |
| `planMode.get(agent)` | Yield planning-turn ownership to DSH, including its pending next-step state, without implementing a second plan mode |
| `tools/change` plus the scoped tool registry | Revalidate the affected Agent's exact definition identities without treating another Agent's scoped change as local drift or rerunning prompt assembly |
| scoped tool restrictions | Show only tools valid for the current control phase |
| tool guard and `tools/execute` middleware | Bind and consume exact pre-action authority; record the side-effect around-dispatch observation before private registry normalization and presentation transforms |
| `tools/result` | Observe DSH's frozen model-visible result for conformance only; it is a non-awaitable notification and therefore cannot be the durable side-effect commit point |
| `session/event` | Observe durable user input and native surface replacement |
| Agent registry ownership | Verify ordinary one-shot root-to-child ownership |
| `subagents.registerContinuableSetup` | Use the exported, exact-rc.7 pre-publication setup extension to attest a continuable child's durable parent |

Mutable execution state is deliberately absent from the permanent policy
section. This preserves DSH's prompt/cache structure and lets its runtime-context
projection create a superseding, attributable Session snapshot.

The permanent Plan Lattice policy is intentionally small. It says only which
side owns which mechanism and that protected mutation authority must be
reconstructed from the current basis. It does not repeatedly inject a planning
method, a summary of the user request, or a second subagent template. Those are
either durable data rendered through the native runtime-context channel or
native DSH behavior. This keeps the plugin from competing with DSH plan mode,
todo guidance, compaction prompts, and child composition for the same model
attention budget.

### First-turn minimalism

For an unambiguous, question-free Lattice task, the first native request already
contains the human task as its normal DSH user message. Plan Lattice must not
make the model spend that request calling `lattice_open`, rendering a synthetic
tree, refreshing context, or checking out a leaf before it can inspect the
repository. Those are representations of authority, not the authority itself;
front-loading them wastes the first execution turn and can turn a clear build
task into a planning loop.

The initial policy therefore contains only the ownership boundary and the
protected-write rule. It exposes `lattice_open` as the one available escape
hatch, but does not require it until a protected mutation is about to happen.
Read-only repository work remains fully native. At that boundary the controller
binds the durable contract and controller-owned root/leaf, then the existing
fresh-basis, lease, receipt, and checkpoint rules apply. Critical or always
clarification policies remain different: an outcome-critical missing decision
must be answered and bound before execution authority exists.

This is deliberately not a relaxation of the mutation firewall. It moves no
durable claim into model memory and does not construct a child prompt, change
the native plan, or replace compaction. The plugin continues to rebuild the
complete accepted contract, current root-to-leaf address, and exact target
facts after compaction, resume, handoff, or a material change, immediately
before any protected side effect.

### Continuity, Not Repetition

The current native DSH user message is already model-visible during a stable
turn. Re-rendering its full durable contract after every inspected file or tool
result does not add authority; it duplicates tokens and competes with the
actual implementation. Plan Lattice consequently emits only an incremental
receipt, current leaf, and exact target facts during an unchanged native
conversation. It restores the complete contract and immutable authority only
when DSH has crossed a continuity boundary: a surface replacement from
compaction or pruning, process/session resume, native child delegation, or an
accepted material reframe. Each protected mutation remains blocked until that
fresh basis exists.

This is a state rule rather than a token heuristic. The native Session log and
DSH surface stay authoritative; the plugin records that a complete projection
was visible and clears that projection on replacement. A contract written to
disk cannot silently make a stale model turn authoritative, and a stable model
turn is not repeatedly burdened with text that DSH is already carrying.

The initial native exploration path admits a deliberately narrow positive
subset of Bash inspection (`pwd`, `ls`, `cat`, `head`, `tail`, `rg`, and
`grep`, optionally joined with `&&`). It rejects quoting, interpolation,
redirection, pipes, unknown programs, and `rg --pre`, whose preprocessor can
execute a command. Everything else stays on the protected path. This is not a
second shell policy; it preserves DSH's normal read-only reconnaissance while
the mutation firewall fails closed.

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
   event that binds both. Active Plan Lattice rejects this mismatch. A future
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

Context-window overflow is a separate native same-step path. When downstream
DSH recovery returns `retry` after `Session.surface.replaceGeneration`
advances, Plan Lattice rejects pending human/reframe authority, rebuilds the
same-signal attestation, and appends a fresh sourced runtime snapshot before the
loop derives its retry messages. It does not run another pre-step or replace
DSH compaction. The rc.7 integration test mounts the published
`@deepseek-ai/dsh-compaction-basic` and `@deepseek-ai/dsh-token-meter`, forces a
real balanced-prefix summary and replacement, and verifies that the retry stays
inside one native step.

## Compaction And Pruning

`compaction-basic` runs at `agent/pre-step` for pressure and at
`agent/request-error` for context-window overflow. It summarizes a balanced
surface prefix with the current routed request envelope. The optional
`compaction-tool-result-pruner` performs deterministic model-free pruning while
preserving tool-result identity and immutable source events.

Plan Lattice does not rewrite the Session surface. It treats native
`compaction/summary`, `compaction/prune`, and replacement surface operations as
authorization invalidation. A later mutation must obtain a new
`lattice_refresh_context` basis from the complete contract, current lineage, and
exact targets.

## Native Plan And Todo

Plan mode is durable collaboration state folded from `plan/mode` events. Its
guidance is the native `plan:policy` section, and mode changes commit on an
accepted pre-step. It is not an execution receipt and does not authorize a
mutation. Plan Lattice reads the public `{ active, pending? }` service value and
uses `pending ?? active`, matching the state DSH uses for the proposed next
step. The tool guard separately uses logged `active`, because an approved
`exit_plan_mode` intentionally leaves the current assistant tool batch in plan
mode and queues `pending: false` for the next accepted pre-step. While that
logged mode owns the batch, DSH alone owns the required model action: the agent
plans and finishes through `exit_plan_mode`; Plan Lattice adds only read-only
contract and leaf context. A monotonic tool guard rejects all `lattice_*` calls
and configured guarded mutations without hiding `exit_plan_mode` or changing
DSH's stable tool catalog. Crossing either mode boundary revokes old mutation
bases and clean leases, so an approved plan does not inherit execution
authority prepared before planning.

`todo_write` is a last-write-wins, per-session current-work projection that is
cleared at the next turn. Plan Lattice leaves it visible. A model may use it for
the immediate working set, but it is neither required nor synchronized with the
long-horizon graph and cannot satisfy contract acceptance.

## Native Subagent Composition

Plan Lattice never constructs a child prompt or starts a child itself.

The model-facing path is deliberately tested through the published rc.7
`@deepseek-ai/dsh-tool-subagent` plugin, not only through the lower-level
subagent service. The parent model's `prompt` argument becomes the child's
first own user message byte-for-byte. Plan Lattice neither prefixes nor rewrites
that message. Its contribution arrives independently through the child's
ordinary scoped `systemPrompt.context` assembly: root contract, the frozen
root-to-leaf execution path captured at handoff, leaf acceptance, unknowns, and
contract/graph revisions. This preserves each provider's native context
semantics while preventing a fresh child from having to reconstruct durable
authority or its parent milestones from the parent's prose.

- Fork seeds all completed parent turns and excludes the in-flight delegation
  turn. The delegation task is then a normal child user message.
- Spawn starts with no parent conversation. Its delegation task must be
  self-contained and becomes a normal child user message.
- Both resolve the child's provider, model, token limit, depth, cwd, durable
  `parentSession`, persona, tool filter, sandbox override, and approval policy
  through the shared child composition.
- DSH represents the initial delegated task as the fresh child's first own
  user-role message. Before the child id is returned, spawn, fork, and
  continuable delivery all admit that message through the native inbox. Plan
  Lattice requires the exact live ownership edge or continuable setup binding,
  a `local: true` native `subagent/start` edge bound to its exact run id and
  provider, the child's first authoritative durable descriptor parsed by DSH,
  and no earlier non-plugin input after `seedLength`. Remote provider ids are
  parent-scoped and can never authenticate a same-named local Session.
  Continuable creation has the
  descriptor before inbox delivery. One-shot spawn/fork accepts the message
  first and appends the descriptor in its first `agent/pre-step`, so the plugin
  temporarily blocks protected work and confirms both facts after the downstream
  native lifecycle runs. A later user-role message follows the normal
  input-review/reframe path.
- Continuable children persist a descriptor, use the same child composition on
  cold resume, and accept later coordinator messages as ordinary FIFO turns.
  Their process-local owner is the continuation manager's private activation
  scope, not the durable direct parent Agent.
- DSH contributes the child delegation-scope runtime context and any scoped
  report tool. Plan Lattice contributes its execution-state runtime context
  through the same scoped prompt registry.

The V7 native-child lifecycle smoke runs this path against the frozen official
rc.7 headless runtime and a deterministic loopback DeepSeek-compatible stream.
It exercises both native and installed-Lattice profiles. The runner takes the
`subagents` service from the plugin's injected host context, not from
`parent.ctx`: an Agent scoped context does not automatically acquire a plugin's
service injection. It flushes the child session and captures its terminal
reason before `run.dispose()` releases that one-shot child from the live Session
store. The captured wire request must contain the delegated task exactly once
and must not contain the parent task. This is lifecycle conformance evidence,
not a quality benchmark or a substitute for a real-model outcome evaluation.

The conformance test also proves that a spawn child's model request contains one
native user message with exactly the delegated task, no copied parent
conversation, plus a separately sourced DSH runtime snapshot carrying the
assigned root-to-leaf path and leaf acceptance. A fork remains free to inherit its balanced completed-turn prefix
because that behavior belongs to the provider, not this plugin.

When the parent had an active leaf at the native handoff, that leaf is also an
enforced child execution scope. The child may refresh, check out, and checkpoint
only that exact leaf; topology-editing tools are removed from its scoped catalog,
and a refresh for a neighboring or later-changed leaf fails before it can mint a
fresh mutation basis. This is deliberately not a rewrite of the delegated task:
DSH still owns the child message, while Plan Lattice makes the separately
projected execution address mechanically meaningful.

For ordinary one-shot children, the plugin accepts inheritance only when durable
`parentSession` metadata and the live Agent registry ownership graph agree. For
continuable children, it uses DSH's exported, exact-rc.7 pre-publication setup
extension and binds the exact live durable parent before `agent/created` can
publish the child. The callback context is intentionally pre-publication, but
the service method is a version-pinned published API. Header metadata alone is rejected in both cases. The
inherited value is an execution address, not mutation authority. Every
protected child action still requires a fresh child-owned basis and a valid root
contract; revoking the continuable setup installation immediately revokes that
edge.

rc.7 does not expose the accepted initial delegation `messageId` on
`subagent/start`, and both initial delegation and direct human input use
`source.kind: user`. The combined lifecycle test above is the strongest public
proof available, but it is not exact per-message provenance. The upstream fix is
to publish a dedicated coordinator/delegation source or persist the initial
`messageId` and phase. Until then, a message that lacks the complete combined
evidence fails closed; documentation and evaluation must retain this rc.7
limitation.

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
