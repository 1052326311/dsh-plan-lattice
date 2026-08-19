# Plan Lattice

**Execution-time drift control for long-running DeepSeek Harness agents.**

[![GitHub release](https://img.shields.io/github/v/release/1052326311/dsh-plan-lattice?include_prereleases)](https://github.com/1052326311/dsh-plan-lattice/releases)
[![Verify](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml/badge.svg)](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml)
[![First-drift stress test](https://img.shields.io/badge/first--drift-12%2F12_to_0%2F12-brightgreen)](demo/results/first-drift-benchmark.md)
[![SIGKILL recovery test](https://img.shields.io/badge/SIGKILL_recovery-2%2F2_to_0%2F2-brightgreen)](demo/results/crash-continuity-benchmark.md)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#workflow--automation)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Plan Lattice persists accepted intent and a recursive work plan, then requires
a one-use, current action basis before each protected mutation. Clear bounded
tasks bypass it with no Lattice prompt, tools, state, or added model call.

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
> current public runtime candidate. This checkout contains unreleased rc.7
> native-continuity work, not an evidence-backed stable release. Its mechanism
> and lifecycle tests pass, but the latest real-model V9 pair reached neither
> compaction, restart, nor delegation because both arms stopped at the native
> `max-tokens` boundary after three requests. The retained negative result is
> not a quality claim.
> The crash-safe
> [`v3 external-model study`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/model-rc4-study-protocol-freeze-v3)
> is frozen but has not executed against this runtime, so no general
> coding-quality uplift or ranking is claimed.

## Evidence At A Glance

| Claim | Current evidence | Status |
| --- | --- | --- |
| Stale long-task mutations can be stopped without disabling valid work | Real Harness mechanism stress test: unsafe entries changed from native 12/12 to Plan Lattice 0/12; both arms executed 7/7 matched legitimate controls | [Reproducible](BENCHMARK.md) |
| A side effect without a settled tool result cannot be silently forgotten after process death | Two fixed hazards kill the worker with real `SIGKILL` before the mechanical receipt; native executes the later mutation in 2/2 cases and Plan Lattice in 0/2, while both arms pass 2/2 legitimate restart controls | [Reproducible](demo/results/crash-continuity-benchmark.md) |
| Quiet follow-ups cannot silently bypass the accepted contract | Every durable human message is reviewed against the exact contract revision; implicit English and Chinese changes are covered | Covered by real Harness integration and stress tests |
| Reframed work cannot execute an old plan branch | Every non-archived node, including a previously complete node, is fenced and must be explicitly reconciled with the new contract | Covered by real Harness integration tests |
| Clear small tasks avoid orchestration overhead | `bypass` injects no Lattice prompt or tools, creates no `.dsh` state, and adds no controller model call | Integration tests plus two exploratory real-DeepSeek repeats: both arms 10/10 and RC.6 zero questions; one repeat had extra agent turns, so per-run overhead non-inferiority is not established |
| The published RC.6 artifact loads on official Harness rc.7 | CI downloads the exact release tarball, verifies SHA-256 `9e522d43877debcccbcad1e1ebb15916fbb35d50a9a98032bdc6149802c30082`, installs it into a fresh profile, boots the real Web host, and observes all 16 `lattice_*` tool schemas | [Continuously verified](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml) |
| The candidate improves a dynamic long system | The frozen V9 real-model pair scored 0/100 in both arms and reached no continuity stage: native stopped after 3 requests / 16,432 input tokens, the candidate after 3 / 18,325; both terminated at the native output ceiling | [Retained negative result](eval/long-system/v9/RESULT.md), not evidence of uplift |
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
superseded, or changed elsewhere. Plan Lattice makes that boundary executable:
it joins the accepted contract, current root-to-leaf plan, exact target bodies,
required evidence, live ownership, and observable external preconditions into
a one-use authorization epoch.

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

For a clear, question-free `lattice` task, the first model request remains
native: it receives the normal DSH user message and may inspect the repository
without a forced Plan Lattice tool call or a second plan. The plugin establishes
the durable contract and graph at the first protected mutation boundary. This
keeps clear long work from spending its first turn on protocol narration while
preserving the same pre-write contract, leaf, target, and evidence checks.

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
controlled filesystem mutation, the controller must rebuild and verify one
joined basis containing:

1. the complete accepted execution contract;
2. the checked-out leaf and its full root-to-leaf plan, including every
   acceptance criterion; and
3. the exact current contents of every declared target file, or a digest-bound
   fact that the target does not yet exist;
4. any proof still required from prior protected work; and
5. host-observable preconditions for non-filesystem side effects.

`lattice_refresh_context({ targetPaths })` always rebuilds and verifies that
basis internally. In a stable native DSH conversation the original user request
is already visible, so the result projects only the new receipt, current leaf,
and exact target facts. It reprojects the full immutable contract only after a
surface replacement, resume, delegation, or material reframe. A built-in
`write`, `edit`, or mutating `str_replace_editor` call is accepted only when its
actual path is one of those targets and its body still matches the observed
digest. The joined authorization epoch is consumed before validation or
dispatch, including failed attempts, so parallel or retried mutations cannot
reuse it. A prepared dispatch then binds and locks the call identity and exact
arguments; supported authority invalidation while an asynchronous dispatch
middleware waits aborts the call before tool-body entry. The guard compares the
durable graph revision, current root-to-leaf digest, and aggregate digest of
every declared target, not only the immediate editor path. Surface replacement,
resume, reframe, plan mutation, handoff, disposal, or a concurrent durable
change invalidates the whole epoch. Read-only `str_replace_editor view` calls do
not.

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

This makes the recursive tree a persistent execution address rather than a todo
display. After compaction, pruning, resume, or handoff, it tells the session
which complete accepted contract and authoritative root-to-leaf plan to reread
before touching the current artifact state. A summary, model memory, inherited
message, or `parentSession` can navigate to that basis but cannot authorize a
mutation.

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
    maxTokenContinuations: 2      # 0 disables; bounded per durable session
    guardedTools: [write, edit, str_replace_editor]
    strictBash: true             # v0.4 default; also guards pwsh
    maxContextBytes: 262144
    topLevelLimit: 2
    nestedLimit: 5
    snapshotEvery: 1024
    # Defaults below DSH_HOME; keep outside every agent-writable workspace.
    # contractAnchorRoot: /absolute/trusted/plan-lattice-anchors
```

`longTaskThreshold` is evidence, not the routing decision by itself.
`controlCeiling: contract` provides a lighter deployment and the contract-only
ablation arm. v0.4 guards every Bash and PowerShell invocation by default and
fails closed unless the host supplies a programmatic precondition adapter.
Set `strictBash: false` only when the host provides a separate shell-effect
boundary; this opt-out weakens the mutation-time guarantee. Function adapters
are host composition and therefore cannot be expressed in the YAML block above.

When a controlled `contract` or `lattice` turn ends because the model reached
its output ceiling, `maxTokenContinuations` uses DSH's native `followup()` to
queue a clean next turn. It never runs for `bypass`, never uses same-turn
`steer()`, stops while a reframe is pending, and counts its own continuation
messages from the durable Session log. The default is two per session; set zero
to retain DSH's manual-continuation behavior. This prevents a known terminal
state from abandoning controlled work. It does not improve model reasoning or
turn a vague task into a well-defined one.

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

Contract control permits guarded work after commitment without requiring a
node checkout, but each filesystem mutation still needs a fresh contract plus
target-file basis. Full Lattice control additionally requires `lattice_open`, a
current context receipt, an active leaf lease, the current root-to-leaf plan,
and semantic checkpoints for verified leaf progress, blockers, and completion.
Every settled guarded action receives an automatic mechanical execution receipt
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

When a declared contract file changes or a surface event replaces model-visible
history, guarded work also pauses. Summary compaction and model-free tool-result
pruning are both covered, as are resumed sessions whose seed already contains
replacements. `lattice_reframe` commits a new contract revision;
`lattice_refresh_context` rereads the complete contract after compaction and,
with `targetPaths`, the current plan and exact files for the next mutation.
Existing graph nodes remain visible, but every non-archived node is marked
non-executable, including nodes that were complete under the old contract.
`lattice_update` explicitly reconciles one inspected node with the new
contract; checkout remains blocked until the complete root-to-leaf lineage has
been reconciled or stale leaves have been archived. Prior evidence remains as
history, not proof that the revised contract is complete.

Plan Lattice does not implement a second conversation compactor. DeepSeek
Harness owns summary compaction and model-free tool-result pruning, including
surface replacement and immutable event provenance. Deployments should compose
`@deepseek-ai/dsh-compaction-basic` with
`@deepseek-ai/dsh-compaction-tool-result-pruner` for large tool output. Plan
Lattice consumes their native replacement events only to revoke stale mutation
authority and require a fresh contract, plan, and target read.

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
seed, user message, persona, policy, and tool scope. The plugin contributes the
current outcome, decisions, invariants, node, acceptance, unknowns, and revision
through DSH's scoped runtime-context channel. It does not give the child
authority to ask the human. Missing boundary information is a parent-facing
result, not a reason for the child to guess.

This boundary is exercised through the published rc.7 model-facing
`@deepseek-ai/dsh-tool-subagent` plugin: its `prompt` argument remains the exact
first child user message, while the assigned root contract and leaf arrive as a
separately sourced native runtime-context snapshot. The plugin does not maintain
a second child prompt template or transport.

DSH delivers the initial delegated task as the child's first own user-role
message before exposing the child id. Plan Lattice accepts it as operational
delegation only when the live parent relation or continuable setup binding,
an exact `local: true` native `subagent/start` run/provider binding, DSH's first
authoritative child descriptor, and the absence of an earlier non-plugin input
after `seedLength` all agree. Parent-scoped remote run ids cannot authenticate a
same-named local Session. One-shot spawn/fork is
held read-only until its first pre-step appends the descriptor; later user-role
messages remain contract inputs and require root review or reframe. rc.7 does
not expose the initial accepted `messageId` and uses `source.kind: user` for both
delegation and direct human input, so this is deliberately documented as the
strongest available lifecycle evidence rather than exact message provenance.

Active control requires DSH runtime context and every tool in the selected
phase's protocol. `agent/pre-step` is an early diagnostic and handles native
pressure compaction after assembly. One `llm/stream` wrapper binds the
deep-frozen AgentLoop request to the exact rendered system prompt, latest
complete snapshot body, current authorization epoch, exact callable wire
schema, and the exact tool-definition identities visible to that Agent. It
validates before entering downstream middleware and again before accepting each
returned chunk. A global `tools/change` is revalidated against the affected
Agent's exact live definition view: an unrelated Agent's restriction does not
invalidate this request or an active guarded dispatch, while a changed local
definition, presentation mode, Code Mode SDK section, or final wire does. The
plugin never invokes the public prompt-assembly waterfall a second time.

When DSH native plan mode is active, its public `planMode.get(agent)` state owns
the planning turn. Plan Lattice preserves the durable contract and current leaf
as read-only context, requires `exit_plan_mode` rather than a competing
`lattice_*` action, and monotonically blocks every Lattice tool and configured
guarded mutation. Entering or leaving plan mode revokes the prior execution
basis; executable authority is refreshed only after the native transition.

rc.7 restores a `complete` persona after the public assembly waterfall and
does not publish the restored final assembly. Active Plan Lattice therefore
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

Plan Lattice does not spawn or schedule agents. It controls the contract and
evidence state shared by whatever delegation mechanism the Harness deployment
already uses.

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

Bypass creates neither directory. v2 contract files contain the generated
framing and bound human answers, so treat them as project-sensitive state.
Repository documents are referenced and hashed rather than copied into the
Lattice state, although complete document contents appear in model-visible tool
results after a continuity boundary or when a relevant document digest changes.

API credentials are never configuration fields. Evaluation and production
providers must receive them through process environment variables or an
equivalent host secret manager.

## Guarantees And Limits

The plugin can reject concrete stale-state transitions: writing before framing,
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
- cross-process lease compare-and-swap, dead-owner takeover, dirty crash
  recovery by exact attempt identity, graph-first receipt ordering, v1
  indeterminate migration, and release enforcement;
- automatic success/error mechanical receipts that remain separate from
  semantic evidence and cannot complete nodes;
- native system-prompt policy plus durable runtime-context state projection,
  including child inheritance and restart recovery;
- native `todo_write` coexistence as an optional current-turn projection rather
  than a second long-horizon authority;
- native plan-mode coexistence, including a real reviewed `exit_plan_mode`
  transition, same-tool-batch execution suspension, and next-step authority
  renewal;
- native summary/prune replacement fences without a plugin-owned surface
  compactor;
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
