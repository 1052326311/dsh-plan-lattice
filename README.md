# dsh-plan-lattice

**Adaptive execution contracts and evidence-gated work graphs for DeepSeek Harness.**

Plan Lattice addresses one narrow failure mode: an agent begins a long or
underspecified product task with a plausible plan, discovers material facts as
it works, and continues against an obsolete interpretation. It turns the
boundary between framing, execution, change, and evidence into runtime state
instead of another advisory Markdown plan.

> Status: `v0.3.0` is the latest released version. The automatic controller
> described below is the unreleased `v0.4` candidate. It will not be released or
> advertised as an improvement until the preregistered external evaluation
> gates pass. Three independently frozen router sets have been revealed and did
> not pass. They are retained as development evidence; a source-disjoint V4
> blind set is required before paid model experiments or release work can begin.

## Automatic Control

New installations default to `activationMode: auto`. Classification happens
synchronously when the first user message enters the Harness inbox, before the
first system prompt and tool schemas are assembled. It uses no model call. A
small packaged classifier supplies a learned prior through local sparse-vector
math; it never invokes the task model or a network endpoint.

| Route | Intended work | Runtime effect |
| --- | --- | --- |
| `bypass` | Clear, bounded questions and small changes | No prompt, Lattice tools, write guard, model turn, or `.dsh` state |
| `contract` | Underspecified systems and applications with a moderate execution horizon | Commit a v2 contract; reread it with each mutation target, without node checkpoints |
| `lattice` | Long, cross-module, dynamic, irreversible, or multi-agent work | Contract plus recursive graph, receipts, leases, checkpoints, and evidence gates |
| `probe` | A request that cannot be classified safely from text alone | Read-only repository inspection and `lattice_route`; guarded writes remain blocked |

The controller separates task invariants from task forms. Product names,
frameworks, issue templates, and words such as `bug`, `feature`, or `tracking`
are changeable forms; none is sufficient to choose a route. The stable decision
variables are outcome clarity, verification clarity, definition gap, execution
span, boundary coupling, change volatility, authority impact, coordination
load, and reversibility. Hard invariant evidence outranks the learned prior;
uncertain cases enter `probe` instead of guessing.

For systems and applications the definition-gap score covers six
outcome-critical slots:

1. target user and task;
2. observable result;
3. scope and exclusions;
4. inputs, outputs, and source of truth;
5. authority and irreversible side effects; and
6. acceptance criteria.

It asks only when a missing fact can change the P0 result, boundary, authority,
truth source, or acceptance. Other gaps become explicit, reversible
assumptions. A short request involving production data, publishing, deletion,
payments, or permissions is not treated as a small task merely because it has
few words. Conversely, a long issue template describing one reproducible,
reversible defect can still bypass with zero plugin overhead.

## Root Invariant

At the Harness layer, context drift has one causal form: **a mutation is
authorized from an intent or fact basis that is no longer authoritative and
current**. Repeated context compaction is the common trigger, but handoff,
parallel agents, revised requirements, plan edits, and external file changes
produce the same failure.

The stable invariant is therefore not “keep a longer prompt.” Before every
controlled filesystem mutation, the executing session must observe one joined
basis containing:

1. the complete accepted execution contract;
2. the checked-out leaf and its full root-to-leaf plan, including every
   acceptance criterion; and
3. the exact current contents of every target file, or a digest-bound fact that
   the target does not yet exist.

`lattice_refresh_context({ targetPaths })` renders that basis. A built-in
`write`, `edit`, or mutating `str_replace_editor` call is accepted only when its
actual path is one of those targets and its body still matches the observed
digest. The basis is consumed before execution, including failed attempts, so
parallel or retried mutations cannot reuse it. Compaction, reframe, plan
mutation, successful guarded work, session handoff, or an external target
change also invalidates it. Read-only `str_replace_editor view` calls do not.

This makes the recursive tree an execution index rather than a todo display:
each edit re-enters the current definition of the work before touching the
current state of the artifact.

## Configuration

