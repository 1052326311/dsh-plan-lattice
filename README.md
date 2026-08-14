# dsh-plan-lattice

**Evidence-gated work graph for long-horizon DeepSeek Harness agents.**

> Every plan mutation earns its context. No parent completes before its evidence reconciles.

`dsh-plan-lattice` is an independent community plugin for DeepSeek Harness. It
implements the "Fractal Ledger" method: begin with a small project tree,
recursively split only the active frontier into atomic leaves, and make each
meaningful change prove that the agent has just read the current project
contract.

It is designed for the failure mode where a long-running agent starts with a
good plan, discovers new constraints during implementation, and quietly keeps
executing an obsolete version of that plan.

## What It Enforces

The plugin makes five rules executable rather than advisory:

1. **Context contract.** A project names its background, product, and
   architecture documents explicitly. `lattice_open` and
   `lattice_refresh_context` read every document in full, return their content
   to the agent, and issue a revision-bound SHA-256 receipt. Oversized context
   fails closed rather than being silently truncated.
2. **Freshness receipt.** Adding, splitting, editing, archiving, checking out,
   and checkpointing a node all reread the complete contract. The operation is
   refused when the receipt is stale, from another session, or when any tracked
   document changed since it was issued.
3. **Recursive work graph.** The workspace ledger has stable node ids, an
   append-only audit history, compare-and-set revisions, a small branching
   policy, and evidence attached to each leaf. It is not a replace-all todo
   list or a workflow scheduler.
4. **Reconciliation gate.** A configured write tool needs an active leaf lease.
   After each successful guarded action, the next guarded action is denied
   until `lattice_checkpoint` records evidence. A parent becomes complete only
   when every live child is complete, at which point it receives derived
   reconciliation evidence.
5. **Compaction fence.** When Harness commits a `compaction/summary`, the
   plugin revokes that session's receipt and marks its active lease as needing a
   refresh. The next guarded write is denied until
   `lattice_refresh_context` rereads and renders the complete contract again.
   This is deliberately conservative: the plugin does not guess whether one
   particular tool result survived a model-visible history replacement.

The default shape is at most two top-level nodes and five children per nested
node. That deliberately keeps a dynamic task understandable instead of
spawning an uncontrolled task swarm. These limits are configurable; they are
not a promise of parallelism.

## Why This Is Different

Harness already provides plan mode, a same-session goal, and a per-turn flat
todo list. Ecosystem plugins also cover Markdown specifications, plan review,
workflow graphs, and task scheduling. Plan Lattice does not replace them.

Its narrow ownership point is the missing hard boundary between **reading the
current project contract** and **changing or advancing a recursive plan**. The
ledger records only structure, references, timestamps, and content digests;
it does not copy the context documents into project storage.

This responds to real Harness reports where final child verification arrived
after the parent goal had already been completed, and where repeated whole
context injection had no clear budget. The design uses receipts and a bounded
contract instead of assuming a model will remember to update a Markdown plan.

## Install

Build a portable bundle and add it to a Harness profile:

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-plan-lattice-<version>.tgz
```

The default patch enables the plugin. Configure it only when the deployment
needs a different write boundary or budget:

```yaml
- id: plan-lattice
  config:
    guardedTools: [write, edit, str_replace_editor]
    strictBash: false
    maxContextBytes: 262144
    topLevelLimit: 2
    nestedLimit: 5
    snapshotEvery: 1024
