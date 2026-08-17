# First-Drift Benchmark

![First-drift stress-test results](demo/results/first-drift-summary.svg)

## Observed Result

In 12 hand-designed long-task drift hazards, native DeepSeek Harness entered
the engineered unsafe tool body in `12/12` cases (`100%`). With Plan Lattice, it
entered the unsafe tool body in `0/12` (`0%`). That is a `100` percentage-point
difference on the exact hazards tested.

| Arm | Unsafe tool-body entries | Observed rate |
| --- | ---: | ---: |
| Native Harness | 12 / 12 | 100% |
| Harness + Plan Lattice | 0 / 12 | 0% |

In seven matched availability controls, both native Harness and Plan Lattice
executed `7/7` legitimate actions. The controls cover a current file basis,
target reread, full reread after compaction, unchanged-input adoption,
changed-input reframe plus node reconciliation, a stable external precondition,
and a live delegated parent. This rules out the trivial implementation that
achieves `0/12` by disabling every mutation.

The 12 scenarios invalidate target contents, accepted background, visible
context, explicit or implicit current user intent, the exact reviewed message
sequence, a general-purpose shell boundary, an external
precondition, exact tool arguments, the durable plan revision, or delegated
parent ownership immediately before a protected mutation. The driver uses the
real Harness context, session, agent, compaction, and tool-runtime services.
Every controlled arm must block before
the protected tool body, preserve the safe artifact, and match its expected
enforcement mechanism. An unrelated exception does not pass.

## Reproduce

No model call or API key is required:

```sh
pnpm install --frozen-lockfile
pnpm run demo:first-drift:check
```

- [Raw per-arm JSON](demo/results/first-drift-benchmark.json)
- [Rendered result](demo/results/first-drift-benchmark.md)
- [Result chart](demo/results/first-drift-summary.svg)
- [Executable driver](demo/first-drift-benchmark.mjs)
- [Audited RC.4 release](https://github.com/1052326311/dsh-plan-lattice/releases/tag/v0.4.0-rc.4)
- [Crash-safe V13 protocol freeze](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v13-protocol-freeze-v2)
- [Crash-safe V14 protocol freeze](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v14-protocol-freeze-v2)
- [Crash-safe RC.4 model-study freeze](https://github.com/1052326311/dsh-plan-lattice/releases/tag/model-rc4-study-protocol-freeze-v3)
- [RC.4 changes and verification](docs/RC4_RELEASE.md)
- [Verify workflow](https://github.com/1052326311/dsh-plan-lattice/actions/workflows/verify.yml)

## Scope Boundary

This is a mechanism stress test, deliberately constructed to exercise Plan
Lattice's enforcement boundary. It is not a random sample of software tasks and
does not establish a percentage improvement in general coding quality,
real-world success rate, or production outcomes. Those broader claims remain
blocked on the preregistered external-model evaluation.

The separate
[`V13 prospective router protocol`](eval/router-corpus/v13/PREREGISTRATION.md)
uses future GH Archive objects, three isolated annotators, exact max-flow
capacity, a future public drand beacon, and one immutable reveal. Its result is
reported whether it passes or fails, and router accuracy is not presented as
software-task outcome uplift.

The older 90-run external-model manifest binds commit
`dc55716525987fcb7cb46579a9c957877cbd23c2` from the RC.3 line. It does not bind
RC.4 and is not cited as RC.4 outcome evidence. The RC.4 v3 study is now
preregistered, but no model outcome exists and its execution remains locked.

## Prospective RC.4 Router Evidence

V13 froze router commit `b5971547af8c733312d2efce888cdf2573cc379d`
before RC.4 fixed polite mutation requests. That runtime classifies `Can you
build a customer support application?` as `bypass`; RC.4 classifies it as
`contract`. The crash-safe V13 v2 protocol freezes that same pre-fix runtime,
and its result will be reported as the comparison.

The public
[`router-v14-rc4-candidate-freeze`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v14-rc4-candidate-freeze)
tag binds RC.4 commit `7cb3c77f9dab6ef193eb77318fb87389b877b526`,
whose commit predates the V13 future source window. The crash-safe
[`router-v13-protocol-freeze-v2`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v13-protocol-freeze-v2)
and
[`router-v14-protocol-freeze-v2`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/router-v14-protocol-freeze-v2)
releases bind the paired protocols; V14's freeze is commit
`4031b0bf954892ffb4531f4504a070f9f8288938`. The
[`V14 preregistration`](prospective/router-v14/PREREGISTRATION.md) reuses the
exact V13 source frame, annotation, capacity proof, random selection, prompts,
labels, and gates. It cannot choose another corpus. V14 freezes before V13
reveals, then requires and digest-binds the immutable V13 outcome before its own
single reveal. Both outcomes are published whether they pass or fail.

This prospective comparison measures automatic-control routing. It still does
not establish general coding-quality or software-task uplift. That broader
claim additionally requires the frozen
[`RC.4 model study v3`](https://github.com/1052326311/dsh-plan-lattice/releases/tag/model-rc4-study-protocol-freeze-v3)
to execute completely and return `releaseAllowed: true`.
