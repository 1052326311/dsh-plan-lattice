# DSH-Native Boundary V22 Result

This file is an appended execution and forensic record. It does not modify the
frozen V22 candidate, driver, task, grader, manifest, order, budget, or
thresholds, and it does not authorize a rerun under the V22 identity.

## Record

- Protocol: `plan-lattice-rc7-native-boundary-long-system-v22`
- Frozen manifest digest:
  `a0662976709cc098e2438c31d24d581671ee8eb47413915f36d86d885053815d`
- Lock commit: `dee08daf825150e492f523fa6c3d7233015fd4f8`
- Frozen driver commit: `e15d2b561dc0a3cb3f84664d9ff2f0e7bea2f667`
- Candidate commit: `f9e3e245e629d1013e77dc10e67c06a4f1682a14`
- Candidate tarball SHA-256:
  `ac07771c8b98dccc6489184443d71e1f8680f0c132c71b551f574d8cd13273c4`
- Harness: `dsh-v0.1.0-rc.7`
  (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`)
- Model: `deepseek-v4-flash`, temperature 0, output cap 32,768
- Executed once on 2026-08-20 in the registered order: native, candidate.
- Paired artifact:
  `rc7-native-boundary-long-system-v22-2026-08-20T09-42-39-853Z`
- Sanitized paired report:
  `.plan-lattice-eval/long-system-v22/rc7-native-boundary-long-system-v22-2026-08-20T09-42-39-853Z/paired-report.json`
- Paired report SHA-256:
  `96e2feb0fc05e69fc8b991c4f49db4b38a558831ddcb856d296e8c31fd1cf8e8`
- Internal report digest:
  `16be8b4975f47f3e06140f2719c1cd4c001185dc13d08efa31d3ff239c628452`

## Strict Outcome

The frozen analyzer returned `mechanismResultAllowed: false`,
`releaseAllowed: false`, and `resultClaimAllowed: false`. No positive quality,
efficiency, release, ranking, or superiority statement is permitted from V22.

Both arms completed the exact five-stage lifecycle and scored 87/100. Both
missed the `adjust-start` invalid-boundary behavior and the `reassign`
ownership/state grader check. The paired quality delta was zero, below the
frozen 15-point threshold, and the candidate retained two hard-requirement
misses instead of the required zero.

| Arm | Score | Hard misses | Requests | Input tokens | Output tokens | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 87 | 2 | 74 | 3,579,102 | 127,269 | 844,691 ms |
| candidate | 87 | 2 | 83 | 3,884,972 | 134,288 | 976,035 ms |

Candidate input was `1.0854599840965695` times native, within both the frozen
1.10 paired ratio and the absolute 4,000,000-token limit. Passing the budget
does not overcome the failed quality gates.

## Mechanism Evidence

The narrow continuity mechanism executed correctly but did not improve the
frozen outcome:

- both arms persisted three root-owned DSH replacements, five process epochs,
  and one model-authored foreground `subagent_fork`;
- the child received the exact model-authored first user message and no Plan
  Lattice recovery snapshot;
- the candidate committed exactly three recovery snapshots after exactly three
  root-owned replacements, with no duplicate or orphan snapshot;
- the largest recovery snapshot was 12,896 bytes, below the 65,536-byte bound;
- the final recovery restored the original human contract and the material
  revision from the append-only Session log; and
- both arms exposed the same native subagent tool schema and completed the
  durable parent result turn.

This proves execution of the bounded mechanism only. The plugin restored
authority text, while DSH's own compaction summary already retained the same
material revision. Both agents then declared their implementations complete
without obtaining evidence for every outcome-critical interpretation. Restored
requirements alone therefore did not close verification debt.

## Frozen Grader Defect

The V22 grader contains a deterministic defect in the seven-point `reassign`
check. It records `oldWorkerBefore`, correctly attempts the rejected old-worker
checkin, then performs a successful new-worker checkin, and only afterward
compares the mutated store with `oldWorkerBefore`. A correct successful new
worker transition must change the store, so the frozen condition cannot pass.

The six-point `adjust-start` check expects a revised start at or after the duty
end to exit 2. Both arms classified the relationship to existing duty state as
a `StateError` and exited 3. The contract distinguishes invalid values (2) from
valid commands rejected by state (3) but does not explicitly resolve this
cross-field case. This remains a real mismatch with the frozen grader even
though the contract interpretation is ambiguous.

The grader cannot be repaired under the executed V22 identity. Even removing
the impossible seven-point `reassign` failure would leave the candidate at
94/100 with a zero paired advantage on the remaining behavior. The strict
negative disposition is therefore unchanged.

## Disposition

V22 is closed as negative evidence and must not be rerun, selectively rescored,
or used for a positive claim. A successor must use a new candidate and protocol
identity. Before freezing another quality grader it must pass known-good and
targeted known-bad mutation fixtures, including mutation-order checks around
byte-stability assertions.

The production lesson is also narrower than adding another plan schema. A DSH
replacement boundary needs both authority continuity and evidence continuity.
The next mechanism should derive from DSH-owned Plan/Todo and Session events,
carry only unresolved outcome-critical obligations, and refuse to treat a
model-authored "complete" claim as closure without a concrete receipt. It must
remain passive for simple tasks, preserve native child prompts and result
delivery, and add no parallel scheduler or controller vocabulary.
