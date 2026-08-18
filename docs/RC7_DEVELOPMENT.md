# RC7 development evidence

RC7 is not a stable-release claim. It hardens the mechanism that keeps an
agent's original objective, repository truth, and guarded side effects joined
through a long execution.

## Current controller corrections

These corrections target the protocol cost and recovery failures observed in
the retained pilots. They are mechanism changes, not general outcome evidence.

### Long-task route boundary

Bounded stable work with an authoritative specification can remain at
`contract`, but work at or above the configured atomic-step threshold still
uses full `lattice` control. A written PRD does not remove the compaction,
restart, partial-completion, and premature-stop hazards created by a long
execution. Changing truth, multiple epochs, handoff, delayed proof,
irreversible effects, or coordination independently justify the same tier.
Atomic initial planning and projected context reduce its protocol cost instead
of weakening the long-task completion boundary.

### Compact contract and projected context

Each clarification answer now appears once in the executable contract Markdown.
The anchored JSON retains the original question, raw answer, binding target,
and provenance for audit and tamper detection.

The controller still rereads the exact authoritative bytes before authorizing
work, but it renders a document in full only on first visibility, digest change,
compaction, restart, or surface replacement. Repeated reads in the same live
context return a digest-bound `UNCHANGED AUTHORITATIVE DOCUMENTS` reference.
Compaction clears visibility and forces full contract rehydration.

### Atomic initial plan

`lattice_open` can create a topologically ordered `initialPlan` and select its
first executable leaf with `selectedLeafKey` in the same durable operation.
Duplicate keys, unknown or forward parents, non-leaf selection, branch-limit
violations, and plans above 64 initial nodes are rejected. This removes the
repeated refresh/add cycle that dominated the failed pilot before coding began.

### Same-attempt recovery

The pilot driver may cold-resume the same attempt ID, workspace, DSH home,
session ID, and remaining timeout budget after only two durable terminal
reasons: `STREAM_CLOSED` or `interrupted`. The original task is not resent.
Recovery enters the existing session as a plugin-authored continuation, each
process epoch receives separate sanitized logs, and an append-and-fsync ledger
records the trigger. The default maximum is one recovery epoch; other HTTP
errors, timeouts, corrupt session evidence, and completed turns do not qualify.

A real frozen headless Harness integration test deliberately ends the first SSE
response without `[DONE]`, observes `STREAM_CLOSED`, starts a second process on
the same durable session, and completes successfully. It verifies one original
human task, one plugin recovery message, two upstream requests, one recovery
epoch, and one `stream_closed` ledger row. This proves the recovery path used by
the driver; it does not convert the earlier failed pilot into a successful run
or supply a hidden grader score.

### Matched exploratory outcome boundary

The exploratory ICAE pilot now installs a wrapper in both arms. Both wrappers
hide the same direct host mutation, external search, background, workflow, and
delegation tools; expose the same container-only Bash path; apply the same
Darwin sandbox and network exclusions; and inject the same common execution
boundary. The shared execution middleware parses every Bash call and rejects
host commands, the wrong container, a working directory other than
`/workspace`, shell operators around `docker exec`, and unsupported execution
metadata. Native retains `ask_user_question`, while the candidate replaces it
with `lattice_intake`; both channels reach the same official Oracle through the
same relay and share its five-question limit. The control tools and their
durable state are therefore the intended treatment rather than an accidental
difference in task execution capabilities.

Each arm receives a fresh attempt ID and an independently reset budget of 40
agent requests, 800,000 observed prompt tokens, and 80,000 observed completion
tokens. The local budget proxy records every accepted response and rejects the
next agent request once any ceiling is reached. Because usage is reported only
after a streamed response completes, a final accepted response can cross a
token ceiling; the audit reports the observed total rather than pretending the
stream was truncated at an exact token boundary. Any overrun or response that
ends without authoritative usage is marked `budgetWithinLimits: false`, cannot
enter the paired comparison, and makes the run ineligible for completion.

The attempt ID is carried through the pilot, ICAE adapter, Harness bridge,
recovery process environment, and fsynced recovery ledger. Final metrics record
the number of recovery epochs plus the ledger path and SHA-256. A failed agent
that produced at least one model turn no longer discards its workspace before
the official graders run: it remains an explicit `graded-partial` attempt with
`agentCompleted: false` and the terminal failure attached. This prevents a
budget exhaustion or model-stage failure from escaping outcome measurement.
Top-level grader errors, missing tiers, zero denominators, and invalid counts
are rejected rather than converted into an apparent valid zero score.

