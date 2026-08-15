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

The plugin makes ten rules executable rather than advisory:

1. **Configurable execution intake.** Long work can run with `intakeMode: off`,
   `adaptive`, or `guided`. `off` preserves the original autonomous workflow.
   `adaptive` lets the user choose guided clarification or model-led autonomy
   for each long task. `guided` asks only high-impact missing questions and
   requires approval of the exact contract before planning starts.
2. **Boundary before decomposition.** Intake separates confirmed facts, product
   decisions, assumptions, and unknowns. It records the system boundary, time
   horizon, desired outcome, invariants, changeable forms, directional forces,
   and the few variables that decide success. Work below the configurable step
   threshold bypasses intake.
3. **Human ownership.** Only the live root agent may ask questions. Child agents
   must return unresolved boundary questions to their parent. User answers and
   decisions outrank model assumptions, while autonomous mode remains available
   with explicit assumptions and no detail-by-detail questioning.
4. **Context contract.** A project names its background, product, and
   architecture documents explicitly. `lattice_open` and
   `lattice_refresh_context` read every document in full, render their content
   and the exact copyable receipt fields to the agent, and issue a
   revision-bound SHA-256 receipt. Oversized context fails closed rather than
   being silently truncated.
5. **Freshness receipt.** Adding, splitting, editing, archiving, checking out,
   and checkpointing a node all reread the complete contract. The operation is
   refused when the receipt is stale, from another session, or when any tracked
   document changed since it was issued.
6. **Recursive work graph.** The workspace ledger has stable node ids, an
   append-only audit history, compare-and-set revisions, a small branching
   policy, and evidence attached to each leaf. It is not a replace-all todo
   list or a workflow scheduler.
7. **Reconciliation gate.** A configured write tool needs an active leaf lease.
   After each successful guarded action, the next guarded action is denied
   until `lattice_checkpoint` records evidence. A parent becomes complete only
   when every live child is complete, at which point it receives derived
   reconciliation evidence.
8. **Compaction and contract-change fences.** When Harness commits a
   `compaction/summary`, the plugin revokes that session's receipt and marks its
   active lease as needing a refresh. The next guarded write is denied until
   `lattice_refresh_context` rereads and renders the complete contract again.
   This is deliberately conservative: the plugin does not guess whether one
   particular tool result survived a model-visible history replacement.
   Immediately before every configured guarded write, it also synchronously
   rechecks the declared contract against the last rendered digest.
9. **Dynamic reframing.** When a material fact changes the boundary, acceptance
   criteria, or irreversible work, `lattice_reframe` renews the human policy,
   persists a new intake contract, bumps the graph revision, and keeps existing
   nodes visible for explicit reconciliation. It does not silently replace the
   work graph.
10. **Contract-set adoption.** If a newly discovered decision or architecture
   document must govern the task, `lattice_adopt_context` first proves a
   current read of the old contract, rejects the change while any leaf is
   checked out, reads every added file before durable mutation, then renders
   the complete new contract with a new revision-bound receipt. A missing,
   unsafe, or oversized addition leaves the old graph and contract intact.

The default shape is at most two top-level nodes and five children per nested
node. That deliberately keeps a dynamic task understandable instead of
spawning an uncontrolled task swarm. These limits are configurable; they are
not a promise of parallelism.

## Why This Is Different

Harness already provides plan mode, a same-session goal, and a per-turn flat
todo list. Ecosystem plugins also cover Markdown specifications, plan review,
workflow graphs, and task scheduling. Plan Lattice does not replace them.

Its narrow ownership point is the missing hard boundary between **establishing
the current execution contract** and **changing or advancing a recursive
plan**. The ledger records structure, references, timestamps, and content
digests. When intake is enabled, a separate generated contract records the
confirmed framing and human answers; source product documents are not copied.

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
    intakeMode: adaptive
    longTaskThreshold: 8
    maxContextBytes: 262144
    topLevelLimit: 2
    nestedLimit: 5
    snapshotEvery: 1024
