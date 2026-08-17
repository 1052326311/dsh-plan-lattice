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
