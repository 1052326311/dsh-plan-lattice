# Plan Lattice First Principle

## Control Domain

The default plugin solves a narrower problem than a second planner or mutation
controller: **DSH may preserve the authoritative execution basis in its durable
Session while no longer exposing that basis to the next model request**. This
can happen after replacement compaction, a cold resume of replaced history, or
delegation into a fresh child Session. Automatic mode restores DSH-native basis
at those boundaries and otherwise stays absent.

DeepSeek Harness owns Session append and replay, compaction, Plan Mode, Todo,
subagent prompt construction, scheduling, tool execution, and result delivery.
Plan Lattice must not replace those mechanisms. Its automatic claim is:

> After a native continuity boundary, the next model request should recover the
> relevant execution basis already recorded by DSH without translating it into
> a second contract or plan.

Explicit full-Lattice control has a separate, stronger mutation-safety claim:

> A guarded mutation is valid only when it is authorized from a complete,
> current intent-and-fact basis.

For a mutation `m` at time `t` under explicit full control:

```text
valid(m, t)
  = accepted-contract(t)
  and adopted-human-input-frontier(t)
  and selected-control-address(t)
  and current-action-facts(t)
  and authoritative-basis(t)

drift(m, t)
  = executed(m, t) and not valid(m, t)
```

This is not a law about every model error, every task, or the world. Automatic
mode does not enforce this predicate. A model can
misimplement a complete and current plan, a grader can be wrong, and an
unprotected process can mutate state outside this controller. Tests, reviews,
sandboxes, approval policy, and host concurrency controls remain necessary.

For an ordered sequence of explicitly protected mutations `m1 ... mn`, if execution drift
as defined above occurs, there is a least index `i` for which `mi` executes from
a basis that is incomplete, stale, or not authoritative. That `mi` is the first
drifting mutation. The claim is exhaustive only for this defined failure class:
compaction, forgetting, delegation, parallel work, delayed feedback,
requirement change, and direct state edits matter when they create that invalid
basis before a later protected mutation. A mechanism that never invalidates a
later action basis is not, by itself, execution drift.

## Explicit Current Action Basis

When full control is selected, every protected action is authorized by one
joined, versioned basis:

```text
current-action-basis
  = accepted contract revision
  + exact adopted human-input frontier
  + selected control address, if the operator enabled a plugin graph
  + exact target state
  + required prior proof, if the selected tier records semantic checkpoints
  + host-observable external preconditions
```

A summary, inherited message, durable `parentSession` value, model memory, or
earlier tool result may help locate this basis, but never substitutes for it.
Delegation authority additionally requires the Harness's live ownership edge.
The authorization check is an equality test against current state, not a
request for the model to remember what used to be true.

This yields one mechanical rule for explicit control:

```text
permit(action, receipt, now)
  iff receipt is unused
  and receipt.contract == now.contract
  and receipt.inputFrontier == now.inputFrontier
  and receipt.controlAddress == now.controlAddress
  and receipt.targets == now.targets
  and receipt.priorProof == complete
  and receipt.externalPreconditions == now.externalPreconditions
```

Any inequality revokes the receipt before the action. The action attempt then
consumes the receipt whether the underlying tool succeeds or fails.

## One Explicit Authorization Epoch

The explicit controller represents the joined basis as one authorization epoch,
not independent contract, target, and lifecycle flags. One epoch binds:

- accepted contract identity, revision, and document digest;
- the exact durable human-message sequence adopted by that contract;
- durable graph revision, root-to-leaf digest, and focused structural
  neighborhood only in explicit full-Lattice mode;
- the aggregate digest of every declared artifact target;
- whether prior protected work still requires evidence; and
- adapter-provided state plus either exact action arguments or a current
  observable scope for one later normalized external action; and
- the process-lifetime identity of the trusted global guarded-tool definition
  and its `execute` implementation.

Every protected attempt consumes the epoch before semantic validation or tool
dispatch. A rejected plan edit therefore cannot reuse its receipt, and a tool
that throws cannot be assumed side-effect free. A surface replacement, resume,
reframe, plan mutation, handoff, disposal, or concurrent durable revision
change invalidates the whole epoch. The next mutation must reconstruct it from
the contract, exact action facts, and any explicitly selected graph address; no
component can remain valid on its own.

For artifact tools, the guard turns the consumed epoch into a call-identity-bound
prepared dispatch. The Harness dispatch stage rechecks the session, tool,
arguments, contract, optional graph address, targets, and host preconditions, then makes the
identity fields non-replaceable. Its signal remains replaceable only through an
accessor that always composes the replacement with the epoch revocation signal.
If user input or another supported lifecycle event invalidates authority while a
later asynchronous middleware is waiting, Harness observes an aborted signal
before entering the tool body.

