# DSH-Native Boundary V21 Result

This file is an appended execution record. It does not modify the frozen V21
candidate, driver, task, grader, manifest, or thresholds, and it does not
authorize a rerun under the V21 identity.

## Record

- Protocol: `plan-lattice-rc7-native-boundary-long-system-v21`
- Frozen manifest digest:
  `7a6de7e9b796263b67cc8b7ff5c143a0ddbf0643ee7f5d7ababeaa6a1daa56a6`
- Driver commit: `ec23dda`
- Candidate commit: `f9e3e245e629d1013e77dc10e67c06a4f1682a14`
- Candidate tree: `8c12c887ac1c99ffdc33518fc37fa9ba0fa818dd`
- Harness: `dsh-v0.1.0-rc.7`
  (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`)
- Model: `deepseek-v4-flash`, temperature 0, output cap 32,768
- Executed once on 2026-08-19 in the registered order: native, candidate.
- Sanitized paired report:
  `.plan-lattice-eval/long-system-v21/rc7-native-boundary-long-system-v21-2026-08-19T23-18-52-271Z/paired-report.json`
- Paired report SHA-256:
  `1f453c0e0ad98124a5c37cdda70bf58368e189c3d148052cc885a60d0d863487`
- Internal report digest:
  `aaf5839b0594acc4635a7b6669ea3be61583f5bb477a05407476b11b0ec56bed`

## Strict Outcome

The frozen analyzer returned `mechanismResultAllowed: false`,
`releaseAllowed: false`, and `resultClaimAllowed: false`. No positive quality,
efficiency, release, ranking, or superiority statement is permitted from V21.

Both final workspaces scored 100, so the task had a ceiling and measured zero
quality uplift. Neither arm completed the exact frozen lifecycle. Native did
not complete all stages, and the candidate reached only four of five required
process epochs, did not reach the material-revision stage, and exercised only
one of the required two recovery boundaries. Both persisted Session totals
also exceeded the frozen 4,000,000-input-token gate.

The durable mechanism checks that did execute were narrow and non-regressive:
the model-authored foreground fork prompt was the child's first own user
message, the native child result returned through the parent tool pair, a fork
seed replacement did not trigger a fresh-child snapshot, no legacy controller
tool ran automatically, and the one observed recovery snapshot followed a
Session-owned replacement. These observations do not overcome the failed
lifecycle and quality gates.

## Measurement Defect

The V21 Session metric collector aggregated every event in every selected
Session. A fork child durably contains the parent's completed-turn prefix as a
seed, identified by `header.seedLength`. Counting the complete child log counts
the parent's inherited model usage, compaction summaries, replacements, and
turns a second time.

Consequently, the frozen report's Session-derived input ratio of
`1.1647661816785424` is not a valid paired-overhead measurement. The external
proxy audit, which records actual HTTP responses rather than replayed Session
events, observed:

| Arm | Responses | Input tokens | Output tokens | Duration |
| --- | ---: | ---: | ---: | ---: |
| native | 87 | 4,025,445 | 137,730 | 1,039,137 ms |
| candidate | 82 | 4,064,811 | 111,055 | 797,209 ms |

The actual-request input ratio is approximately `1.009779291`. These numbers
diagnose the collector defect only. The protocol did not preregister proxy
usage as a replacement release gate, both arms still exceeded the absolute
budget, and the lifecycle and quality gates still failed. Lower request,
output, or duration totals therefore are not a V21 positive result.

## Disposition

V21 is closed as negative evidence and must not be rerun or reinterpreted.
V22 must use `events.slice(header.seedLength ?? 0)` for every per-Session token,
turn, compaction, replacement, continuation, control-call, and timing
aggregate. It must include adversarial fork-seed regressions and first run a
native-only pilot on a non-ceiling task before any new paired freeze.
