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
- durable graph revision and the current root-to-leaf digest;
- the focused structural neighborhood for a plan mutation;
- the aggregate digest of every declared artifact target;
- whether prior protected work still requires evidence; and
- adapter-provided state and exact arguments for an external side effect; and
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
queued cannot survive that message becoming model-visible. Delegated sessions
must also re-prove the complete live Harness ownership chain when authority is
issued, consumed, and finally dispatched; durable `parentSession` metadata is
only an address.

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

Before editing an artifact, the agent must reread:

1. the complete accepted contract;
2. the current leaf and its full root-to-leaf plan, including acceptance; and
3. the exact current body of every declared target, or its digest-bound missing
   state.

The artifact mutation consumes that basis even when the tool attempt fails.
Any surface replacement, resume, reframe, structural plan change, handoff,
agent disposal, protected action attempt, external target change, or concurrent
graph revision invalidates the old authorization.

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
