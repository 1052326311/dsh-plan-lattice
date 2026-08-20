# V22 Native Task-Selection Pilot History

These pilots select a non-ceiling task before any paired execution. They do
not measure a plugin effect and cannot support a release, ranking, quality
uplift, or superiority claim. A failed pilot is retained and is never rerun
under the same artifact identity.

## Pilot 1: Non-Ceiling, Lifecycle Incomplete

- Artifact:
  `rc7-native-boundary-long-system-v22-pilot-2026-08-20T00-16-03-751Z`
- Driver commit: `31eb39b4871fb4818046ff030dcb0daa222382e6`
- Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Task: `duty-window-ledger-authority-compat-v3`
- Executed once on 2026-08-20 with native DSH only.
- Sanitized report SHA-256:
  `15e3345489fc220c34ef390a8ffe8f36f0f42d319988cd53bb381fe41465f8ac`
- Internal report digest:
  `369d0dca49399e0de43f723d58903bf2a7fbe299954cd2d0a4415a8d14c05481`

The task was non-ceiling: the interrupted workspace scored 44/100 with nine
hard requirements missing. It was not eligible for a pair because native used
4,048,861 input tokens and hit the preregistered 4,000,000 limit during the
foreground child stage. Only Foundation and Transitions completed, with three
process epochs, one root replacement, and one foreground fork. The persistent
Session continuity audit itself was valid.

The first Foundation stage consumed roughly half the entire input budget while
reimplementing already-understood timestamp, event-shape, and atomic-storage
mechanics. That work is unrelated to the continuity mechanism under test. The
next task revision therefore promotes the independently verified Foundation
output into the fixture baseline while leaving transition, summary, material
revision, legacy compatibility, three replacements, and final integration
unfinished. This is a new task digest and requires a new pilot identity.

## Pilot 2: Near-Complete, Budget Exhausted

- Artifact:
  `rc7-native-boundary-long-system-v22-pilot-2026-08-20T00-45-43-094Z`
- Driver commit: `2eeca9e029dbaceaaefff5a38efee3190000d972`
- Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Task: `duty-window-ledger-authority-compat-v3`
- Executed once on 2026-08-20 with native DSH only.
- Sanitized report SHA-256:
  `3f07ae60ef67c625afca5f199d55fd2ff27a0e627965fa075f7731381e9b630e`
- Internal report digest:
  `e125c83db4ed0521664956f101288fe28b25977d9099ef2ba9b5f8dcb86b1b89`

The interrupted workspace scored 89/100 and the native foreground child's
report snapshot scored 100/100. Foundation, Transitions, and delegated Summary
completed. The root reached the material-revision process after two native
surface replacements and one real `subagent_fork`, but the 81st model request
raised cumulative input to 4,009,378 tokens and exhausted the fixed 4,000,000
budget. The final integration process and third replacement never occurred, so
this run is not eligible for a pair.

The remaining hidden failure was the post-reassign ownership/state behavior;
the public suite also retained three focused revision failures. The durable
Session audit was valid and counted only each Session's suffix after
`seedLength`. Because the pre-revision child snapshot independently passed all
48 public Foundation, Transitions, and Summary tests while scoring 72/100 on
the unchanged final hidden grader, that exact snapshot becomes the next fixture
baseline. Material revision, legacy retirement, and final integration remain
unfinished. This removes verified implementation cost unrelated to continuity
without exposing hidden assertions or changing the grader or budget.

## Pilot 3: Eligible Non-Ceiling Lifecycle

- Artifact:
  `rc7-native-boundary-long-system-v22-pilot-2026-08-20T09-14-14-668Z`
- Driver commit: `87c918af858f2b16a04308aac2fae599f88b78e1`
- Harness commit: `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
- Task: `duty-window-ledger-authority-compat-v4`
- Executed once on 2026-08-20 with native DSH only.
- Report SHA-256:
  `55a2cb95b16f8d5e0d36641e0bf66e47270c5e3f06f7f2e474f26fc9fed05a91`
- Internal report digest:
  `b41c5004f9e8f52640f9fac39e91b31efad250c90a4dcf6fe8a6337e6906f9e4`

This task is eligible for one frozen pair. Native completed all five stages,
three root-owned surface replacements, five process epochs, and one real
foreground `subagent_fork`. The persistent root and child Session audit was
valid, the child report scored 100/100, and the final workspace scored 87/100
with two hard material-revision requirements still missing. The run used 75
model requests, 2,996,557 input tokens, and 123,586 output tokens with no
missing usage rows or budget rejection. It therefore completed below the fixed
4,000,000 input-token ceiling while remaining non-ceiling on the unchanged
hidden grader.

This pilot selects the task only. It is not a plugin arm, does not measure an
effect, and cannot support a release, ranking, quality uplift, or superiority
claim. The exact report is retained as `NATIVE_PILOT.json` and is validated by
the V22 freeze before paired execution is enabled.
