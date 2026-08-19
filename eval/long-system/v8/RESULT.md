# RC7 Native Long-System V8 Result

This is an appended result record for the frozen V8 protocol. It is not an
input to `frozen-manifest.json`, whose source digests and pre-execution status
remain immutable.

## Record

- Protocol: `plan-lattice-rc7-native-long-system-v8`
- Frozen manifest digest:
  `8c1e392fbc45ed75b8a25c59df9f1334d45ba267ab9e8ae061e2cc182d5a9005`
- Driver commit: `4c6d8f3db9eb311d751ae86587279a5b8b6abcf9`
- Candidate commit: `0695decb6f34200d3f8498b846da1d47bdaa2f9b`
- Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Model: `deepseek-v4-flash`, temperature 0
- Executed once on 2026-08-19. No rerun is authorized under the V8 identity.
- Sanitized local paired-report SHA-256:
  `5ed6c88ea55778c7e84d6d46f943bc6235861547416ad4b4f689c333b23c8e38`

## Outcome

Both arms exceeded the frozen 1,000,000-input-token limit and are invalid for
the preregistered comparison:

| Arm | Score | Input tokens | Agent requests | Continuity stages reached |
| --- | ---: | ---: | ---: | --- |
| Native | 29/100 | 1,041,610 | 26 | none |
| V8 candidate | 5/100 | 1,008,409 | 21 | none |

Neither arm reached compaction, restart, or delegated-child stages. The
candidate therefore did not satisfy any V8 exploratory-positive gate; the pair
does not establish a performance difference, general task quality, release
eligibility, or ranking.

## Design Consequence

The candidate trace exposed control traffic before the first implementation
milestone: a read-only `pwd && ls -la` was incorrectly treated as a protected
mutation, repeated authority projections were returned during a stable native
conversation, and status output hid actionable leaf IDs. The next candidate
addresses those mechanics without modifying this task, grader, manifest, budget,
or result. A new experiment must receive a new preregistration and a task that
can actually reach the intended native continuity boundaries within its frozen
budget.