A scope snapshot moves action choice after observation without moving trust.
The host defines and rechecks the observable resource; the model chooses the
exact action only after that read; the guard normalizes the chosen arguments,
rejects unsupported execution metadata, consumes the epoch, and locks the full
call identity before dispatch. An explicit action snapshot suppresses scope
authority for that tool. Thus scope authorization removes duplicated command
text from the context receipt without authorizing a changed workspace, changed
resource, or changed dispatch.

The first observed global definition for each guarded tool becomes a
process-lifetime trust anchor and its `execute` property is identity-locked.
A scoped same-name definition, a later global replacement, or a registry change
between guard and body cannot inherit that trust. Plan Lattice also locks the
name and arguments of every call at its first around-dispatch boundary,
including initially unguarded calls, so downstream middleware cannot upgrade a
no-op into a guarded mutation after the guard has run.

This is the mechanical form of the opt-in transaction layer. It is not the
default continuity mechanism. Automatic mode performs no equality gate at tool
dispatch and creates no contract, tree address, receipt, lease, or guard.

## Constant, Change, And Direction

The constants are temporary execution invariants, not timeless truths. The
current accepted contract revision fixes:

- desired observable outcome and system boundary;
- scope and exclusions;
- authority and source of truth;
- invariants and accepted decisions; and
- acceptance criteria.

The changeable state includes:

- discovered facts and assumptions;
- DSH's native plan and Todo projection, plus graph revisions and nodes only
  when the operator explicitly enables full Lattice;
- declared mutation targets, repository files, and runtime state;
- observable external state;
- tools, executors, and handoffs; and
- the concrete implementation strategy.

Directional forces describe where change appears to be moving: requirement
volatility, repeated stage feedback, external trends, or increasing execution
scope. A force can influence routing, risk, and what should be observed next,
but it is neither a confirmed fact nor an accepted decision. **A trend never
authorizes a mutation.** Only an observed current basis can do that.

Context replacement, stage output, external truth changes, human reframing,
handoff, parallel execution, delayed verification, and direct plan or artifact
edits are concrete invalidation events. They are not separate root causes; each
can make a once-valid basis stop being current.

In automatic mode, later root human messages remain ordinary DSH input and are
added to the immutable authority anchor without a model-authored review or
contract translation. In explicit full control, inbox insertion and durable
`user/message` append are separate invalidation points. After an explicit
contract exists, every new human message is unadopted regardless of wording and
must follow that mode's review or reframe protocol. Delegated sessions under
explicit transaction control must also re-prove the live Harness ownership
chain; durable `parentSession` metadata is only an address.

When a supposed constant changes under explicit full control, the prior
contract is no longer authoritative and must be reframed. When changeable state
changes, the next guarded mutation must re-enter the accepted contract, then
bind to the new current action facts and the optional explicit graph address.
DSH retains ownership of its current plan in every mode; the plugin neither
copies nor parses that plan into a competing state machine.
For filesystem tools this means the exact target body or a
digest-bound missing state. For external side effects it requires a host
integration that can expose the relevant preconditions; a generic shell string
cannot prove them.

## Derived Operating Modes

The ownership boundary yields three operator-visible modes:

- `off`: Plan Lattice contributes nothing.
- `auto`: DSH remains the sole planner and executor. Before a continuity
  boundary the model-facing path is native. After replacement compaction, cold
  resume of replaced history, or delegation, the plugin passively re-projects
  DSH-native execution basis. It exposes no tools, blocks no tools, writes no
  workspace `.dsh` state, and requires no intake, refresh, reframe, checkpoint,
  lease, receipt, or graph operation.
- `always`: the operator explicitly enables the contract, graph, mutation
  basis, crash-safety, and semantic checkpoint protocol. A direct request to
  `use full Plan Lattice` and resumed legacy graph state select the same explicit
  family.

Task length, file count, issue severity, framework names, and requirement
ambiguity do not justify silently replacing DSH's control plane. They may inform
an operator's explicit choice, but automatic activation is driven only by an
observed native continuity boundary. The causal chain is:

```text
DSH-native execution basis
-> model-visible continuity loss
-> later model request
-> passive reconstruction from durable DSH events
```

The stricter stale-mutation chain and enforcement gate belong only to explicit
full control.

## Mutation Protocol

Default auto mode has no Plan Lattice plan or mutation protocol. DSH owns Plan
Mode, Todo, compaction, child prompts, scheduling, tool execution, and result
delivery. At a real continuity boundary, the plugin emits a scoped runtime
projection built from exact durable DSH events. No `lattice_*` tool is exposed
or called, no contract is created, and no mutation is authorized or blocked by
the plugin.

Explicit full-Lattice plan mutations and artifact mutations apply the same
principle at different boundaries.

