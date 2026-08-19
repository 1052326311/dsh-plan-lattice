# RC7 Native Long-System V9 Result

This is an appended execution record for the frozen V9 protocol. It does not
modify `frozen-manifest.json`, its source hashes, its task, or its thresholds.
No rerun is authorized under the V9 identity.

## Record

- Protocol: `plan-lattice-rc7-native-long-system-v9`
- Frozen manifest digest:
  `f38538551a5384f715dabecf64f120510312b71f2d9a1c0920bbd39e1c64e326`
- Driver commit: `a73ed57543764e6f72f0bcb6ba3653529ebc5df2`
- Candidate commit: `f8652cfcf409ad14e059b3709332174b38d31ded`
- Harness: `dsh-v0.1.0-rc.7`
  (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`)
- Model: `deepseek-v4-flash`, temperature 0, agent output cap 32,768
- Executed once on 2026-08-19 in the registered order: native, candidate.
- Sanitized paired report:
  `.plan-lattice-eval/long-system-v9/rc7-native-long-system-v9-2026-08-19-registered/paired-report.json`

## Outcome

Both arms performed normal repository inspection and then ended at the native
`max-tokens` boundary on their third model request. Neither made a filesystem
mutation or reached the preregistered compaction, cold-resume, delegation, or
revision stages.

| Arm | Score | Requests | Input tokens | Output tokens | Terminal reason |
| --- | ---: | ---: | ---: | ---: | --- |
| Native | 0/100 | 3 | 16,432 | 33,220 | `max-tokens` |
| V9 candidate | 0/100 | 3 | 18,325 | 33,033 | `max-tokens` |

The score delta is zero and the candidate used 1,893 more input tokens. It did
not satisfy a V9 exploratory-positive gate. This result establishes no
performance uplift, release eligibility, global ranking, or claim about coding
quality.

## Design Consequence

The trace identified an upstream execution boundary rather than a missing
contract field: rc.7 stops a turn after `max-tokens` by default. The successor
candidate may evaluate a bounded native `agent.followup()` continuation only
under a new preregistration with new candidate hashes and a task that can reach
its planned continuity stages. V9 itself remains unchanged and negative.
