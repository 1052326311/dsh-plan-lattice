# Plan Lattice

**Execution-time drift control for long-running DeepSeek Harness agents.**

[![GitHub release](https://img.shields.io/github/v/release/1052326311/dsh-plan-lattice?include_prereleases)](https://github.com/1052326311/dsh-plan-lattice/releases)
[![Verify](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml/badge.svg)](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml)
[![First-drift stress test](https://img.shields.io/badge/first--drift-12%2F12_to_0%2F12-brightgreen)](demo/results/first-drift-benchmark.md)
[![SIGKILL recovery test](https://img.shields.io/badge/SIGKILL_recovery-2%2F2_to_0%2F2-brightgreen)](demo/results/crash-continuity-benchmark.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#workflow--automation)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Plan Lattice makes DeepSeek Harness's native Plan, Todo, Session, tool evidence,
compaction, and subagent lifecycle behave as one long-task execution workflow.
In default `auto` mode, small bounded tasks bypass it completely. Complex tasks
must create an ordered native Todo, work one active item, verify after mutation,
update that item before advancing, and reread the exact root request and native
Plan before replanning. Compaction, restart, max-token continuation, and fresh
children recover that same task-scoped cursor instead of inheriting an
increasingly lossy summary.

Auto adds no parallel contract, planner, scheduler, child protocol, workspace
graph, or extra model call. It exposes only `lattice_refresh_context` when the
native Todo itself must be replanned. A recursive graph and one-use action bases
remain available as explicit full-Lattice transaction control.

![First-drift mechanism results](demo/results/first-drift-summary.svg)

**Hand-designed mechanism stress test using real Harness runtime services:**

- Unsafe stale-basis mutations: native `12/12`; Plan Lattice `0/12`.
- Matched legitimate controls: native `7/7`; Plan Lattice `7/7`.
- Unsafe post-`SIGKILL` continuations: native `2/2`; Plan Lattice `0/2`.
- Matched post-restart controls: native `2/2`; Plan Lattice `2/2`.

[`Benchmark`](BENCHMARK.md) ·
[`Raw results`](demo/results/first-drift-benchmark.json) ·
[`Crash results`](demo/results/crash-continuity-benchmark.json) ·
[`Executable driver`](demo/first-drift-benchmark.mjs) ·
[`Field reports`](https://github.com/1052326311/dsh-plan-lattice/discussions/1) ·
[`CI`](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml)

> Status: `v0.3.0` remains the latest stable release; `v0.4.0-rc.6` is the
> current public runtime candidate. This checkout contains unreleased rc.9
> DSH-native workflow work, not an evidence-backed stable release. Focused
> mechanism and lifecycle tests have passed. V20 is a retained negative result:
> both arms scored 100, but the candidate exceeded its 4M input-token budget
> and did not execute final integration, so no uplift claim or release is
> allowed. V18 is also a retained negative result: native scored 88
> with one hard miss, while the candidate scored 75 with two hard misses. The
> V18 driver bypassed DSH's model-facing foreground subagent result path, so it
> is neither evidence of uplift nor a valid delegation-continuity comparison.
> It must not be rerun under the same identity. The earlier frozen V17 pair produced an
> exploratory 100 versus 84 score and zero versus one hard miss, but both arms
> exceeded the 4M-input-token budget and neither completed all five lifecycle
> stages. The result therefore fails its preregistered evidence gate and is not
> a quality or uplift claim.
> The crash-safe
> [`v3 external-model study`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/model-rc4-study-protocol-freeze-v3)
> is frozen but has not executed against this runtime, so no general
> coding-quality uplift or ranking is claimed.

## Evidence At A Glance

| Claim | Current evidence | Status |
| --- | --- | --- |
| Stale long-task mutations can be stopped without disabling valid work | Real Harness mechanism stress test: unsafe entries changed from native 12/12 to Plan Lattice 0/12; both arms executed 7/7 matched legitimate controls | [Reproducible](BENCHMARK.md) |
| A side effect without a settled tool result cannot be silently forgotten after process death | Two fixed hazards kill the worker with real `SIGKILL` before the mechanical receipt; native executes the later mutation in 2/2 cases and Plan Lattice in 0/2, while both arms pass 2/2 legitimate restart controls | [Reproducible](demo/results/crash-continuity-benchmark.md) |
| Explicit full control fences quiet follow-ups against its accepted contract | Every durable human message is reviewed against the exact contract revision; implicit English and Chinese changes are covered | Covered by real Harness integration and stress tests; not an automatic-mode claim |
| Explicit full control fences old graph branches after reframe | Every non-archived node, including a previously complete node, is reconciled with the new contract | Covered by real Harness integration tests; not an automatic-mode claim |
| Clear tasks avoid automatic orchestration overhead | Default `auto` injects no Lattice policy or tools, creates no workspace `.dsh` state, and adds no controller model call | Integration tests; exploratory real-model repeats do not establish per-run overhead non-inferiority |
| The published RC.6 artifact loads on official Harness rc.7 | CI downloads the exact release tarball, verifies SHA-256 `9e522d43877debcccbcad1e1ebb15916fbb35d50a9a98032bdc6149802c30082`, installs it into a fresh profile, boots the real Web host, and observes all 16 `lattice_*` tool schemas | [Continuously verified](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml) |
| The candidate improves a dynamic long system | V17 scored candidate 100 versus native 84 with zero versus one hard miss, but both arms exceeded 4M input tokens and stopped before the five-stage lifecycle completed | [Retained invalid result](eval/long-system/v17/RESULT.md), not evidence of uplift |
| Native passive continuity improves a dynamic long system | V18 scored candidate 75 versus native 88 and used an invalid external subagent lifecycle that did not return the child result through the parent Session | [Retained negative result](eval/long-system/v18/RESULT.md), not evidence of uplift and not rerunnable under the same identity |
| Boundary-scoped native continuity improves a dynamic long system | V20 scored both arms 100; candidate used five fewer turns and less wall time but exceeded the input budget before final integration | [Retained negative result](eval/long-system/v20/RESULT.md), not evidence of uplift and not rerunnable under the same identity |
| Native recovery preserves child prompts and remains bounded | V21 preserved the native fork prompt/result path, but both arms scored 100, failed the exact lifecycle/budget gates, and exposed fork-seed metric double counting | [Retained negative result](eval/long-system/v21/RESULT.md), not evidence of uplift and not rerunnable under the same identity |
| Native authority recovery improves a non-ceiling long system | V22 completed both frozen arms at 87/100; the candidate added requests and tokens but produced zero quality delta and retained two hard misses | [Immutable negative result](eval/long-system/v22/RESULT.md); rerun, selective rescoring, and positive claims are forbidden |
| The external benchmark driver uses the real frozen Harness path | Local end-to-end fixture verifies the credential proxy, exact model contract, durable Session JSONL, token accounting, timeout handling, and secret redaction | Driver verified; paid matrix not run |
| General software-task quality improves | Requires the frozen 90-run ICAE/EvoCode/simple-task matrix and `releaseAllowed: true` | Not established |

## Try It

Try the public `v0.4.0-rc.6` runtime candidate represented by the mechanism
evidence above:

```sh
gh release download v0.4.0-rc.6 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.4.0-rc.6.tgz
```

For the stable `v0.3.0` release:

```sh
gh release download v0.3.0 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.3.0.tgz
```

The stable release is also listed in the community-maintained
[`Awesome DeepSeek Harness Plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#workflow--automation)
catalog and its [`dsh-market`](https://github.com/dsh-market/dsh-market)
storefront. The catalog currently points to the audited `v0.3.0` tarball;
RC.6 remains an explicit prerelease install until its external evaluation is
complete.

The package is an independent community plugin for DeepSeek Harness. To build
the current checkout from source, run `pnpm install`, `pnpm pack`, and install
the generated tarball with the same `dsh plugin --profile web add` command.

## The First-Drift Test

A long task does not usually fail because its plan file vanished. It fails when
one mutation finally executes from a basis that was incomplete, compacted away,
superseded, or changed elsewhere. Explicit full-Lattice control makes that
boundary executable:
it joins the accepted contract, exact target bodies, live ownership, observable
external preconditions, and, only in explicit full-Lattice mode, the current
root-to-leaf address and required semantic evidence into a one-use authorization
epoch.

The repository includes a deterministic stress test built on the real Harness
context, session, agent-registry, compaction, and tool-runtime services. It
deliberately invalidates one part of that basis immediately before a protected
mutation. Each controlled arm must block before the protected tool body runs
and match its preregistered enforcement mechanism; an unrelated exception does
not count as a pass:

| Engineered hazard | Native Harness | Plan Lattice |
| --- | ---: | ---: |
| Changed target file | unsafe mutation executed | prevented |
| Changed accepted background | unsafe mutation executed | prevented |
| Compacted model-visible context | unsafe mutation executed | prevented |
| Late material user input | unsafe mutation executed | prevented |
| Implicit acceptance change | unsafe mutation executed | prevented |
| Implicit truth-source change in Chinese | unsafe mutation executed | prevented |
| New input after review preparation | unsafe mutation executed | prevented |
| Unscoped shell mutation | unsafe mutation executed | prevented |
| Changed external precondition | unsafe mutation executed | prevented |
| Middleware argument rewrite | unsafe mutation executed | prevented |
| Self-consistent contract-file rewrite | unsafe mutation executed | prevented |
| Disappeared delegated parent | unsafe mutation executed | prevented |

**Observed result on these 12 engineered hazards: native executed 12/12 unsafe
mutations; Plan Lattice executed 0/12, a 100 percentage-point difference on the
tested mechanism.** Reproduce it locally:

```sh
pnpm install --frozen-lockfile
pnpm run demo:first-drift:check
```

This is intentionally a mechanism stress test, not a sampled benchmark of
software tasks. The 100% prevention rate applies only to the 12 hazards the
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
trustworthy historical source frame. V13 replaces mutable search with 24
prospective, versioned GH Archive hour objects, freezes their raw gzip Merkle
root before parsing any body, and uses a future public drand round only after
three-annotator reliability and exact max-flow capacity pass. The complete
protocol and router source are bound by the public
[`router-v13-protocol-freeze-v2`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v13-protocol-freeze-v2)
release before source access. The original V13 tag was retired before source
access after a crash-recovery audit; v2 keeps the source, router, labels, and
gates unchanged while making its one reveal single-execution and crash-safe.
These negative and retired results remain in the repository and are not
repaired or relabelled as release evidence.

V13 has exactly one reveal and eight preregistered router gates. Passing it
would establish source-disjoint automatic-control accuracy on that frozen
sample only; it would not establish general coding-quality uplift. The
executable stages, raw evidence requirements, thresholds, and retirement rules
are in the
[`V13 preregistration`](eval/router-corpus/v13/PREREGISTRATION.md). Run all
protocol controls locally with:

```sh
pnpm run router:v13:test
```

The RC.4 external-model study has a second, stricter evidence boundary. Its
candidate, 96-slot order, hidden graders, release thresholds, first public
runtime build, V13/V14 router gate, controller, preflight, analyzer, and retry
policy are frozen before any paid model call. A later execution envelope may
bind only the independently revealed router outcome, the preselected runtime
bytes, and a new signing identity. See the
[`preregistration`](prospective/model-rc4-study/PREREGISTRATION.md) and public
[`v3 protocol freeze`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/model-rc4-study-protocol-freeze-v3).
Until its analyzer returns `releaseAllowed: true`, router accuracy and
mechanism tests do not support a general software-quality claim.

## Automatic Control

New installations default to `activationMode: auto`. A zero-model-call route
runs before first prompt assembly:

- a clear bounded task uses `bypass`, with no prompt, tool, guard, state file, or
  extra call;
- an uncertain task uses a read-only probe until repository evidence resolves
  its risk;
- a complex task keeps DSH as the sole planner and executor, while Plan Lattice
  enforces DSH's own Todo as the task cursor.

| Mode | Owner of planning and execution | Plan Lattice effect |
| --- | --- | --- |
| `off` | DSH | None |
| `auto` bypass | DSH | None |
| `auto` complex | DSH | Native Todo transition, evidence, replan, completion, continuity, and delegation gate |
| `always` | DSH plus explicit Plan Lattice transaction control | Contract, graph, receipts, leases, checkpoints, evidence gates, and guarded mutations |

For a complex task, the enforced native workflow is:

1. Before protected implementation, write at least two concrete Todo items with
   exactly one `in_progress` and the rest `pending`.
2. Work only on that item. A Todo update and another execution tool cannot share
   one model step.
3. An implementation item needs concrete mutation evidence. A deterministic
   test, typecheck, build, or lint command must start only after the latest
   mutation settles, then succeed. Ordered result rendering from concurrently
   started calls is not causal verification; naming a read, browser, or
   subagent call "verify" does not make its prose a success criterion. Failed,
   timed-out, aborted, ambiguous, or non-zero commands do not count.
4. Mark that item complete immediately, and activate at most the next pending
   item in the same whole-list update. No rollback, skip, or batch completion.
5. If discovered facts invalidate the remaining work, call
   `lattice_refresh_context`. It restores the exact root request, successful
   task-scoped `exit_plan_mode` Plan, current Todo, and evidence debt; the next
   `todo_write` either reaffirms the exact remaining snapshot or replaces only
   its unfinished suffix. The completed prefix is immutable.
   A successful native `ask_user_question` result is treated as new human
   authority and creates the same refresh/replan debt; the answer remains in
   the Session evidence rendered by the refresh.
6. An unresolved Todo keeps the AgentLoop working. Repeating a completion claim
   without any changed Todo or evidence closes the DSH turn as `blocked`, not
   `error`, and does not claim completion. Only all-complete stops normally.

Only an exact positive allowlist is read-only; a tool merely containing a name
such as `read` or `view` is still a mutation until proven otherwise. Code Mode is
supported by folding every rc.7 `tool/code-dispatch-*` pair and applying the
same global guard to each nested call; one `run_code` program cannot combine
`todo_write` with another action. Detached or asynchronous transports such as
`terminal_send`, background Bash, `workflow`, and `ralph` fail closed in this
mode because one outer result cannot prove their later lifecycle. The rc.7
continuable `subagent` defaults to background execution, so controlled work
must set `run_in_background: false` when the parent depends on its settled
result. Use direct foreground DSH tools or explicitly select full Lattice
control.

The projection is assembled from DSH's append-only Session log and starts at the
exact anchored root-task message, so an older task's Plan, Todo, or child result
cannot authorize the current task. A committed `surfaceOp.replace` or cold
resume additionally restores exact human authority hidden from the model. A
fresh child retains its parent-authored DSH prompt byte-for-byte and receives a
separately sourced capsule with the root request, Plan, current Todo, and
evidence debt. It cannot edit the root Todo or question the human.

When every Todo item is complete, the next root user request begins a new task
epoch and is routed independently. Its authority anchor replaces the previous
one, and projection begins at that new message. A bounded follow-up can return
to true bypass; a new complex request must create a fresh Todo and cannot reuse
the prior task's Plan, completed items, or evidence.

The rc.7 native Todo schema contains only `content` and `status`. Automatic mode
therefore proves ordered ownership and evidence timing, but cannot prove that a
mutation's semantic target matches the prose of the active item. Tasks that
need path-, resource-, or host-state binding must use explicit full Lattice;
the plugin does not substitute brittle text similarity for that guarantee.

Full contract and graph control is opt-in through `activationMode: always`, an
explicit `Use the full Lattice` request, or resumed legacy graph state. This is
the mode in which intake, contract reframe, per-target receipts, leases,
checkpoints, and graph transactions apply.

## Root Invariant

Within the controlled long-task execution domain, drift has one precise form:
**a protected mutation executes from an intent or fact basis that is incomplete,
no longer authoritative, or no longer current**. If such drift occurs, the
ordered execution has a first protected mutation with that invalid basis. This
is a scoped invariant for that failure class, not a law about every model error
or every task. Compaction, handoff, parallel agents, revised requirements, plan
edits, and external state changes are mechanisms that can invalidate the basis.

The stable invariant is therefore not “keep a longer prompt” or “refresh before
every edit.” It is: **execution may advance only from the current task-scoped
root intent, native Plan, active Todo, and evidence produced for that item**.
Default `auto` keeps DSH as owner of planning, tools, and lifecycle, while
mechanically rejecting illegal Todo transitions, protected mutation without an
active cursor, replan without exact context refresh, and completion with
unresolved work.

Explicit contract and full-Lattice modes intentionally provide a stricter
pre-action basis containing:

1. the complete accepted execution contract;
2. the exact current contents of every declared target file, or a digest-bound
   fact that the target does not yet exist;
3. any proof still required from prior protected work; and
4. host-observable preconditions for non-filesystem side effects.

Only explicit full-Lattice mode adds a checked-out leaf and full root-to-leaf
plan to that basis. Default auto mode does not create graph nodes, leases, or
semantic checkpoints; DSH's native Plan Mode and Todo remain the sole planning
representations.

In explicit full control, `lattice_refresh_context({ targetPaths })` rebuilds and
verifies that basis internally. In a stable native DSH conversation the
original user request is already visible, so the result projects only the new
receipt, exact target facts, and an optional full-Lattice leaf. It reprojects
the full immutable contract only after a real surface replacement, resume,
delegation, or material reframe. A built-in
`write`, `edit`, or mutating `str_replace_editor` call is accepted only when its
actual path is one of those targets and its body still matches the observed
digest. The joined authorization epoch is consumed before validation or
dispatch in explicit control, including failed attempts, so parallel or retried
mutations cannot reuse it. A prepared dispatch then binds and locks the call identity and exact
arguments; supported authority invalidation while an asynchronous dispatch
middleware waits aborts the call before tool-body entry. The guard compares the
contract revision and aggregate digest of every declared target, plus the graph
revision and root-to-leaf digest only in explicit full-Lattice mode. Surface
replacement, resume, reframe, plan mutation, handoff, disposal, or a concurrent
durable change invalidates the whole epoch. Read-only `str_replace_editor view`
calls do not.

The first accepted global definition for each guarded tool is pinned for the
process lifetime, including its `execute` function. Scoped same-name shadows and
later global replacements do not inherit trust, and any supported registry
change aborts an active guard-to-body dispatch. Plan Lattice also locks the name
and arguments of initially unguarded calls at its first dispatch middleware, so
a later middleware cannot upgrade a harmless call into `write` or `edit` after
the guard has run.

Non-filesystem guarded tools require a programmatic host precondition adapter.
An adapter can bind exact action arguments to observable external state, or it
can expose `snapshotScope` plus `verifyScope` for a host-observable scope such
as the complete writable workspace. Scope authority does not pre-approve raw
arguments: the guard still normalizes the eventual action, consumes one
authorization epoch, locks the complete call identity, and rechecks the scope
before tool-body entry. An explicit action binding suppresses broader automatic
scope authority for that tool. Without either proof mode the guard fails closed.
This includes `strictBash`: declaring files cannot prove that arbitrary shell
text has no other side effects.

An adapter may implement `normalizeArguments` when the host tool adds
display-only metadata after the context receipt is prepared. The normalized
identity must be a synchronous, finite, acyclic JSON value; promises, class
instances, sparse arrays, `undefined`, and non-finite numbers fail closed.
`snapshot` and `verify` still receive the complete raw arguments. The adapter
must reject every field omitted from the identity that can change execution
semantics; only presentation metadata may be ignored.

In explicit full-Lattice mode, the recursive tree is a persistent execution
address rather than a Todo display. Default auto mode does not add that address:
after replacement compaction, cold resume, or handoff, it re-projects the native
human authority, approved Plan, current Todo, returned child results, and Session
lineage that DSH already recorded. A summary, model memory, inherited message,
or `parentSession` does not replace those native records.

Inbox arrival and durable message append each invalidate authority. This closes
the interval in which a receipt could otherwise be reissued after a message was
queued but before it became model-visible. Every new human message after
contract commitment stays fenced until the root agent reads the complete
contract and exact pending messages with `lattice_review_input`, then durably
commits `contract-unchanged` or `contract-changed` with
`lattice_commit_input_review`. Another message consumes the prepared review.
Plugin-authored operational notices also revoke ephemeral action authority, but
they cannot revise the human product contract or raise `reframePending`.
Delegated agents revalidate every
live parent ownership edge when authority is issued, consumed, and dispatched;
a stale `parentSession` value cannot revive a dead handoff.

In explicit full-Lattice mode, structural plan changes obey the same rule. Adding, splitting, updating,
archiving, or checking out a node requires a one-action receipt from a complete
contract and exact current plan-neighborhood reread; the change consumes the
receipt and advances the revision. An artifact edit additionally binds the
current root-to-leaf plan to the exact target body. A compacted summary never
substitutes for either read.

In explicit control, the accepted contract, invariants, and acceptance criteria
are the current constants. Discovered facts, plans, declared mutation targets,
executors, and external state may change; a trend never authorizes a mutation.
Default auto mode has no contract or per-target action binding. It enforces the
task-scoped DSH-native Todo/evidence order while DSH owns planning and
execution. An explicitly selected tree adds a durable root-to-leaf address
without freezing changeable state.

The formal control domain, derivation, mutation protocol, and falsification
conditions are documented in [`docs/FIRST_PRINCIPLE.md`](docs/FIRST_PRINCIPLE.md).
The exact rc.7 request, compaction, plan/todo, and subagent integration boundary
is documented in [`docs/DSH_NATIVE_INTEGRATION.md`](docs/DSH_NATIVE_INTEGRATION.md).

## Configuration

```yaml
- id: plan-lattice
  config:
    activationMode: auto          # off | auto | always
    clarificationPolicy: critical # critical | always | never
    controlCeiling: lattice       # contract | lattice
    longTaskThreshold: 8
    maxTokenContinuations: 0      # opt-in; bounded per durable session
    guardedTools: [write, edit, str_replace_editor]
    strictBash: true             # v0.4 default; also guards pwsh
    maxContextBytes: 262144
    topLevelLimit: 2
    nestedLimit: 5
    snapshotEvery: 1024
    # Defaults below DSH_HOME; keep outside every agent-writable workspace.
    # contractAnchorRoot: /absolute/trusted/plan-lattice-anchors
```

`longTaskThreshold` and `clarificationPolicy` inform automatic routing;
`guardedTools` and `strictBash` define which complex-task actions require a
valid native Todo cursor. They still create no automatic contract or graph.
Under `activationMode: always`,
`controlCeiling: contract` provides the contract-only tier and ablation arm;
`strictBash: false` weakens that tier's mutation-time guarantee. Function
adapters are host composition and therefore cannot be expressed in YAML.

When an explicitly controlled `contract` or `lattice` turn ends because the model reached
its output ceiling, `maxTokenContinuations` uses DSH's native `followup()` to
queue a clean next turn. It never runs for `bypass`, never uses same-turn
`steer()`, stops while a reframe is pending, and counts its own continuation
messages from the durable Session log. The default is zero, preserving DSH's
manual-continuation behavior; set a positive bound to opt in. This can prevent a
known terminal state from abandoning controlled work. It does not improve model
reasoning or turn a vague task into a well-defined one.

Task text can override configuration:

- `Do not use Plan Lattice` / `不要使用 Plan Lattice` forces `bypass`.
- `Do not ask; make reasonable assumptions` / `不要提问，合理假设` keeps the
  selected control level but changes clarification to `never`.
- `Use the full Lattice` / `使用完整 Lattice` forces the configured maximum
  control level.

### v0.3 Migration

An explicit legacy `intakeMode` keeps v0.3 behavior when none of the new fields
is present, including no automatic max-token continuation. Mixing old and new fields is a configuration error with migration
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

## Explicit Contract Protocol

This contract/graph protocol is inactive in default `activationMode: auto`. It applies only to
`activationMode: always`, an explicit full-Lattice request, or compatible legacy
state. Automatic complex-task control exposes only
`lattice_refresh_context`, and only before changing native Todo content or
order; it never invokes the explicit contract/graph tools.

`lattice_intake` records the system boundary, time horizon, observable outcome,
facts, decisions, invariants, changeable forms, directional forces, causal
variables, assumptions, unknowns, and acceptance readiness.

- With no critical questions, it atomically commits the contract immediately.
- With questions, it asks through the real Harness user-question channel and
  returns a `pendingIntakeId` plus the answers. Nothing is persisted yet.
- `lattice_commit_intake` must bind every answer exactly once as a confirmed
  fact, decision, invariant, or explicit unknown before the contract is
  committed.
- Under contract control, `clarificationPolicy: never` rejects questions and
  requires visible, reversible assumptions in one compact `lattice_intake`.
- Under full Lattice control, the same policy skips the separate intake model
  turn: parameterless `lattice_open {}` binds the exact human request from the
  durable Session log and creates a stable accepted-outcome root plus one
  refinable executable leaf. The agent inspects repository evidence after open
  and refines only the next path instead of spending a turn restating the
  contract or designing the entire graph. Explicit plans remain supported.
- Delegated agents cannot question the user or establish the root contract;
  they return missing information to their parent.

Explicit contract control permits guarded work after commitment without
requiring a node checkout and can require a fresh contract and target-file basis
per mutation. Full Lattice control additionally requires
`lattice_open`, a current context receipt, an active leaf lease, the current
root-to-leaf plan, and semantic checkpoints for verified leaf progress,
blockers, and completion.
Every settled guarded action receives a controller-generated mechanical execution receipt
whether the tool succeeds or fails. Mechanical receipts record exact attempt
identity and the guarded `tools/execute` around-dispatch observation for crash
recovery. The observation is captured before DSH's private registry
normalization, `tools/post-execute` policy, and definition-owned
`finalizeContent`, because none can undo a potentially attempted side effect. A
downstream wrapper's authored result or thrown error may therefore differ from
the later normalized presentation. A wrapper may also short-circuit without
invoking the tool body, so the receipt proves durable admission and an observed
wrapper outcome, not body execution. Its digest covers the stable
`isError`/`content`/`error`/`meta` projection and deliberately excludes values,
additional contexts, and turn-control flags. Mechanical receipts never count
as acceptance evidence and do not complete a node.

Every human message supplied after contract commitment pauses guarded work,
including quiet follow-ups such as `continue`. The two-stage input review binds
the exact durable message sequence and accepted contract revision. If the
contract is unchanged, authority is rebuilt from a fresh context read. If it
changed, only `lattice_reframe` can resume work. Wording heuristics may fence an
obvious material change earlier but never classify input as harmless.

In explicit control, when a declared contract file changes or a
`surfaceOp.replace` event replaces model-visible history, guarded work also
pauses. `compaction/summary` and
`compaction/prune` are append-only audit records and do not create a boundary by
themselves; the replacement message emitted by the native compactor or pruner
does. Resumed sessions preserve that exact event. `lattice_reframe` commits a
new contract revision; explicit contract and full-Lattice modes may bind
`targetPaths` for the next mutation. Full-Lattice mode rereads its current plan.
Existing graph nodes remain visible in that
mode, but every non-archived node is marked
non-executable, including nodes that were complete under the old contract.
`lattice_update` explicitly reconciles one inspected node with the new
contract; checkout remains blocked until the complete root-to-leaf lineage has
been reconciled or stale leaves have been archived. Prior evidence remains as
history, not proof that the revised contract is complete.

Plan Lattice does not implement a second conversation compactor. DeepSeek
Harness owns summary compaction and model-free tool-result pruning, including
surface replacement and immutable event provenance. Deployments should compose
`@deepseek-ai/dsh-compaction-basic` with
`@deepseek-ai/dsh-compaction-tool-result-pruner` for large tool output. In
automatic mode, Plan Lattice consumes replacement events to restore exact root
authority while its native Todo/evidence cursor continues across turns. In
explicit control, the same event also
revokes stale mutation authority and requires the configured contract, graph,
and target rereads.

The confirmed `id`, revision, digest, and full last accepted contract are also
stored in a session-keyed trust root below `DSH_HOME` (or
`contractAnchorRoot`). Rewriting `CONTRACT.md` and `contract.json` together does
not move that anchor. The mismatch survives process restart, blocks guarded
writes, and can be replaced only through `lattice_reframe`. The anchor root must
remain outside paths writable by the tested agent.

## Multi-Agent Sessions

A one-shot child inherits its root task's control level only when
`parentSession` agrees with the Harness's live `isOwnedBy` relation. An rc.7
continuable child instead receives the same binding through DSH's exported,
exact-version-pinned `registerContinuableSetup` pre-publication extension,
because the continuation manager's private activation scope is its process-local
owner. Durable lineage metadata
alone never authorizes inheritance. Plan Lattice does not construct or replace
the delegation prompt: DSH fork, spawn, and continuable providers own the child
seed, user message, persona, policy, tool scope, scheduling, and result delivery.
Automatic mode preserves the model-authored child first message byte-for-byte
and separately projects a read-only root capsule containing exact human
authority, task-scoped approved Plan, current root Todo, evidence debt, Session
lineage, and the exact first-message identity through DSH's scoped runtime-context channel.
For a fork child, replacements contained in the inherited completed-turn seed
are already represented by DSH's current child surface and never activate a
fresh-child recovery snapshot. Only a later replacement in the child's own
event suffix is a child continuity boundary.
If replacement hides the child's own initial instruction, that exact native
message is re-projected from the anchored child Session event. Explicit
full-Lattice mode can also carry
the current outcome, decisions, invariants, node, acceptance, unknowns, and
graph revision. It does not give the child authority to ask the human. Missing
boundary information is a parent-facing result, not a reason for the child to
guess.

This boundary must be exercised through the published rc.7 model-facing
`@deepseek-ai/dsh-tool-subagent` plugin: its `prompt` argument remains the exact
first child user message, and its foreground result must return to the parent as
the matching native `tool/result`. The plugin does not maintain a second child
prompt template, scheduler, transport, or result channel.

DSH delivers the initial delegated task as the child's first own user-role
message. In automatic mode Plan Lattice stores only the child, root, and parent
Session IDs plus that exact first-message ID and digest outside the workspace;
it does not copy the message text. This anchor verifies which native child input
the continuity projection accompanies. Explicit control may additionally use
live ownership and continuable setup evidence to enforce its scoped transaction
rules.

Explicit full-Lattice and legacy control require DSH runtime context and every
tool in the selected phase's protocol. `agent/pre-step` is an early diagnostic.
When downstream native work changes model-visible state after assembly, the
plugin preserves already-claimed input and invalidates protected-mutation
authority rather than synthesizing a request. One `llm/stream` wrapper binds the
deep-frozen AgentLoop request to the exact rendered system prompt, latest
complete snapshot body, current authorization epoch, exact callable wire
schema, and the exact tool-definition identities visible to that Agent. It
validates before entering downstream middleware and again before accepting each
returned chunk. A global `tools/change` is revalidated against the affected
Agent's exact live definition view: an unrelated Agent's restriction does not
invalidate this request or an active guarded dispatch, while a changed local
definition, presentation mode, Code Mode SDK section, or final wire does. The
plugin never invokes the public prompt-assembly waterfall a second time.
Default automatic mode trusts DSH's native request assembly; its independent
tool guard validates native Todo ownership and transition order. Full request
attestation and one-use transaction authorization apply only to explicit
full-Lattice and legacy control.

When DSH native plan mode is active, DSH owns the planning turn, review, and
`exit_plan_mode`. Automatic mode recovers the latest task-scoped successful
`exit_plan_mode` plan after continuity loss, for delegated capsules, and before
a native Todo replan; it never blocks or replaces native Plan Mode. Explicit full-Lattice mode may
project a current leaf and enforce its own transaction boundary without creating
a competing planning state machine.

rc.7 restores a `complete` persona after the public assembly waterfall and
does not publish the restored final assembly. Request-attested full Lattice therefore
fails closed with a complete persona instead of claiming to attest text it
never observed. Use an ordinary persona, or explicitly bypass Plan Lattice for
that task. rc.7 also has no load-order-independent pre-adapter hook or atomic
chunk-admission guard. If an asynchronous downstream checkpoint changes
authority after the initial check, the adapter request may already start; the
tested checkpoint ordering rejects its first chunk before Session append.
There remains a smaller host TOCTOU window between Plan Lattice yielding a
validated chunk and AgentLoop appending it. A stale terminal `finish` chunk in
that window can form a complete stale assistant message and re-enter the model
surface on a later step. Protected tool calls in that message still cannot
bypass the independent tool guard, but eliminating the stale event and message
requires an upstream atomic admission seam. The general upstream fix is a post-final-assembly observation plus a
synchronous adapter-dispatch and chunk-admission guard;
these rc.7 limits are detailed in
[`DSH_NATIVE_INTEGRATION.md`](docs/DSH_NATIVE_INTEGRATION.md). A preset that
suppresses runtime context or hides/replaces the required transport is rejected
before the initial downstream request.

Plan Lattice does not spawn or schedule agents and does not deliver their
results. DSH owns those mechanisms. Automatic mode supplies a read-only root
execution capsule and validates the parent's Todo/evidence cursor; explicit
full control additionally maintains its opt-in contract and evidence state.

## Storage And Privacy

```text
.dsh/plan-lattice/v1/  # existing graph, ledger, history, and legacy intake
.dsh/plan-lattice/v2/  # new CONTRACT.md and digest-bound contract.json
.dsh/plan-lattice/execution-state/v1/  # stable path; schema v2 lease and exact pending-attempt identity
$DSH_HOME/plan-lattice/contract-anchors/v1/  # independent session trust anchors
```

Execution-state schema v2 continues to read schema v1 records without rewriting
them in place. A clean v1 lease can resume normally. A dirty v1 lease lacks an
exact attempt identity, so it becomes `legacyIndeterminate` and remains blocked
instead of guessing which action occurred. A release requested while an exact
attempt is dirty is also stored in this lease. Restart recovery can therefore
settle the matching mechanical receipt and release ownership atomically; a
failed release remains visible and retryable rather than disappearing from
in-memory status.

Default `auto` creates none of the workspace directories above. Its
Session-keyed authority and delegation anchors live below `DSH_HOME` and contain
message identities and digests, not copied prompt text. Explicit v2 contract
files contain the generated framing and bound human answers, so treat them as project-sensitive state.
Repository documents are referenced and hashed rather than copied into the
Lattice state, although complete document contents appear in model-visible tool
results after a continuity boundary or when a relevant document digest changes.

API credentials are never configuration fields. Evaluation and production
providers must receive them through process environment variables or an
equivalent host secret manager.

## Guarantees And Limits

In explicit full control, the plugin can reject concrete stale-state transitions: writing before framing,
writing while routing is unresolved, advancing a graph without a current
receipt, continuing after compaction without rereading, using a contract whose
digest changed, editing an undeclared target, editing a target changed after
observation, reusing one pre-action basis for multiple mutations, or resuming
after a process crash while a prior guarded action lacks its exact mechanical
receipt. The graph receipt commits before durable execution-state settlement,
so restart can reconcile that exact attempt. A legacy or unmatched dirty action
remains indeterminate and blocks replay.

Durable execution ownership serializes Plan Lattice runtimes that use the same
workspace. It does not serialize unrelated processes that write directly to
the repository or `.dsh` state. Those processes remain inside the host trust
boundary and require OS, sandbox, or transactional isolation.

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
bounded pass. That is why high-confidence small tasks bypass. Automatic complex
control guarantees only cursor ownership, legal Todo progression, evidence
order, task-scoped recovery, and fail-closed completion for configured tools;
it does not prove semantic correctness or replace host approval and sandbox
policy.

## Verification

The local suite exercises real Harness `Context`, agent scopes, first-inbox
events, system-prompt assembly, dynamic tool restrictions, session compaction,
the user-question service, and the tool runtime. It covers:

- zero-overhead bypass for clear bounded tasks;
- complex-task initial Todo enforcement, one-active-item ordering, and
  same-step Todo/execution separation;
- mutation plus causally post-mutation verification before item completion;
- false-completion continuation and unchanged-state refusal;
- refreshed replan from exact root request and native Plan;
- answer-triggered replan after native user questions;
- background Bash and real rc.7 default-background continuable-subagent
  rejection before their tool bodies or child sessions begin;
- replacement compaction and cold-resume recovery from DSH Session events;
- task-boundary exclusion of stale Plan, Todo, evidence, and child results;
- recovery of the latest task-scoped approved `exit_plan_mode` plan, cross-turn
  native Todo, and recent foreground subagent results;
- exact child first-message identity without rewriting the model-authored prompt;
- child capsules with root authority, Todo, and evidence debt but no root Todo
  mutation or direct human questions;
- no automatic contract, graph, receipt, lease, extra model call, or workspace
  `.dsh` state;
- direct and two-stage contract commitment with typed answer binding;
- contract-only writes without artificial checkpoints;
- material-change and compaction fences;
- root-to-leaf plan rendering, exact target binding, missing-file binding,
  one-attempt consumption, and stale-target rejection;
- unguarded-call upgrade rejection, guarded definition pinning, scoped-shadow
  rejection, registry-change revocation, and commit-point epoch checks;
- v1 and v2 restart recovery, including pre-restart dual-file tampering;
- cross-process lease compare-and-swap, dead-owner takeover, dirty crash
  recovery by exact attempt identity, graph-first receipt ordering, v1
  indeterminate migration, and release enforcement;
- controller-generated success/error mechanical receipts that remain separate from
  semantic evidence and cannot complete nodes;
- task-scoped native runtime-context projection, including child continuity and
  restart recovery;
- native Todo folding as a cross-turn execution cursor rather than a second
  planner or workspace graph;
- recovery of a successfully reviewed `exit_plan_mode` plan without a second
  Plan Mode;
- native replacement detection without a plugin-owned surface compactor;
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

The retired RC.3 controller is documented in `EVAL_PROTOCOL.md` and
`eval/v0.4/`; it now fails closed when invoked from current `main`. The
crash-safe RC.4 successor is frozen in
[`prospective/model-rc4-study`](prospective/model-rc4-study/PREREGISTRATION.md).
Paid mode remains locked until the V13/V14 router evidence passes and a separate
execution freeze binds those outcomes, so the matrix is not current release
evidence. The design
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
regressions fall by at least 50%. Until those conditions are measured by the
frozen RC.4 v3 study and its analyzer returns `releaseAllowed: true`, this
repository makes no general v0.4 uplift or ranking claim.

## License

MIT