```yaml
- id: plan-lattice
  config:
    activationMode: auto          # off | auto | always
    clarificationPolicy: critical # critical | always | never
    controlCeiling: lattice       # contract | lattice
    longTaskThreshold: 8
    guardedTools: [write, edit, str_replace_editor]
    strictBash: false
    maxContextBytes: 262144
    topLevelLimit: 2
    nestedLimit: 5
    snapshotEvery: 1024
    # Defaults below DSH_HOME; keep outside every agent-writable workspace.
    # contractAnchorRoot: /absolute/trusted/plan-lattice-anchors
```

`longTaskThreshold` is evidence, not the routing decision by itself.
`controlCeiling: contract` provides a lighter deployment and the contract-only
ablation arm. `strictBash: true` guards every shell invocation because shell
text cannot be classified reliably as read-only.

Task text can override configuration:

- `Do not use Plan Lattice` / `不要使用 Plan Lattice` forces `bypass`.
- `Do not ask; make reasonable assumptions` / `不要提问，合理假设` keeps the
  selected control level but changes clarification to `never`.
- `Use the full Lattice` / `使用完整 Lattice` forces the configured maximum
  control level.

### v0.3 Migration

An explicit legacy `intakeMode` keeps v0.3 behavior when none of the new fields
is present. Mixing old and new fields is a configuration error with migration
guidance.

| Legacy | v0.4 equivalent |
| --- | --- |
| `intakeMode: off` | `activationMode: always`, `clarificationPolicy: never` |
| `intakeMode: adaptive` | `activationMode: always`, `clarificationPolicy: critical` |
| `intakeMode: guided` | `activationMode: always`, `clarificationPolicy: always` |

Legacy graphs and intake records remain readable. New contracts are written to
v2 paths; old state is never rewritten in place. A resumed v1 graph is treated
as full `lattice` control.

## Contract Protocol

`lattice_intake` records the system boundary, time horizon, observable outcome,
facts, decisions, invariants, changeable forms, directional forces, causal
variables, assumptions, unknowns, and acceptance readiness.

- With no critical questions, it atomically commits the contract immediately.
- With questions, it asks through the real Harness user-question channel and
  returns a `pendingIntakeId` plus the answers. Nothing is persisted yet.
- `lattice_commit_intake` must bind every answer exactly once as a confirmed
  fact, decision, invariant, or explicit unknown before the contract is
  committed.
- `clarificationPolicy: never` rejects questions and requires visible,
  reversible assumptions.
- Delegated agents cannot question the user or establish the root contract;
  they return missing information to their parent.

Contract control permits guarded work after commitment without requiring a
node checkout, but each filesystem mutation still needs a fresh contract plus
target-file basis. Full Lattice control additionally requires `lattice_open`, a
current context receipt, an active leaf lease, the current root-to-leaf plan,
and an evidence checkpoint after each successful guarded action.

When a user supplies a material change, a declared contract file changes, or a
`compaction/summary` replaces model-visible history, guarded work pauses.
`lattice_reframe` commits a new contract revision; `lattice_refresh_context`
rereads the complete contract after compaction and, with `targetPaths`, the
current plan and exact files for the next mutation. Existing graph nodes remain
visible for explicit reconciliation.

The confirmed `id`, revision, digest, and full last accepted contract are also
stored in a session-keyed trust root below `DSH_HOME` (or
`contractAnchorRoot`). Rewriting `CONTRACT.md` and `contract.json` together does
not move that anchor. The mismatch survives process restart, blocks guarded
writes, and can be replaced only through `lattice_reframe`. The anchor root must
remain outside paths writable by the tested agent.

## Multi-Agent Sessions

A child inherits its root task's control level through `parentSession`. Its
prompt receives a compact execution capsule containing the outcome, decisions,
invariants, current node, acceptance, unknowns, and contract revision. It does
not receive authority to ask the human. Missing boundary information is a
parent-facing result, not a reason for the child to guess.

Plan Lattice does not spawn or schedule agents. It controls the contract and
evidence state shared by whatever delegation mechanism the Harness deployment
already uses.

## Storage And Privacy

```text
.dsh/plan-lattice/v1/  # existing graph, ledger, history, and legacy intake
.dsh/plan-lattice/v2/  # new CONTRACT.md and digest-bound contract.json
$DSH_HOME/plan-lattice/contract-anchors/v1/  # independent session trust anchors
```