Before the first model request, the pilot verifies the pinned ICAE Git commit
and clean tracked tree, then content-hashes the repository catalog, selected
fuzzy PRD, hidden Oracle requirements, golden repository, authoritative tests,
and Docker image tar. It also prepares and records the exact Docker image ID.
Those bindings, the official archive checksums, and the task selection hash are
copied into every run spec and the final report.

The zero-model grader smoke copied the pinned `realcode@301` golden repository
without implementing the requested system and executed every authoritative
tier: 43 public, 43 hidden, and 37 enhanced cases. All scored zero by design.
This establishes that the three grader paths and container image execute; it is
not task-quality evidence.

## Retained negative pilot

The first paired ICAE pilot is retained verbatim in
[`rc7-icae-js-ts-01-pre-route-join-failure.json`](../eval/pilots/results/rc7-icae-js-ts-01-pre-route-join-failure.json).
Both controllers and graders completed, but neither task succeeded. Both arms
scored `0/100`: native missed 24 critical requirements and the candidate missed
22. The candidate used six fewer model turns, but consumed more tokens and
time. This run establishes no uplift.

The trace exposed one runtime defect and one pilot-enforcement defect:

1. Probe resolution unioned gaps found in the user request with gaps found in
   `start.md`. Although the request defined the evaluation protocol, the file
   did not repeat it, so `acceptance` remained permanently unresolved.
2. The exploratory arm set `strictBash: false`. After the contract path was
   blocked, the model could continue through unguarded Bash instead of the
   Lattice lifecycle.

Because the candidate did not complete route, intake, contract, lattice,
refresh, guarded action, and checkpoint in sequence, the result is not evidence
for Plan Lattice enforcement.

The next candidate-only lifecycle attempt reached that sequence, but it exposed
a separate attribution failure. The execution hook denied all 13 host-side
`write` calls, yet the tool remained visible to the model. The attempt was
stopped after 115 agent requests without a completed grader because the
preregistered boundary rejects any host mutation tool use, including denied
attempts. The retained structural report is
[`rc7-icae-js-ts-01-pre-hidden-tools-interrupted.json`](../eval/pilots/results/rc7-icae-js-ts-01-pre-hidden-tools-interrupted.json).

This attempt also exposed substantial protocol friction: 46 context refreshes,
59 failed tool calls, 15 logged question attempts for five accepted Oracle
requests, and no deliverable before interruption. None of these observations is
uplift or release evidence.

A later candidate-only attempt accepted all five Oracle answers and committed a
contract and two-node lattice, but then looped at the protected Bash boundary.
The receipt contained only the semantic Docker command while the real Harness
tool also required a presentation `description`; hashing the complete raw
object made the same side effect look different. A later call also supplied the
container path `/workspace` as the host process workdir and failed with
`spawn bash ENOENT`. The retained report is
[`rc7-icae-js-ts-01-pre-semantic-shell-identity-interrupted.json`](../eval/pilots/results/rc7-icae-js-ts-01-pre-semantic-shell-identity-interrupted.json).
Its 95 requests, 34 tool errors, and zero deliverables are protocol-negative
evidence, not an uplift result.

After semantic shell identity was corrected, another candidate-only attempt
failed earlier in intake. The first tool payload was malformed; the next valid
batch consumed five Oracle model turns before returning HTTP 400, and retries
returned HTTP 429. The model then attempted a visible `subagent` tool whose
prompt asked the child to use direct curl or Docker. Harness ownership checks
denied the child, all 14 Bash calls were blocked, and no deliverable was
created. Visibility of an indirect execution channel is itself an attribution
failure, so the run was stopped and retained as
[`rc7-icae-js-ts-01-pre-indirect-execution-interrupted.json`](../eval/pilots/results/rc7-icae-js-ts-01-pre-indirect-execution-interrupted.json).
Its 34 agent requests, 25 failed tool calls, and unfinished lifecycle establish
no quality or release claim.

