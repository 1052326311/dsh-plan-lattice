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
