# Plan Lattice First Principle

## Control Domain

Plan Lattice controls long-running autonomous execution episodes in which one
or more actions may mutate an artifact, persistent state, or another protected
system, and the action basis may change between mutations. Its root claim is
strictly scoped to **execution drift in that controlled domain**:

> A mutation is valid only when it is authorized from a complete, current
> intent-and-fact basis.

For a mutation `m` at time `t`:

```text
valid(m, t)
  = accepted-contract(t)
  and adopted-human-input-frontier(t)
  and current-root-to-leaf-plan(t)
  and current-action-facts(t)
  and authoritative-basis(t)

drift(m, t)
  = executed(m, t) and not valid(m, t)
```

This is not a law about every model error, every task, or the world. A model can
misimplement a complete and current plan, a grader can be wrong, and an
unprotected process can mutate state outside this controller. Tests, reviews,
sandboxes, approval policy, and host concurrency controls remain necessary.

For an ordered sequence of protected mutations `m1 ... mn`, if execution drift
as defined above occurs, there is a least index `i` for which `mi` executes from
a basis that is incomplete, stale, or not authoritative. That `mi` is the first
drifting mutation. The claim is exhaustive only for this defined failure class:
compaction, forgetting, delegation, parallel work, delayed feedback,
requirement change, and direct state edits matter when they create that invalid
basis before a later protected mutation. A mechanism that never invalidates a
later action basis is not, by itself, execution drift.

## Current Action Basis

Every protected action is authorized by one joined, versioned basis:

```text
current-action-basis
  = accepted contract revision
  + exact adopted human-input frontier
  + current plan revision and root-to-leaf address
  + exact target state
  + required prior proof
  + host-observable external preconditions
```

A summary, inherited message, durable `parentSession` value, model memory, or
earlier tool result may help locate this basis, but never substitutes for it.
Delegation authority additionally requires the Harness's live ownership edge.
The authorization check is an equality test against current state, not a
request for the model to remember what used to be true.

This yields one mechanical rule:

```text
permit(action, receipt, now)
  iff receipt is unused
  and receipt.contract == now.contract
  and receipt.inputFrontier == now.inputFrontier
  and receipt.plan == now.plan
  and receipt.targets == now.targets
  and receipt.priorProof == complete
  and receipt.externalPreconditions == now.externalPreconditions
```

Any inequality revokes the receipt before the action. The action attempt then
consumes the receipt whether the underlying tool succeeds or fails.

## One Authorization Epoch

The implementation represents the joined basis as one authorization epoch,
not independent contract, plan, target, and lifecycle flags. One epoch binds:

- accepted contract identity, revision, and document digest;
- the exact durable human-message sequence adopted by that contract;
- durable graph revision and the current root-to-leaf digest;
- the focused structural neighborhood for a plan mutation;
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
the contract and tree; no component can remain valid on its own.

For artifact tools, the guard turns the consumed epoch into a call-identity-bound
prepared dispatch. The Harness dispatch stage rechecks the session, tool,
arguments, contract, plan, targets, and host preconditions, then makes the
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

This is the mechanical form of the root cause: the invalidation mechanisms
covered by the controller terminate at one equality check, while the accepted
contract and current tree address are the path by which complete intent is
recovered after supported context-replacement events.

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
- graph revisions, nodes, and the authoritative root-to-leaf plan;
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

Inbox insertion and durable `user/message` append are separate invalidation
points. The append is never suppressed merely because the same message was
previously observed in the inbox: authority reconstructed while a message was
queued cannot survive that message becoming model-visible. After a contract
exists, every new human message is unadopted regardless of wording. The root
agent must read that exact durable message sequence with the complete accepted
contract, then commit either `contract-unchanged` or `contract-changed`. The
one-use review receipt binds message ids, content digests, sequence boundary,
contract revision, contract digest, and authorization epoch. Another message
invalidates it. Heuristics may raise an earlier reframe fence, but can never
declare a message harmless. Delegated sessions must also re-prove the complete
live Harness ownership chain when authority is issued, consumed, and finally
dispatched; durable `parentSession` metadata is only an address.

When a supposed constant changes, the prior contract is no longer authoritative
and must be reframed. When changeable state changes, the next mutation must
re-enter the accepted contract and current plan, then bind to the new current
action facts. For filesystem tools this means the exact target body or a
digest-bound missing state. For external side effects it requires a host
integration that can expose the relevant preconditions; a generic shell string
cannot prove them.

## Derived Control Levels

The three controls and read-only probe follow from the invariant:

- `bypass`: a clear, bounded task already has a closed basis and immediate
  proof, so no durable Plan Lattice control state is needed.
- `contract`: an underspecified or ambiguous task is missing an
  outcome-critical decision, scope, authority, truth source, or acceptance
  boundary. Close and persist that basis before mutation.
- `probe`: the missing basis can be recovered from repository evidence. Permit
  reads and block mutation until that evidence closes the route.
- `lattice`: a long, dynamic task can cross compaction, resume, handoff,
  feedback, parallel work, or changing-state boundaries before later mutations.
  Re-enter the contract and current root-to-leaf plan at every authorization
  epoch.