The Oracle service returned a `status.remaining` value with every accepted
answer, but the frozen support provider discarded it. Without changing that
published protocol, the exploratory relay now preserves the value in
model-visible answer text and rejects malformed budget metadata, so the agent
can stop asking when the frozen five-question allowance reaches zero.

A subsequent pre-model retry failed while extracting the frozen host Harness
with 116 MiB of disk space remaining. A normalized report, bound to the original
report digest, is retained as
[`rc7-icae-js-ts-01-infra-enospc-misclassified.json`](../eval/pilots/results/rc7-icae-js-ts-01-infra-enospc-misclassified.json).
The report said `task`, exposing a driver bug: orchestration had started even
though no model turn had. The exploratory adapter now classifies ENOSPC under
the host `dsh/node_modules` staging path as `filesystem_capacity`; this is an
authorized infrastructure retry condition, not candidate evidence.

The next fresh candidate-only run exercised the corrected boundary through one
five-question Oracle batch, a committed v2 contract, a three-node lattice,
current-leaf checkout, one guarded Bash environment probe, and a durable
checkpoint. The wrapper removed the forbidden direct and indirect execution
tools from all five model-visible request headers. The 26th agent request then
received HTTP 502; Harness reported `STREAM_CLOSED` because the SSE stream
ended without `[DONE]`. No source deliverable or grader result existed.

The normalized report is retained as
[`rc7-icae-js-ts-01-agent-stream-closed.json`](../eval/pilots/results/rc7-icae-js-ts-01-agent-stream-closed.json).
It records 26 tool calls, seven rejected calls, 25 successful agent responses,
one final 502 response, 1,151,411 prompt tokens, 30,947 completion tokens, and
the exact artifact digests. Seven refreshes emitted 170,570 characters, 76.6%
of all tool-result text; the last ten requests consumed 718,733 prompt tokens.
Because execution had
already begun, the frozen policy classifies the attempt as a task failure and
does not permit a discretionary retry. Reaching a guarded action and checkpoint
is useful lifecycle evidence, but an unfinished task with no grader is neither
quality uplift nor release evidence.

## RC7 correction

RC7 joins the original user authority with inspected repository evidence before
resolving critical gaps. It also wraps the candidate package with a strict ICAE
adapter that permits only one structurally parsed command shape:

```text
docker exec -w /workspace <frozen-container-id> bash -lc '<script>'
```

The adapter binds the semantic command to the running container identity,
image, start time, and `/workspace` mount. Presentation-only `description` may
change, but `workdir`, `run_in_background`, `timeoutMs`, host-side operators, a
different container, a different container work directory, or an unquoted
script are rejected. Core adapters can apply the same split only through a
synchronous JSON identity while `snapshot` and final `verify` continue to see
the complete raw arguments.

Any later exploratory result remains excluded from the frozen 90-run study. It
may demonstrate that the corrected mechanism executes end to end, but cannot by
itself establish general quality uplift, statistical significance, ranking, or
stable-release eligibility.

The corrected evaluation wrapper now removes host mutation, external search,
background process control, subagent, workflow, Ralph, and subagent-control
tools from the candidate arm's model-visible schema before prompt assembly and
retains the execution hook as defense in depth. Provider-specific `subagent_*`,
`job_*`, and `schedule_*` names are denied as well. The wrapper permits one
Oracle intake batch, requires atomic outcome-critical questions, requires
immediate answer commitment, and treats any Oracle error as a failed evidence
path rather than permission to retry or guess. A fresh lifecycle run is
required; results from the failed adapters and tool boundary remain ineligible
for comparison. Before a paired comparison, non-Lattice information and
delegation restrictions must be made common to both arms so tool asymmetry
cannot explain an outcome.

Separately, official Harness tag `dsh-v0.1.0-rc.7` resolves to
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Both the public Plan Lattice RC.6
asset and the local RC.7 candidate installed into that release and started the
real web profile with an HTTP 200 response. CI independently exercises both
the exact published RC.6 tarball (including its fixed SHA-256) and the current
RC.7 candidate against that official tag. Each matrix arm installs into a fresh
profile, verifies the rendered profile, starts the real Web host, observes its
page title, checks all 16 expected `lattice_*` tool schemas, and uploads a
machine-readable compatibility record. The frozen statistical study remains
bound to its preregistered RC.6 Harness commit; startup and registration
compatibility are not presented as full behavioral equivalence or model-quality
evidence.