Before adding, splitting, updating, archiving, or checking out a node, the
agent must use a one-action receipt created by rereading every contract
document and the exact current plan neighborhood that authorizes that
structural change. The structural mutation consumes that receipt and advances
the graph revision. A node that was not present in that rendered plan view
cannot be changed from memory.

Reframing changes the meaning against which plan nodes were written. Every
unfinished node is therefore marked `reconciliationRequired`; retaining its
text preserves history but grants no execution authority. A node created after
the reframe is bound to the new contract revision and digest. An older node is
rebound only by an explicit `lattice_update` after its current neighborhood and
complete contract are read together. Checkout rejects a leaf when any node in
its root-to-leaf lineage remains unreconciled. Archiving a stale leaf remains
available because removing an obsolete path is not executing it.

Explicit contract and full-Lattice control deliberately impose a stricter
artifact basis. Before editing an artifact in those modes, the agent must reread:

1. the complete accepted contract;
2. the current leaf and its full root-to-leaf plan only in explicit full-Lattice
   mode; and
3. the exact current body of every declared target, or its digest-bound missing
   state.

The artifact mutation consumes that explicit basis even when the tool attempt
fails. Default automatic mode has no per-file receipt or segment authority: DSH
owns all mutations. Explicit control invalidates its own authority on protected
attempts, replacement, resume, reframe, structural plan change, handoff, agent
disposal, external target changes, and concurrent graph revision.

Execution audit and semantic proof are different kinds of state. The explicit
controller records an exact mechanical receipt for each settled guarded
attempt, binding its call, tool, arguments, authorization basis, outcome, and
result digest at Plan Lattice's guarded `tools/execute` around-dispatch
boundary. DSH's later private result normalization, `tools/post-execute` policy,
and definition-owned `finalizeContent` may change the model-visible outcome but
cannot undo a potentially attempted side effect, so they are not part of this
mechanical identity. A wrapper may return without invoking the body; the receipt
therefore proves durable admission and an around-dispatch observation, not body
execution. Its result digest is limited to stable error state, content, error,
and metadata fields. It cannot prove that a requirement is satisfied. Only a semantic
checkpoint may record verified acceptance evidence or complete a leaf. Keeping
the two ledgers separate prevents a successful command from being promoted into
product correctness merely because it ran. Lease-release intent is durable too:
when authority is revoked during an attempt, restart recovery must settle the
exact receipt and release in one transition, while an I/O failure keeps both the
marker and lease observable for retry.

Large command payloads, patches, heredocs, and exploratory reasoning are
ephemeral execution form, not durable semantic memory. Their retention and
surface replacement belong to DSH's native compaction and tool-result-pruning
services, which preserve event provenance and request replay invariants. Plan
Lattice must not duplicate that state machine. It observes a native
`surfaceOp.replace` as a model-visible continuity boundary. Automatic mode then
reconstructs the relevant DSH-native basis once for the new segment; explicit
full-Lattice mode may additionally revoke transaction authority and reconstruct
exact current targets and its root-to-leaf address. Summary and prune log
records alone do not prove replacement.

When explicitly enabled, the recursive tree is not a longer Todo list, a copy
of the whole contract, or authority by itself. It is a persistent address. At native child
handoff, the current root-to-leaf path is projected through DSH's scoped runtime
context while the parent-provided delegation message remains byte-for-byte
unchanged. This gives a fresh child its bounded purpose chain without forging a
second prompt or copying a parent conversation. After compaction, pruning,
resume, or handoff, that address tells the executing session which complete
accepted contract and authoritative root-to-leaf plan must be reread before the
next protected mutation. Adding or editing a branch starts from that durable
definition; editing an artifact additionally reads the exact target body. A
summary, model memory, inherited message, or `parentSession` may help
navigate to the basis, but none grants mutation authority. No layer in a
compaction or delegation chain inherits authorization from the previous layer's
summary.

Continuity state must travel through the Harness's real control plane. In
automatic mode there is no Plan Lattice policy section or callable tool
transport; one scoped runtime-context projection restores DSH-native state after
a boundary. In explicit mode, stable transaction rules belong in DSH
system-prompt sections and mutable contract state plus optional graph addresses
belong in DSH runtime-context snapshots. The native AgentLoop always owns
message replay, compaction, Plan Mode, Todo, tool presentation, child prompt
delivery, scheduling, and result return.

The control section must remain a boundary declaration, not an ever-growing
instruction manual. Constants/change/direction are useful design vocabulary for
the durable contract and route classifier, but restating that vocabulary on
every model step cannot make it authoritative. The host supplies its own plan,
Todo, compaction, and delegation guidance. Automatic mode contributes only
immutable message-identity anchors and a short native continuity projection.
Explicit mode may additionally contribute a contract, graph address, and
guarded-action rule. This distinction keeps a compatibility layer from becoming
a competing agent framework.

