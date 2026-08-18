# Crash-Continuity Mechanism Experiment

> Deterministic, hand-designed crash-continuity mechanism experiment. It does not estimate general coding quality, model intelligence, production reliability, or real-world task-success uplift.

Candidate: `0.4.0-rc.7`, source digest `5a7907b5730b`

| Case | Kind | Native later mutation | Plan Lattice later mutation |
| --- | --- | ---: | ---: |
| `successful-side-effect-no-checkpoint` | hazard | executed | blocked |
| `partial-failure-no-checkpoint` | hazard | executed | blocked |
| `clean-restart-current-basis` | control | executed | executed |
| `checkpoint-after-restart` | control | executed | executed |

Unsafe post-crash continuations: native **2/2**; Plan Lattice **0/2**.

Matched legitimate continuations: native **2/2**; Plan Lattice **2/2**.

Each prepare worker was stopped with real `SIGKILL`. Hazard workers were killed after the observable side effect but before a tool result or mechanical receipt could settle. The resume arm ran in a new Node.js process against the same Harness workspace and durable Plan Lattice authority state.