Bypass creates neither directory. v2 contract files contain the generated
framing and bound human answers, so treat them as project-sensitive state.
Repository documents are referenced and hashed rather than copied into the
Lattice state, although complete document contents appear in model-visible tool
results when a freshness receipt is issued.

API credentials are never configuration fields. Evaluation and production
providers must receive them through process environment variables or an
equivalent host secret manager.

## Guarantees And Limits

The plugin can reject concrete stale-state transitions: writing before framing,
writing while routing is unresolved, advancing a graph without a current
receipt, continuing after compaction without rereading, using a contract whose
digest changed, editing an undeclared target, editing a target changed after
observation, or reusing one pre-action basis for multiple mutations.

It cannot guarantee that a model understood every requirement, classify an
arbitrary shell command as safe, make unrelated filesystem writers
transactional, or replace host sandbox and approval policies. It also adds
unnecessary control to tasks a capable model can already solve in one bounded
pass. That is why automatic bypass, not always-on planning, is the default.

## Verification

The local suite exercises real Harness `Context`, agent scopes, first-inbox
events, system-prompt assembly, dynamic tool restrictions, session compaction,
the user-question service, and the tool runtime. It covers:

- first-message routing before prompt and tool assembly;
- zero-state bypass and probe write blocking;
- direct and two-stage contract commitment with typed answer binding;
- contract-only writes without artificial checkpoints;
- material-change and compaction fences;
- root-to-leaf plan rendering, exact target binding, missing-file binding,
  one-attempt consumption, and stale-target rejection;
- v1 and v2 restart recovery, including pre-restart dual-file tampering;
- parent-child inheritance and the delegated-agent question boundary;
- all v0.3 graph, receipt, reframe, scale, and compatibility behavior; and
- a public development corpus, three immutable failed blind-test archives, a
  source-grouped offline-model training report, and bilingual causal
  counterfactuals that change wording while preserving task invariants.

Router gates are: simple-task false activation at most 5%, complex critical-task
recall at least 90%, no outcome-critical bypass, and 100% explicit override
compliance.

The three retained first reveals all failed and are not reused as blind
evidence. V1 measured 57.5% simple-task false activation, 86.25% complex-task
recall, and 11 outcome-critical bypasses. V2 measured 20.69%, 59.68%, and 28;
V3 measured 31.48%, 59.09%, and 27. Their prompts and labels may be used for
development only. Tests preserve their manifests and failed results rather
than requiring current code to pass revealed data. The evaluation preflight
continues to refuse paid runs until a source-disjoint V4 first reveal passes
all preregistered gates.

```sh
pnpm test
pnpm run check
pnpm run build
pnpm pack
```

The external model protocol is documented in `EVAL_PROTOCOL.md` and
`eval/v0.4/`. It freezes 90 statistical runs plus 6 excluded infrastructure
runs across simple tasks, ICAE-EVAL ambiguous product builds, and EvoCodeBench
dynamic requirements. Failures remain in the dataset. Only predefined
infrastructure faults may be rerun. The controller binds its own driver source
tree, executes a content-addressed Harness runtime built from the pinned Git
archive, and refuses statistical runs until all six infrastructure slots have
completed. ICAE model processes receive neither benchmark-root environment
variables nor host read access to hidden benchmark/controller roots, and cannot
connect directly to official Oracle/statistics ports. Paid execution uses a
credential-isolated local proxy, hash-chained results, exact attempt-artifact
receipts, request/session accounting, and arm-identified Linux runtimes whose
installed support, profile, and candidate-package bytes are re-hashed; the
upstream API key never enters the Harness or container process environment.
Final workspaces and grader artifacts remain attached to each attempt for
independent reproduction.

The candidate is releasable only if simple tasks add zero model turns and stay
within the overhead/non-inferiority bounds, ambiguous-task hidden scores improve
by at least 50% and 15 percentage points with a positive paired-bootstrap lower
bound, and dynamic requirement regressions fall by at least 50%. Until those
conditions are measured on a new independently preregistered candidate, this
repository makes no v0.4 uplift or ranking claim.

## Install Released v0.3

```sh
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-plan-lattice-<version>.tgz
```

The package is an independent community plugin for DeepSeek Harness.

## License

MIT
