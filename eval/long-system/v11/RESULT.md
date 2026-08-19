# RC7 Native Long-System V11 Result

This is an appended execution record for the frozen V11 protocol. It does not
modify the task, grader, source hashes, thresholds, candidate identity, or
`frozen-manifest.json`. V11 must not be rerun under the same identity.

## Record

- Protocol: `plan-lattice-rc7-native-long-system-v11`
- Frozen manifest digest:
  `a820bd493198ff7ed8bfa95d69eb122959399280f9c180d86ede14251cc77074`
- Candidate commit: `06aa8f2a1df1b5efbd61586d13beb58684b5fcfd`
- Driver commit: `ddb575aadfae81cfdee83da05a35d1718d752e2c`
- Harness: `dsh-v0.1.0-rc.7`
  (`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`)
- Host runtime SHA256:
  `20b9e0fe946e372f5d52892b65b87ae488c63f9b3404a0c37f005f02810e56e4`
- Model: `deepseek-v4-flash`, temperature 0, agent output cap 32,768
- Executed once on 2026-08-19 in the registered order: native, candidate.
- Sanitized paired report:
  `.plan-lattice-eval/long-system-v11/rc7-native-long-system-v11-2026-08-19T04-51-21-885Z/paired-report.json`
  (SHA256 `4fa2b4c3c2c0a92df24cd5abe478603b5ad05e821eb25f2b067192cd30135c26`).

## Outcome

| Arm | Score | Model turns | Input tokens | Output tokens | Terminal reason |
| --- | ---: | ---: | ---: | ---: | --- |
| Native | 34/100 | 12 | 384,160 | 39,789 | request budget exhausted |
| V11 candidate | 0/100 | 12 | 182,058 | 28,609 | request budget exhausted |

Both arms exhausted the preregistered request budget before the task reached a
scheduled compaction, cold resume, child delegation, or material revision. The
candidate used fewer tokens and 48.286 seconds less wall time, but failed every
foundation requirement. Its score delta was -34 points, hard-requirement misses
increased from 6 to 10, and it retained obsolete behavior. None of the V11
positive gates passed.

- `positiveExploratorySignal: false`
- `statisticalUpliftEstablished: false`
- `globalBestEstablished: false`
- `stableReleaseAllowed: false`

V11 establishes no coding-quality uplift, general ranking, stable-release
eligibility, efficiency claim, or production claim.

## Design Consequence

The V10 tool-message ordering defect was fixed: V11 completed both real
provider paths without the strict ordering error. The new failure was control
friction before ordinary implementation, not evidence that more contract or
tree fields would help. The successor design therefore preserves DSH's native
first uninterrupted execution segment for eligible auto tasks and reconstructs
durable human authority only after an actual continuity boundary. Any V12
evaluation must use a new preregistration, candidate hash, task, and frozen
analysis plan; V11 remains an unchanged negative sample.