Task length, file count, issue severity, and framework names are observations,
not causes. Eight or more explicitly requested mutation stages are evidence
that the Harness may cross a context-replacement boundary, but the causal
failure remains use of the stale basis after that boundary. Full Lattice
control is justified only by a complete chain:

```text
authoritative basis
-> concrete invalidation event
-> later mutation
-> stale action
-> detection point and consequence
```

## Mutation Protocol

Plan mutations and artifact mutations apply the same principle at different
boundaries.

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

Before editing an artifact, the agent must reread:

1. the complete accepted contract;
2. the current leaf and its full root-to-leaf plan, including acceptance; and
3. the exact current body of every declared target, or its digest-bound missing
   state.

The artifact mutation consumes that basis even when the tool attempt fails.
Any surface replacement, resume, reframe, structural plan change, handoff,
agent disposal, protected action attempt, external target change, or concurrent
graph revision invalidates the old authorization.

Execution audit and semantic proof are different kinds of state. The runtime
automatically records an exact mechanical receipt for each settled guarded
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
Lattice must not duplicate that state machine. It observes any native surface
replacement as an authorization boundary: the next protected action still has
to reconstruct the complete contract, current root-to-leaf address, and exact
current targets, and no summary inherits mutation authority.

The recursive tree is therefore not a longer todo list, a copy of the whole
contract, or authority by itself. It is a persistent address. After compaction,
pruning, resume, or handoff, that address tells the executing session which
complete accepted contract and authoritative root-to-leaf plan must be reread
before the next protected mutation. Adding or editing a branch starts from that
durable definition; editing an artifact additionally reads the exact target
body. A summary, model memory, inherited message, or `parentSession` may help
navigate to the basis, but none grants mutation authority. No layer in a
compaction or delegation chain inherits authorization from the previous layer's
summary.

This address must travel through the Harness's real control plane. Stable rules
belong in DSH system-prompt sections; mutable contract, node, and revision state
belongs in DSH runtime-context snapshots; the native AgentLoop still owns
message replay, compaction, plan/todo state, tool presentation, and child prompt
delivery. A snapshot is useful only if its complete model-visible body and exact
callable tool transport reach the deep-frozen `llm/stream` request under the
current authorization epoch. Checking an internal plugin object or an early
hook cannot establish that fact.

The control section must remain a boundary declaration, not an ever-growing
instruction manual. Constants/change/direction are useful design vocabulary for
the durable contract and route classifier, but restating that vocabulary on
every model step cannot make it authoritative. The host supplies its own plan,
todo, compaction, and delegation guidance. The plugin contributes only the
current execution address and the mechanical rule that a protected action needs
a fresh, complete basis. This distinction is what keeps a compatibility layer
from becoming a competing agent framework.

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

Native plan mode is another representation boundary, not a second source of
authority. Its plan text and collaboration state may change; the accepted
contract and invariants remain the constants the plan must satisfy. Therefore
DSH keeps exclusive ownership of planning and `exit_plan_mode`, while Plan
Lattice projects existing semantic authority read-only and suspends executable
authority. Crossing into or out of planning invalidates an earlier mutation
basis. Requiring a competing `lattice_open` or inventing another plan-mode
state machine would duplicate the changeable form instead of protecting the
stable invariant.

Delegation follows the same rule: inherited `parentSession` text is navigation,
not proof. The plugin must join DSH's live owner, native lifecycle edge, durable
child descriptor, seed boundary, and current root contract. Where rc.7 does not
identify the initial delegation message itself, the uncertainty remains an
explicit upstream limitation rather than being filled with another plugin-owned
prompt or transport.

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

## Routing Versus Enforcement

Routing and enforcement answer different questions:

- routing asks how much durable control the request justifies before work;
- enforcement asks whether one concrete action is authorized now.

The router may use only request-observable facts and explicit Harness facts. It
must not guess a future implementation plan, rollback method, verification
schedule, or stale-action consequence. Ordinary source-code discovery is part
of implementation and does not by itself justify `probe`. Probe is reserved
for a repository question whose possible answers change the required control
level, authority, or accepted boundary.

The runtime does not predict invalidation. It observes contract revisions,
graph revisions, compaction, handoff, leases, declared target digests, and host
preconditions, then invalidates receipts mechanically. This separation keeps
the scoped invariant general without imposing a full work graph on every small
task.

## Scope And Falsifiability

The existence of a first drifting mutation is a definition plus the ordering of
a finite execution, not an empirical discovery. A failure whose protected
mutations all used a complete, current, authoritative basis is outside this
invariant and must not be cited as evidence for it.

The enforcement design is falsified when the runtime authorizes an in-scope
mutation without the complete contract, current plan, exact target state, prior
proof, or required host preconditions. The routing and product-value claims are
separately falsified when blind tasks miss the required control level or when
controlled execution does not improve external outcomes enough to justify its
cost.

The router evaluation tests whether the controller recognizes when the
invariant needs durable enforcement. The external task evaluation separately
tests whether enforcing it improves outcomes enough to justify its cost. No
effect size, ranking, or universal benefit follows from the invariant itself.