That proof must stop where the host's public control plane stops. In DSH rc.7,
an effective `complete` persona is restored after the public
`system-prompt/assemble` waterfall, and `LlmRuntime` exposes no
load-order-independent hook between the final frozen AgentLoop request and
`adapter.stream()`. Active control therefore fails closed for complete personas,
while asynchronous downstream changes are rechecked immediately before each
returned model chunk is yielded. rc.7 does not make that middleware check and
the later AgentLoop append atomic; a racing stale chunk event cannot become a
protected side effect because every guarded tool call is rebound independently.
However, a stale terminal `finish` chunk can let AgentLoop append a complete
stale assistant message, which may re-enter model surface on a later native
step. Eliminating that message and preventing the adapter request itself require
upstream dispatch and admission guards. The plugin must not fill either missing seam with its own prompt builder,
adapter dispatcher, or child transport; those are upstream Harness
extension-point requirements.

Native Plan Mode is another representation boundary, not a plugin-owned state
machine. DSH keeps exclusive ownership of planning, review, and
`exit_plan_mode`. Automatic mode may recover the latest successfully approved
plan from its native tool-call arguments after continuity loss, without copying
it into a contract or graph. Explicit mode may compare that plan with its own
transaction invariants, but must not replace the native collaboration flow.

Delegation follows the same rule. DSH creates the child, preserves the
model-authored `subagent.prompt` as the child's first user message, schedules the
child, and returns foreground output through the parent's native `tool/result`.
Automatic mode anchors the exact first-message ID and digest plus Session
lineage; it never prefixes, rewrites, or replaces that prompt. Explicit mode may
add transaction-scope checks through separately sourced runtime context.

If an explicit full-Lattice parent hands off an active leaf, the child receives that leaf as a
durable execution address through DSH's ordinary scoped runtime context. It is
not merely a reminder in the delegated prose: the child cannot mint a basis for
a sibling, structurally edit the shared graph, or continue after the assigned
leaf's title or acceptance criterion changes. The parent remains the planner;
the child is a bounded executor that must return a changed branch for the
parent to reconcile. This avoids asking a fresh child to infer its scope from a
compacted or incomplete parent conversation.

## Transaction Boundary

Plan Lattice performs an authorization check and then dispatches a protected
tool. That check and an artifact write are not a transaction with unrelated
processes. Another process can change a file after its digest is verified but
before or during the tool body; the plugin cannot atomically serialize, roll
back, or isolate that cross-process write. The next authorization can detect the
new state, but detection does not undo an already raced side effect.

Deployments that require cross-process write isolation must provide it below
the plugin through workspace ownership, OS sandboxing, file locks, atomic
replace protocols, or a transactional storage API. External side effects
likewise need host adapters with suitable idempotency or transaction semantics.

Within one Harness process, registered plugins and tool implementations remain
part of the trusted computing base. Plan Lattice pins the first accepted global
guarded definition, rejects scoped shadows and later registry replacements, and
revokes active dispatches on supported `tools/change` events. It is not an OS
sandbox: arbitrary same-process code that bypasses the registry, writes files
directly, or mutates private memory is outside this controller and must be
isolated by the host.

## Activation Versus Enforcement

Automatic activation and explicit enforcement answer different questions:

- automatic activation asks whether DSH has crossed a native continuity
  boundary that removed relevant basis from model-visible history;
- explicit enforcement asks whether one guarded action is authorized now.

The automatic path observes Session events rather than predicting task
complexity. It activates a passive projection only after replacement
compaction, cold resume of replaced history, or delegation. Explicit full
control separately observes contract revisions, optional graph revisions,
leases, declared target digests, and host preconditions, then invalidates its
receipts mechanically. This separation avoids imposing a second work graph on
DSH-native execution.

## Scope And Falsifiability

The existence of a first drifting mutation is a definition plus the ordering of
a finite execution, not an empirical discovery. A failure whose protected
mutations all used a complete, current, authoritative basis is outside this
invariant and must not be cited as evidence for it.

The automatic continuity design is falsified when it changes native behavior
before a boundary, loses required native basis after a boundary, rewrites a
child prompt, bypasses the parent's normal foreground `tool/result`, or exposes
Lattice tools and guards without explicit full control. The explicit
enforcement design is falsified when it authorizes an in-scope guarded mutation
without its configured basis.

External task evaluation separately tests whether either mechanism improves
outcomes enough to justify its cost. V18 is a retained negative result: the
candidate scored below native and the driver did not use the model-facing
foreground subagent result path. It cannot support an uplift claim and must not
be rerun under the same identity. No effect size, ranking, or universal benefit
follows from the invariant itself.
