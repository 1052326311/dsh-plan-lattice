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

The Oracle service returned a `status.remaining` value with every accepted
answer, but the frozen support provider discarded it. Without changing that
published protocol, the exploratory relay now preserves the value in
model-visible answer text and rejects malformed budget metadata, so the agent
can stop asking when the frozen five-question allowance reaches zero.

## RC7 correction

RC7 joins the original user authority with inspected repository evidence before
resolving critical gaps. It also wraps the candidate package with a strict ICAE
adapter that permits only one structurally parsed command shape:

```text
docker exec -w /workspace <frozen-container-id> bash -lc '<script>'
```

The adapter binds the exact arguments to the running container identity, image,
start time, and `/workspace` mount. Host-side operators, a different container,
a different work directory, or an unquoted script are rejected.

Any later exploratory result remains excluded from the frozen 90-run study. It
may demonstrate that the corrected mechanism executes end to end, but cannot by
itself establish general quality uplift, statistical significance, ranking, or
stable-release eligibility.

The corrected evaluation wrapper now removes host mutation tools from the
candidate arm's model-visible schema before prompt assembly and retains the
execution hook as defense in depth. A fresh lifecycle run is required; results
from either failed adapter remain ineligible for comparison.

Separately, official Harness tag `dsh-v0.1.0-rc.7` resolves to
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. Both the public Plan Lattice RC.6
asset and the local RC.7 candidate installed into that release and started the
real web profile with an HTTP 200 response. CI now repeats candidate install and
startup against that exact tag. The frozen statistical study remains bound to
its preregistered RC.6 Harness commit; startup compatibility is not presented as
full behavioral equivalence or model-quality evidence.
