# v0.4.0-rc.6

RC.6 fixes the automatic-control failure exposed by the first real-model RC.5
pilot and closes two more ways for a long-running task to lose authoritative
input across model turns or process restarts.

## What Changed

- A clear, bounded one-file change with explicit behavior, errors, scope, and
  exclusions now routes directly to `bypass` with high confidence. It receives
  no Lattice prompt, tools, persisted state, write guard, or added model call.
- Critical clarification is checked by missing outcome dimensions, not question
  count. A model-generated contract field cannot stand in for user authority.
  Missing outcome, scope, truth-source, authority, side-effect, and acceptance
  facts each require a semantically relevant answer when they can change P0.
- Initial intake and reframe use the same critical-gap rule.
- Human input received by a delegated child creates a content-addressed durable
  fence at the root. The fence survives process restart and cannot be cleared by
  losing child-session logs or replaying the old contract.
- Only publication of a higher root-contract revision that adopts the delegated
  input clears that fence. Fence writes are atomic, contract-digest bound,
  tamper-evident, and idempotent under concurrent delivery.
- The first-drift benchmark now performs comparable production mutations in
  both arms, and the crash benchmark source digest binds the coordinator.

## Real-Model Development Evidence

The pre-fix RC.5 development pilot found an important negative result on the
fixed `simple-js-clamp` task: native scored `5/5`, while RC.5 auto scored `1/5`.
The explicit task had been misrouted to `probe`, and the agent spent its run on
repository search. That temporary runner did not persist a complete report, so
the observation is disclosed here as a negative development result rather than
an audited artifact.

After fixing the route, the first paired real-DeepSeek pilot used the same task,
prompt, hidden grader, Harness commit, endpoint, and candidate package:

| Arm | Hidden score | Model turns | Input tokens | Output tokens | Duration | Questions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Native Harness | 5 / 5 | 7 | 60,889 | 1,806 | 16.221 s | 0 |
| Harness + RC.6 auto | 5 / 5 | 4 | 32,452 | 814 | 8.404 s | 0 |

RC.6 restored full task success with no added turn and no clarification. The
observed candidate run used 46.7% fewer input tokens and finished 48.2% faster,
but a single paired pilot is not a causal or statistical efficiency estimate.
The machine-readable first result preserves the exact counts, package SHA256,
host runtime SHA256, and Harness commit in
[`rc6-simple-bypass-run1.json`](../eval/pilots/results/rc6-simple-bypass-run1.json).
The release-candidate verification is stored separately so it can bind the
final published tarball byte for byte.

The final-tarball repeat again scored `5/5` in both arms and asked zero
questions, but it reversed the turn difference: native used 4 turns and RC.6
used 6. Across the two exploratory repeats, both arms scored `10/10`; RC.6 used
10 model turns versus native's 11, 82,039 input tokens versus 93,270, and 19.453
seconds versus 25.480. Because one repeat had two extra candidate turns, the
strict per-run overhead gate is not established. The aggregate is useful
regression evidence, not a statistical efficiency claim. See the
[`two-run summary`](../eval/pilots/results/rc6-simple-bypass-summary.json) and
[`final-candidate result`](../eval/pilots/results/rc6-simple-bypass.json).

## Mechanism Evidence

The regenerated deterministic Harness experiments report:

- unsafe stale-basis mutations: native `12/12`, Plan Lattice `0/12`;
- matched legitimate actions: native `7/7`, Plan Lattice `7/7`;
- unsafe post-`SIGKILL` continuations: native `2/2`, Plan Lattice `0/2`;
- matched legitimate restart controls: native `2/2`, Plan Lattice `2/2`.

These scenarios are intentionally designed to exercise the enforcement
mechanism. They do not estimate general coding quality or production outcomes.

## Verification

The RC.6 checkout passes:

- `459/459` plugin and protocol tests;
- `55/55` evaluation-controller and real-driver tests;
- TypeScript type-check and build;
- both committed mechanism-result checks;
- package creation and archive-content audit.

Reproduce the non-paid checks with:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
pnpm pack
```

## Install

```sh
gh release download v0.4.0-rc.6 --repo 1052326311/dsh-plan-lattice --pattern '*.tgz'
dsh plugin --profile web add ./dsh-plan-lattice-0.4.0-rc.6.tgz
```

## Evidence Boundary

RC.6 remains a prerelease. The two one-task paid repeats establish regression
recovery for that task, while the mechanism tests establish behavior only on
their designed hazards. General coding-quality uplift still requires the full
frozen external evaluation to complete with `releaseAllowed: true`. No general
quality uplift, leaderboard position, or production guarantee is claimed.
