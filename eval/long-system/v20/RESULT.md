# V20 Retained Result

Status: executed negative; do not rerun under the V20 identity.

- Candidate: `41b315f6f77a8b660018d4b67cfb095eea5adde4`
- Driver/lock: `203451f5daa9d212c56e010adc2e547f69aaa131`
- Manifest: `debc14c1dc3c8be0bf00bc35986ac9675c4dfe4512150f53c993e839ec0c0117`
- Harness: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Runtime SHA-256: `7356db54390fdf0a6ec684933e94aa27087065ddac5012aa183cac97d8bc2607`
- Paired report SHA-256: `32072109d3855af2bca1429cea3760d06c240321b0658a55a193dec0aaf8ba0c`
- Canonical report digest: `0371254730179a3ac032a472fd0284f72cc077e00ecd0a81d460893c91b80747`
- Execution order: native, candidate
- Model: `deepseek-v4-flash`, temperature 0
- Budget per arm: 100 agent requests, 4,000,000 input tokens, 500,000 output tokens

## Outcome

| Arm | Score | Hard misses | Requests | Input tokens | Output tokens | Duration | Lifecycle |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Native | 100 | 0 | 87 | 3,559,925 | 160,777 | 1,101,477 ms | Complete |
| Candidate | 100 | 0 | 82 | 4,049,581 | 118,182 | 837,619 ms | Budget failure before final integration |

The frozen analyzer returned `releaseAllowed: false` and
`resultClaimAllowed: false`. The score delta was zero, below the preregistered
15-point minimum, and the candidate exceeded the input-token ceiling by 49,581
tokens. No release, Discussion update, ranking, or positive quality-uplift
claim is allowed from V20.

Both workspaces passed every hidden product check at grading time. The
candidate was 263,858 ms faster, used five fewer model turns, and emitted
42,595 fewer output tokens, but consumed 489,656 more input tokens. These are
descriptive signals from one retained pair, not evidence of a quality uplift.
The candidate received three budget rejections and did not execute the final
integration stage, so its native lifecycle is incomplete despite the final
workspace scoring 100.

Of the 489,656 aggregate input-token difference, 481,152 tokens (98.3%) were
cache reads and 8,504 were uncached input. The arms also followed different
model paths: the candidate used ten additional Foundation calls before passive
continuity activated and six additional Material Revision calls, while native
alone completed thirteen Final Integration calls. V20 therefore does not
identify the aggregate token delta as a causal plugin overhead measurement.
It does show that the old append-only full recovery snapshots raised the
cached-context baseline and amplified extra calls once the paths diverged.

## Native Compatibility Evidence

V20 repaired V19's nested-sandbox fault. The free gate and paid run both used
the real rc.7 Harness Bash path inside an authoritative outer Darwin sandbox.
Workspace mutation and Node tests succeeded while repository reads remained
denied.

The paid pair also established the intended compatibility boundary:

- both arms crossed two real `compaction/summary` and two canonical
  `surfaceOp.replace` boundaries;
- both arms used five real process epochs and retained one root Session;
- both arms completed one model-authored foreground native child;
- the parent tool-call prompt matched the child's first ordinary user message;
- both arms exposed the same native subagent tool-schema digest;
- the candidate made zero `lattice_*` calls, asked zero clarification
  questions, and did not substitute a private child protocol; and
- both workspaces preserved delegated Summary behavior, removed superseded
  checkout behavior, and implemented the later adjust-start revision.

DSH therefore remained the owner of Session history, prompt assembly, Plan
Mode, Todo, compaction, cold resume, child prompt creation, child lifecycle,
and result delivery. Automatic Plan Lattice behavior observed native
continuity boundaries and restored approved authority through those
boundaries; it did not replace the Harness control plane.

## Negative Finding

The candidate's continuity payload did not improve functional quality on this
task because native DSH already reached the 100-point ceiling. More
importantly, candidate input use grew past the frozen budget even though it
used fewer turns and less wall time. The retained evidence therefore rejects
the current automatic payload as an efficient default for this workload.

The next investigation must stay at DSH's native control boundaries. It should
trace which continuity facts are duplicated by Session prompt assembly,
compaction summaries, approved native plans, Todo state, and child-result
delivery, then minimize or deduplicate only the injected payload. It must not
respond by adding another private plan graph, tool family, or child prompt
format.

V20 is immutable. Any changed candidate, budget, task, grader, prompt,
compaction policy, or execution order requires a new protocol identity and a
new preregistration before another paid run.