```

`bash` is intentionally not guarded by default. A shell command cannot be
classified safely as read-only from its text alone. Set `strictBash: true` to
gate every bash invocation behind a lattice leaf and checkpoint.

`intakeMode` defaults to `off` for compatibility and fully autonomous use.
Choose `adaptive` when each long task should begin with a single guided-versus-
autonomous choice, or `guided` when the user must answer high-impact questions
and approve the exact contract. The default `longTaskThreshold` is 8 estimated
atomic steps. The web profile supplies a user-question provider; an unattended
or headless profile must mount its own provider or leave intake `off`.

## Workflow

1. When intake is enabled and the honest estimate meets the configured
   threshold, call `lattice_intake` after reading repository evidence. In
   adaptive mode, honor the user's guided or autonomous choice. Persisted
   assumptions must remain explicit in either path.
2. Call `lattice_open` with the durable outcome, exact step estimate, intake
   receipt when required, and every required
   workspace-relative product or architecture document. Read the returned
   context before planning.
3. Use the returned receipt and revision with `lattice_add` to create one or
   two root outcomes. Every structural tool consumes its receipt, so call
   `lattice_refresh_context` and read the complete rendered contract before the
   next add, split, edit, archive, checkout, or checkpoint.
4. Call `lattice_checkout` on one leaf. The plugin then permits configured
   write tools for that leaf.
5. After every successful guarded action, call `lattice_refresh_context`, then
   call `lattice_checkpoint` with a concise outcome and concrete references
   such as file paths, commands, test names, or review artifacts. The next
   write remains blocked until then.
6. Set `complete: true` only when the leaf acceptance criterion is proven.
   Parents collapse automatically only after all of their live children are
   complete.
7. After Harness compacts the session, call `lattice_refresh_context` before
   the next guarded write. A committed `compaction/summary` invalidates the
   session's active receipt and lease even when the project documents on disk
   have not changed.
8. If a newly discovered fact changes the boundary, acceptance criteria, or
   irreversible work, checkpoint the active leaf and call `lattice_reframe`.
   Reconcile every unfinished node against the newly approved contract before
   continuing.
9. If a newly discovered document must constrain future work, first finish or
   checkpoint every checked-out leaf. Call `lattice_refresh_context`, then
   `lattice_adopt_context` with the current receipt and the new paths. Read the
   complete returned contract before taking the next plan action. The existing
   graph remains durable; re-opening the workspace is neither needed nor
   permitted.
10. If any declared product or architecture document changes, the next guarded
   write is rejected automatically. Call `lattice_refresh_context`, read its
   complete rendered output, and then reconsider the next action. This closes
   the period between checkout or checkpoint and the next side effect without
   relying on the model to notice an external edit.

The fence detects the contract at authorization time. It cannot make an
arbitrary third-party file writer and an arbitrary guarded tool one filesystem
transaction; deployments that need that stronger property must use their host
workspace locking policy as well.

The always-available tools are `lattice_open`, `lattice_status`,
`lattice_refresh_context`, `lattice_adopt_context`, `lattice_add`,
`lattice_split`, `lattice_update`, `lattice_archive`, `lattice_checkout`, and
`lattice_checkpoint`. `lattice_intake` and `lattice_reframe` are registered
when intake mode is `adaptive` or `guided`.

## Storage And Privacy

One workspace stores its materialized snapshot, short replay ledger, and
append-only history under:

```text
.dsh/plan-lattice/v1/
```

The Plan Lattice ledger stores node metadata, evidence references, timestamps,
context paths, and SHA-256 digests. It does not copy source product or
architecture document bodies into `.dsh/plan-lattice`. With intake enabled,
`INTAKE.md` and `intake.json` also store the generated execution framing,
explicit assumptions and unknowns, and the user's submitted clarification
answers. Treat those files as project-sensitive state.

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

Intake and reframe serialization is process-local. Multiple Harness processes
sharing one workspace still need a host-level workspace lock. Intake uses
atomic file replacement and a digest-bound JSON commit marker; an interrupted
or competing update fails closed and may require the intake or reframe to be
run again. The plugin is a workflow integrity boundary, not a distributed
transaction or access-control system.

## Verification

Version `0.3.0` has 20 automated tests against real Harness `Context`, agent,
system-prompt, user-question, session, and tool-runtime services. The suite
proves:

- guided clarification, exact contract review, adaptive autonomous choice, and
  threshold bypass through the real `UserQuestionService` seam;
- intake receipts bound to the exact session, step estimate, mode, and generated
  contract digest, with incomplete or rejected intake failing closed;
- live reframing after a material fact changes, while retaining old nodes for
  explicit reconciliation;
- every context-rendering tool exposing the exact copyable receipt id and
  revision in final model-facing content, not only internal JSON;
- guarded writes requiring an active leaf, a fresh full contract, and an
  evidence checkpoint before the next guarded action;
- contract edits and real session compaction blocking later guarded writes until
  the full current contract is rendered again;
- contract-set adoption without losing graph nodes, including safe rejection of
  missing additions and conflicting session leases; and
- parent completion only after every live child has evidence-backed completion.

The scale proof builds and advances a 100,000-node graph, restarts it from the
snapshot plus replay ledger, and verifies that `lattice_status` stays bounded.
Separate store instances prove cache invalidation after external commits and
that rejected mutations do not leak into durable state.

A real-model smoke on DeepSeek Harness `master` (`47f943859b`) used the same
DeepSeek model defaults, fixture, scripted clarification, and external 100-point
grader for three fixed arms. With one run per arm, native sparse, native full,
and Plan Lattice guided each scored 100. The guided run produced 57 passing
fixture tests, completed all 7 lattice nodes, and made 39 lattice calls with
zero lattice errors after the receipt-presentation fix. This is compatibility
and non-regression evidence, not an improvement claim; the sample size is one
and the fixture was too easy to separate already-correct outputs. The public
protocol and grader live under `eval/` so later claims cannot quietly change the
rubric after seeing a result.

Run the local suite with:

```sh
pnpm test
pnpm run check
pnpm run build
```

Artifact-level profile boot and published-release verification are recorded in
the release notes for each version.

## License

MIT