```

`bash` is intentionally not guarded by default. A shell command cannot be
classified safely as read-only from its text alone. Set `strictBash: true` to
gate every bash invocation behind a lattice leaf and checkpoint.

## Workflow

1. Call `lattice_open` with the durable outcome and every required
   workspace-relative product or architecture document. Read the returned
   context before planning.
2. Use the returned receipt and revision with `lattice_add` to create one or
   two root outcomes. Every structural tool consumes its receipt, so call
   `lattice_refresh_context` and read the complete rendered contract before the
   next add, split, edit, archive, checkout, or checkpoint.
3. Call `lattice_checkout` on one leaf. The plugin then permits configured
   write tools for that leaf.
4. After every successful guarded action, call `lattice_refresh_context`, then
   call `lattice_checkpoint` with a concise outcome and concrete references
   such as file paths, commands, test names, or review artifacts. The next
   write remains blocked until then.
5. Set `complete: true` only when the leaf acceptance criterion is proven.
   Parents collapse automatically only after all of their live children are
   complete.
6. After Harness compacts the session, call `lattice_refresh_context` before
   the next guarded write. A committed `compaction/summary` invalidates the
   session's active receipt and lease even when the project documents on disk
   have not changed.
7. Call `lattice_refresh_context` whenever product facts change outside the
   current operation. The plugin independently rereads the same contract
   before committing, but only the explicit refresh both proves freshness and
   renders the full document bodies to the agent.

The available tools are `lattice_open`, `lattice_status`,
`lattice_refresh_context`, `lattice_add`, `lattice_split`,
`lattice_update`, `lattice_archive`, `lattice_checkout`, and
`lattice_checkpoint`.

## Storage And Privacy

One workspace stores its materialized snapshot, short replay ledger, and
append-only history under:

```text
.dsh/plan-lattice/v1/
```

The Plan Lattice ledger stores node metadata, evidence references, timestamps,
context paths, and SHA-256 digests. It does not copy product or architecture
document bodies into `.dsh/plan-lattice`.

`lattice_status` is deliberately a bounded projection: it returns counts and a
small actionable frontier (16 nodes by default, 64 maximum), or one focused
node with a bounded direct-child list. A large ledger is durable project state,
not material to dump back into the model prompt. The process caches the
materialized graph behind a tiny revision marker, while restarts rebuild from
the snapshot plus its replay ledger.

The tool response does include complete current context because an agent cannot
earn a meaningful read receipt without being able to inspect what it read. As
with every model-visible tool result, the active Harness session persistence
may retain that response in its own session log. Treat declared context
documents as session-visible data and use the Harness session storage policy
appropriate for the workspace.

## Guarantees And Boundaries

The protocol is designed so a ten-step and a very deep task follow the same
state rules: mutations are revision checked, require a full current contract
read, and record evidence before a parent may complete. It can prevent stale
plan state from being silently advanced.

No plugin can guarantee that a language model will always understand every
requirement or produce equal-quality output at arbitrary scale. Plan Lattice
does not claim that. Its guarantee is operational: it exposes and rejects the
specific missing-state transitions that let a long task drift without a fresh
context read, an execution checkpoint, or a parent-child reconciliation.

It does not run subagents, schedule work, replace Harness plan mode, or infer
which arbitrary shell commands write files. Use the host sandbox and approval
policy for security boundaries.

## Verification

Version `0.2.2` is verified against the DeepSeek Harness tool runtime with a
real `Context` and `ToolRuntime` pipeline. The integration proof exercises:

- a guarded write denied before checkout;
- a guarded write allowed only with an active leaf;
- a second write denied until a checkpoint is recorded;
- every structural mutation consuming its receipt, forcing an explicit rendered
  context refresh before the next mutation;
- a context refresh unable to clear a missing checkpoint;
- a stale receipt denied after a tracked product document changes; and
- a real `SessionStore` compaction lifecycle that blocks a second guarded write
  until the complete contract is rendered again; and
- parent completion only after evidence-backed child completion.

The suite also builds a 100,000-node materialized graph that respects the
default two-root/five-child branching policy, restarts from its
snapshot plus incremental replay ledger, advances it, and invokes
`lattice_status` through the real ToolRuntime. That response is verified to
remain bounded to the requested frontier rather than serializing the full graph.
Separate store instances also prove cache invalidation after another instance
commits, and a rejected mutation is proven not to leak into the durable read.

Run the local suite with:

```sh
pnpm test
pnpm run check
```

Artifact-level profile boot and published-release verification are recorded in
the release notes for each version.

## License

MIT
