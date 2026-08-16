# Plan Lattice First Principle

## Control Domain

Plan Lattice controls autonomous execution episodes that may mutate an
artifact, persistent state, or another protected system. Within that domain it
reduces every execution-drift scenario to one root cause:

> A mutation is valid only when it is authorized from a complete, current
> intent-and-fact basis.

For a mutation `m` at time `t`:

```text
valid(m, t)
  = accepted-contract(t)
  and current-root-to-leaf-plan(t)
  and current-action-facts(t)

drift(m, t)
  = executed(m, t) and not valid(m, t)
```

This is a universal statement about execution drift, not a claim that every
possible model error is drift. A model can still implement a current plan
incorrectly. Tests, graders, reviews, sandboxes, and approval policy remain
necessary for those failures. Keeping this boundary explicit makes the root
cause falsifiable instead of turning it into an explanation that can never be
wrong.

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

A summary, inherited message, model memory, or earlier tool result may help
locate this basis, but never substitutes for it. The authorization check is an
equality test against current state, not a request for the model to remember
what used to be true.

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

## Constant, Change, And Force

The current contract revision defines the constants:

- desired observable outcome;
- scope and exclusions;
- authority and source of truth;
- invariants and accepted decisions; and
- acceptance criteria.

The implementation forms may change:

- graph nodes and their order;
- repository files and runtime state;
- discovered facts and assumptions;
- tools, executors, and handoffs; and
- the concrete implementation strategy.

The forces are events that can invalidate an earlier basis before a later
mutation: context replacement, stage output, external truth changes, human
reframing, handoff, parallel execution, delayed verification, and direct plan
or artifact edits. These are not independent root causes. Each is a way for a
once-valid basis to stop being current.

When a constant changes, the contract must be reframed. When a form changes,
the next mutation must re-enter the current contract and plan, then bind to the
new current action facts. For filesystem tools this means the exact target body
or a digest-bound missing state. For external side effects it requires a host
integration that can expose the relevant preconditions; a generic shell string
cannot prove them. The controller never treats a summary as equivalent to the
complete accepted basis.

## Derived Control Levels

The three controls and read-only probe follow from the invariant:

- `bypass`: one bounded, reversible episode already has a closed basis and an
  immediate proof, so no durable control state is needed.
- `contract`: a user decision is missing, or a stable episode needs one durable
  authority boundary. Close and persist the basis before mutation.
- `probe`: the missing basis can be recovered from repository evidence. Permit
  reads and block mutation until that evidence closes the route.
- `lattice`: a concrete event can invalidate the basis before a later mutation.
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
Any compaction, reframe, structural plan change, handoff, successful protected
action, or external target change invalidates the old authorization.

The recursive tree is therefore not a longer todo list. It is an address that
lets every later action recover the complete current intent after arbitrary
context replacement. Adding or editing a branch starts by reading the accepted
definition and the current plan file; editing an artifact additionally reads
the exact target body. No layer in a compaction or delegation chain inherits
mutation authority from the previous layer's summary.

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
the root cause universal while preventing the controller from imposing a full
work graph on every small task.

## Falsifiability

The design must be revised when either of these is observed:

1. a controlled drift failure cannot be represented as mutation from an
   incomplete or invalidated basis; or
2. the invariant is satisfied, but the runtime still authorizes a mutation
   without the complete contract, current plan, and exact target state.

The router evaluation tests whether the controller recognizes when the
invariant needs durable enforcement. The external task evaluation separately
tests whether enforcing it improves outcomes enough to justify its cost.
