# dsh-plan-lattice

**Adaptive execution contracts and evidence-gated work graphs for DeepSeek Harness.**

[![GitHub release](https://img.shields.io/github/v/release/1052326311/dsh-plan-lattice?include_prereleases)](https://github.com/1052326311/dsh-plan-lattice/releases)
[![GitHub stars](https://img.shields.io/github/stars/1052326311/dsh-plan-lattice)](https://github.com/1052326311/dsh-plan-lattice/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Plan Lattice addresses one narrow failure mode: an agent begins a long or
underspecified product task with a plausible plan, discovers material facts as
it works, and continues against an obsolete interpretation. It turns the
boundary between framing, execution, change, and evidence into runtime state
instead of another advisory Markdown plan.

> Status: `v0.3.0` remains the latest stable release. `v0.4.0-rc.0` is a public
> runtime candidate, not an evidence-backed stable release. Its deterministic
> mechanism test passes; the independently preregistered external model
> evaluation has not passed, so no general coding-quality uplift or ranking is
> claimed.

## Evidence At A Glance

| Claim | Current evidence | Status |
| --- | --- | --- |
| Stale long-task mutations can be stopped at execution time | Real Harness mechanism stress test: native executed 8/8 engineered unsafe mutations; Plan Lattice executed 0/8 | Reproducible |
| Clear small tasks avoid orchestration overhead | `bypass` injects no Lattice prompt or tools, creates no `.dsh` state, and adds no model call | Covered by integration tests |
| The external benchmark driver uses the real frozen Harness path | Local end-to-end fixture verifies the credential proxy, exact model contract, durable Session JSONL, token accounting, timeout handling, and secret redaction | Driver verified; paid matrix not run |
| General software-task quality improves | Requires the frozen 90-run ICAE/EvoCode/simple-task matrix and `releaseAllowed: true` | Not established |

## Install

Install the stable v0.3 release directly from its verified GitHub asset:

```sh
gh release download v0.3.0 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.3.0.tgz
```

To inspect the public v0.4 runtime candidate instead:

```sh
gh release download v0.4.0-rc.0 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.4.0-rc.0.tgz
```

The package is an independent community plugin for DeepSeek Harness. To build
the current checkout from source, run `pnpm install`, `pnpm pack`, and install
the generated tarball with the same `dsh plugin --profile web add` command.

## The First-Drift Test

A long task does not usually fail because its plan file vanished. It fails when
one mutation finally executes from a basis that was incomplete, compacted away,
superseded, or changed elsewhere. Plan Lattice makes that boundary executable:
it joins the accepted contract, current root-to-leaf plan, exact target bodies,
required evidence, live ownership, and observable external preconditions into
a one-use authorization epoch.

The repository includes a deterministic stress test built on the real Harness
context, session, agent-registry, compaction, and tool-runtime services. It
deliberately invalidates one part of that basis immediately before a protected
mutation:

| Engineered hazard | Native Harness | Plan Lattice |
| --- | ---: | ---: |
| Changed target file | unsafe mutation executed | prevented |
| Changed accepted background | unsafe mutation executed | prevented |
| Compacted model-visible context | unsafe mutation executed | prevented |
| Late material user input | unsafe mutation executed | prevented |
| Changed external precondition | unsafe mutation executed | prevented |
| Middleware argument rewrite | unsafe mutation executed | prevented |
| Concurrent durable-plan update | unsafe mutation executed | prevented |
| Disappeared delegated parent | unsafe mutation executed | prevented |

**Observed result on these eight engineered hazards: native executed 8/8 unsafe
mutations; Plan Lattice executed 0/8.** Reproduce it locally:

```sh
pnpm install --frozen-lockfile
pnpm run demo:first-drift
```

This is intentionally a mechanism stress test, not a sampled benchmark of
software tasks. The 100% prevention rate applies only to the eight hazards the
test was designed to trigger. It does not estimate general coding quality,
real-world task success, or production uplift. See the
[`machine-readable results`](demo/results/first-drift-benchmark.json),
[`rendered report`](demo/results/first-drift-benchmark.md), and
[`reproducible driver`](demo/first-drift-benchmark.mjs).

The stricter external protocol remains frozen separately. V1 through V5 failed
their first reveal; V6 failed annotation reliability; V7 lacked blind-stratum
capacity; V8/V9 were retired before router reveal during source isolation; and
V10 was retired before seed access when its frozen collector encountered an
unhandled empty GitHub repository. V11 was then retired before seed access when
live GitHub Search returned an object whose `updated_at` was later than the
frozen historical cutoff, proving that the search index could not replay a
trustworthy historical source frame. A successor must use a versionable public
event source rather than relax that boundary. These negative results remain in
the repository and are not repaired or relabelled as release evidence.

## Automatic Control

New installations default to `activationMode: auto`. Classification happens
synchronously when the first user message enters the Harness inbox, before the
first system prompt and tool schemas are assembled. It uses no model call. A
deterministic causal assessment chooses the route. The retained packaged
classifier is development telemetry only: it cannot override or supply a route.

| Route | Intended work | Runtime effect |
| --- | --- | --- |
| `bypass` | Clear, bounded questions and small changes | No Lattice prompt, tools, write guard, added model turn, or `.dsh` state |
| `contract` | Underspecified systems and applications with a moderate execution horizon | Commit a v2 contract; reread it with each mutation target, without node checkpoints |
| `lattice` | Work with a concrete repeated basis-invalidation path: an explicitly long horizon, stage feedback, changing truth, handoff, parallel execution, or delayed proof | Contract plus recursive graph, receipts, leases, checkpoints, and evidence gates |
| `probe` | A request that cannot be classified safely from text alone | Read-only repository inspection and `lattice_route`; guarded writes remain blocked |

The controller separates task invariants from task forms. Product names,
frameworks, issue templates, and words such as `bug`, `feature`, or `tracking`
are changeable forms; none is sufficient to choose a route. The initial route
uses only request-observable authorization facts:

1. whether the episode authorizes mutation at all;
2. whether an outcome-critical user decision is still missing;
3. whether repository evidence can change the required control level rather
   than merely reveal the file that implements the change;
4. whether the request establishes a continuity hazard between mutations; and
5. whether it crosses an explicit persistent, external, or authority boundary.

Full Lattice control requires a causal chain from an authoritative basis,
through a concrete invalidation event, to a later stale mutation and its
detection consequence. At least eight explicitly requested mutation stages are
evidence for the Harness's known context-replacement boundary, not an
independent root cause. A severe but static one-epoch change uses a contract and
stronger proof rather than being promoted merely because the reported bug
mentions security, data loss, or production. Ordinary source-code discovery is
part of execution. `probe` is reserved for a repository question with mutually
exclusive answers that would route differently; missing user decisions belong
in intake instead.

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
reversible defect can still bypass with zero added model calls or persisted
control state.

## Root Invariant

Within the controlled long-task execution domain, drift has one precise form:
**a protected mutation executes from an intent or fact basis that is incomplete,
no longer authoritative, or no longer current**. If such drift occurs, the
ordered execution has a first protected mutation with that invalid basis. This
is a scoped invariant for that failure class, not a law about every model error
or every task. Compaction, handoff, parallel agents, revised requirements, plan
edits, and external state changes are mechanisms that can invalidate the basis.

The stable invariant is therefore not “keep a longer prompt.” Before every
controlled filesystem mutation, the executing session must observe one joined
basis containing:

1. the complete accepted execution contract;
2. the checked-out leaf and its full root-to-leaf plan, including every
   acceptance criterion; and
3. the exact current contents of every declared target file, or a digest-bound
   fact that the target does not yet exist;
4. any proof still required from prior protected work; and
5. host-observable preconditions for non-filesystem side effects.

`lattice_refresh_context({ targetPaths })` renders that basis. A built-in
`write`, `edit`, or mutating `str_replace_editor` call is accepted only when its
actual path is one of those targets and its body still matches the observed
digest. The joined authorization epoch is consumed before validation or
dispatch, including failed attempts, so parallel or retried mutations cannot
reuse it. A prepared dispatch then binds and locks the call identity and exact
arguments; supported authority invalidation while an asynchronous dispatch
middleware waits aborts the call before tool-body entry. The guard compares the
durable graph revision, current root-to-leaf
digest, and aggregate digest of every declared target, not only the immediate
editor path. Surface replacement, resume, reframe, plan mutation, handoff,
disposal, or a concurrent durable change invalidates the whole epoch. Read-only
`str_replace_editor view` calls do not.

The first accepted global definition for each guarded tool is pinned for the
process lifetime, including its `execute` function. Scoped same-name shadows and
later global replacements do not inherit trust, and any supported registry
change aborts an active guard-to-body dispatch. Plan Lattice also locks the name
and arguments of initially unguarded calls at its first dispatch middleware, so
a later middleware cannot upgrade a harmless call into `write` or `edit` after
the guard has run.

Non-filesystem guarded tools require a programmatic host precondition adapter
that binds exact action arguments to observable external state. Without one the
guard fails closed. This includes `strictBash`: declaring files cannot prove
that arbitrary shell text has no other side effects.

This makes the recursive tree a persistent execution address rather than a todo
display. After compaction, pruning, resume, or handoff, it tells the session
which complete accepted contract and authoritative root-to-leaf plan to reread
before touching the current artifact state. A summary, model memory, inherited
message, or `parentSession` can navigate to that basis but cannot authorize a
mutation.

Inbox arrival and durable message append each invalidate authority. This closes
the interval in which a receipt could otherwise be reissued after a message was
queued but before it became model-visible. Delegated agents revalidate every
live parent ownership edge when authority is issued, consumed, and dispatched;
a stale `parentSession` value cannot revive a dead handoff.

Structural plan changes obey the same rule. Adding, splitting, updating,
archiving, or checking out a node requires a one-action receipt from a complete
contract and exact current plan-neighborhood reread; the change consumes the
receipt and advances the revision. An artifact edit additionally binds the
current root-to-leaf plan to the exact target body. A compacted summary never
substitutes for either read.

In constant/change/direction terms, the accepted contract, invariants, and
acceptance criteria are the current constants. Discovered facts, plans, declared
mutation targets and their contents, executors, and external state may change.
Directional forces describe where change may be moving and can influence
routing or what to inspect next, but a trend is not a fact or decision and can
never authorize a mutation. The tree does not freeze changeable state; it gives
each mutation a durable route back through the complete contract and current
root-to-leaf plan before binding that intent to the exact current action facts.

The formal control domain, derivation, mutation protocol, and falsification
conditions are documented in [`docs/FIRST_PRINCIPLE.md`](docs/FIRST_PRINCIPLE.md).

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
ablation arm. `strictBash: true` guards every shell invocation and fails closed
unless the host supplies a programmatic `preconditionAdapters.bash` integration.
Function adapters are host composition and therefore cannot be expressed in
the YAML block above.

Task text can override configuration:

- `Do not use Plan Lattice` / `不要使用 Plan Lattice` forces `bypass`.
- `Do not ask; make reasonable assumptions` / `不要提问，合理假设` keeps the
  selected control level but changes clarification to `never`.
- `Use the full Lattice` / `使用完整 Lattice` forces the configured maximum
  control level.

### v0.3 Migration

An explicit legacy `intakeMode` keeps v0.3 behavior when none of the new fields
is present. Mixing old and new fields is a configuration error with migration
guidance. This compatibility path preserves v0.3 custom-tool behavior; the new
external-precondition guarantee applies to the v0.4 controller.

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
and an evidence checkpoint after each dispatched guarded action whose result
may conceal a partial side effect, including a thrown tool body.

When a user supplies a material change, a declared contract file changes, or a
surface event replaces model-visible history, guarded work pauses. Summary
compaction and model-free tool-result pruning are both covered, as are resumed
sessions whose seed already contains replacements.
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

A child inherits its root task's control level only when `parentSession` agrees
with the Harness's live `isOwnedBy` relation. Durable lineage metadata locates
the parent; it does not authorize inheritance by itself. The child prompt
receives a compact execution capsule containing the outcome, decisions,
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
arbitrary shell command as safe, or replace host sandbox and approval policies.
Its digest check and the subsequent artifact tool dispatch are not a transaction
with unrelated processes: another process can write between verification and
the tool body. Cross-process isolation, rollback, locking, and atomic replacement
must come from the host filesystem, sandbox, or transactional storage API. It
also treats registered same-process plugins and tool implementations as part of
the host trust boundary: arbitrary code that bypasses the tool registry or
writes directly still requires process or OS isolation. It
also adds unnecessary control to tasks a capable model can already solve in one
bounded pass. That is why automatic bypass, not always-on planning, is the
default.

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
- unguarded-call upgrade rejection, guarded definition pinning, scoped-shadow
  rejection, registry-change revocation, and commit-point epoch checks;
- v1 and v2 restart recovery, including pre-restart dual-file tampering;
- live-owner parent-child inheritance, forged-lineage rejection, and the
  delegated-agent question and ancestor-disposal boundaries;
- all v0.3 graph, receipt, reframe, scale, and compatibility behavior;
- recovery and bounded status projection for a 100,000-node durable graph; and
- a public development corpus, five immutable failed first-reveal archives,
  four immutable pre-reveal failure protocols, a source-grouped offline-model
  training report, and bilingual causal counterfactuals that change wording
  while preserving task invariants.

Router gates are: simple-task false activation at most 5%, complex critical-task
recall at least 90%, no outcome-critical bypass, and 100% explicit override
compliance.

The five retained first reveals all failed and are not reused as blind
evidence. V1 measured 57.5% simple-task false activation, 86.25% complex-task
recall, and 11 outcome-critical bypasses. V2 measured 20.69%, 59.68%, and 28;
V3 measured 31.48%, 59.09%, and 27. V4 measured 28.33%, 63.33%, and 21,
with only 20.83% Lattice recall. Their prompts and labels may be used for
development only. A previous post-reveal router reached 97.5% exact accuracy on
V4; that was regression fitting, not blind evidence, and it is not a release
claim. Tests preserve every original manifest and first reveal. V5 then measured 13.33%
simple-task false activation, 45% complex-task recall, 22 critical bypasses,
53.33% exact accuracy, and 12.5% Lattice recall on repositories and URLs absent
from V1-V4. It also failed. Post-reveal audit found A/B agreement on all three
causal axes in only 86/360 candidates; 35/36 frozen contract rows retained
conflicting supporter tuples because V5 voted the route separately from its
causes. V6 therefore froze primitive execution facts first and derived the route
with one deterministic function, but its annotators did not pass the frozen
reliability gates, so no blind set was created. V7 passed reliability but lacked
the required per-language `contract`, `lattice`, and `probe` capacity. V8 found
a duplicated associated commit during source isolation. V9 froze a 5,017-row
source frame but still lacked independently sourced decision and continuity
challenge capacity, especially in Chinese. All four stopped before router
reveal. Paid runs remain disabled until a new source-disjoint protocol passes
its preregistered router gate; no retired protocol is repaired after observing
its failure.

```sh
pnpm test
pnpm run check
pnpm run build
pnpm pack
```

The unexecuted external model protocol is documented in `EVAL_PROTOCOL.md` and
`eval/v0.4/`. Its current router binding is a retained failed gate, so paid mode
remains locked and the matrix is not current release evidence. The design
freezes 90 statistical runs plus 6 excluded infrastructure
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
independent reproduction. ICAE intervals and the EvoCode finite-suite
robustness interval resample the independent task after averaging the two
repetitions within that task; repeated runs are not treated as additional
independent benchmark tasks. EvoCode has only three such tasks, so its interval
is not presented as population-calibrated confidence evidence.

The candidate can become a stable evidence-backed v0.4 release only if simple
tasks add zero model turns and stay within the overhead/non-inferiority bounds,
ambiguous-task hidden scores improve by at least 50% and 15 percentage points
with a positive paired-bootstrap lower bound, and dynamic requirement
regressions fall by at least 50%. Until those conditions are measured on a new
independently preregistered candidate, this repository makes no general v0.4
uplift or ranking claim.

## License

MIT
