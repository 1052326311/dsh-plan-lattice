# RC7 development evidence

RC7 is not a stable-release claim. It hardens the mechanism that keeps an
agent's original objective, repository truth, and guarded side effects joined
through a long execution.

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
one final 502 response, and the exact artifact digests. Because execution had
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
