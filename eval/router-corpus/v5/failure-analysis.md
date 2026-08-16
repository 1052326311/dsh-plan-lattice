# V5 Router Failure Analysis

This report is deterministic post-reveal diagnosis. It does not modify or rehabilitate the failed V5 evidence.

## First Reveal

- Accuracy: 0.5333333333333333
- Simple false activation: 0.13333333333333333
- Complex critical recall: 0.45
- Outcome-critical bypasses: 22
- Lattice recall: 0.125
- Release gate passed: false

## Annotation Reliability

- Primary route agreement: 283/360 (0.786111); kappa 0.603859.
- Primary outcome-critical agreement: 274/360 (0.761111); kappa 0.541944.
- All three causal axes agreed exactly: 86/360 (0.238889).
- Frozen contract rows with complete A/B axis agreement: 1/36.
- Placeholder-only blind rows: v5-004, v5-005, v5-051, v5-216, v5-221.

| Frozen route | Rows | Failures | A/B route agreement | A/B all-axis agreement | Multiple supporter tuples |
| --- | ---: | ---: | ---: | ---: | ---: |
| bypass | 60 | 8 | 41 | 41 | 0 |
| contract | 36 | 27 | 33 | 1 | 35 |
| lattice | 24 | 21 | 18 | 14 | 10 |

## Causal Conclusion

- The V5 route was voted independently from the causal axes; the freeze retained multiple supporter axis tuples instead of adjudicating one authoritative basis assessment.
- A direct route majority can therefore hide disagreement about why control is required, so a router miss and a label-construction miss are not identifiable from route accuracy alone.
- Issue severity is not stale-mutation impact: V6 must measure damage caused by acting on an obsolete basis, not damage already described by the issue.
- Unknown repository ownership or execution span requires a probe lifecycle; forcing a final route from issue prose makes the evaluator reward guesses.
- V6 must annotate executable evidence sufficiency and primitive basis facts, then derive outcome-critical status and the final route with a frozen function.

## Failed Cells

| Expected -> actual | Count |
| --- | ---: |
| bypass->contract | 7 |
| bypass->lattice | 1 |
| contract->bypass | 23 |
| contract->lattice | 4 |
| lattice->bypass | 10 |
| lattice->contract | 11 |

The machine-readable report contains every failed row, source URL, A/B/C vote, causal tuple, rationale, and router reason.
