# V24 Native-Failure Candidate Research

Status: **research complete; no V24 task, grader, or candidate comparison is frozen.**

Date: 2026-08-21

V23 is immutable ceiling evidence. Native DSH rc.7 completed that five-stage
fixture at 100/100, so V23 cannot measure Plan Lattice uplift and must not be
reinterpreted or rerun.

## Selection question

Find a stronger long-task workload for which native DeepSeek Harness rc.7 is
reliably below 90 before any candidate arm is run. The task must start from a
publicly documented failure class, exercise real DSH control paths, and admit a
hidden deterministic grader. Length or feature count alone is not sufficient.

The first-principles failure surface is execution authority, not summary prose:

1. Which requirements are still authoritative after a replacement?
2. Which work is pending, active, completed, or retired?
3. Which evidence makes a state transition valid?
4. Which current revision reaches a child or resumed process?
5. Can the host finish while any required state remains unresolved?

## DSH rc.7 source facts

The fixed native baseline is `dsh-v0.1.0-rc.7`, commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`.

| Surface | Native behavior | Evaluation consequence |
| --- | --- | --- |
| Todo | `todo_write` asks the model to update a whole-list snapshot, but no host gate stops mutation, advancement, or turn completion when the list is stale. The UI projection is cleared at the next `turn/start`. | Grade Todo freshness separately and test whether product work can advance or finish without a valid cursor. |
| Plan | Plan mode is soft prompt guidance. The persisted state is the mode, not an evidence-gated executable plan. A pending mode transition also has a documented process-local window. | Do not score the existence of plan prose. Score whether the accepted plan constrains later action. |
| Compaction | One LLM call produces `Primary Request`, `Pending Jobs`, `Current Work`, `Next Step`, and other narrative sections. The result replaces an older surface range as a user-role checkpoint. There is no independent item lifecycle, revision, or authority digest. | V24 must test actions after a successful replacement, not merely whether the summary contains a heading. |
| Fork child | A fork is seeded only through the latest completed turn and explicitly does not see the current in-flight turn. Its only current-turn input is the parent-authored `prompt`. | A same-turn material revision is a real authority-transfer boundary. The parent remains free to provide a complete prompt; the benchmark must not deliberately starve native. |
| Fresh child | Spawn and out-of-process providers receive a standalone prompt and no parent conversation. | Any child-dependent requirement must be present in the actual child request or recovered from an arm-neutral durable source. |
| Resume | Session events persist, but several control obligations are not necessarily reconstructed as wake or execution authority. | Cold resume must be tested through the real Session path, with an identical neutral continuation message in both arms. |

Primary source locations:

- [native Todo description and write path](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/todo/tool-todo/src/index.ts#L45-L66)
- [Todo projection reset](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/todo/tool-todo/src/index.ts#L128-L147)
- [native compaction instruction](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/compaction/compaction-basic/src/summarizer.ts#L31-L66)
- [checkpoint framing](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/compaction/compaction-basic/src/summarizer.ts#L184-L194)
- [fork current-turn boundary](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/subagent/tool-subagent/src/index.ts#L202-L236)
- [plan restart limitation](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/plan/plan-mode/README.md#L92-L97)

## Public failure evidence

### DSH-native evidence

| Evidence | Strength | Observed failure |
| --- | --- | --- |
| [DSH #1218](https://github.com/deepseek-ai/deepseek-harness/discussions/1218) | Strong trace | The agent completed Todo items 2, 3, and 4 over about seven minutes with no intervening `todo/write`, then batch-completed all items. |
| [DSH #3293](https://github.com/deepseek-ai/deepseek-harness/discussions/3293) | Independent report | Code, tests, and final response completed while native Todo still showed one active and eight pending items. |
| [DSH #3424](https://github.com/deepseek-ai/deepseek-harness/discussions/3424) | rc.7 reproduction | Work finished while the final native Todo remained in progress. |
| [DSH #374](https://github.com/deepseek-ai/deepseek-harness/discussions/374) | Deterministic two-process reproduction | A durable waking follow-up survived SIGKILL and resume but remained idle with no model request. |
| [DSH #857](https://github.com/deepseek-ai/deepseek-harness/discussions/857) | Source audit plus official documented limitation | A pending Plan selection can exist only in the process-local `WeakMap` window and be lost on restart. |
| [DSH #450](https://github.com/deepseek-ai/deepseek-harness/discussions/450) | Source-level fork reproduction | A child sees copied read history but not the parent's in-memory observation ownership, so edit fails until it rereads. |

These discussions are open community reports, not maintainer verdicts. The
source contracts and official README are stronger authority than discussion
interpretation.

DSH discussions also document failed or aborted compaction, but current public
evidence does **not** establish that every successful rc.7 compaction reliably
forgets root requirements. Successful-compaction semantic drift remains a
native calibration hypothesis, not a fact or publishable claim.

### Cross-harness evidence

These are not proofs about DSH. They identify recurring task-state failures
that V24 should make observable through DSH's real boundaries.

| Evidence | Failure class |
| --- | --- |
| [Codex #5957](https://github.com/openai/codex/issues/5957) | After compaction, the agent denied 23 edits it had made during the preceding hour instead of reconciling repository evidence. |
| [Codex #29811](https://github.com/openai/codex/issues/29811) | A completed one-shot steer regained action authority after compaction; a later reproduction emitted `ding!` eight times across eight replacement windows. |
| [Codex #38489](https://github.com/openai/codex/issues/38489) | Acknowledged but unresolved acceptance criteria disappeared from the completion gate and incomplete work was reported deployable. |
| [Codex #30945](https://github.com/openai/codex/issues/30945) | The host logged `task_complete` with an incomplete 0/6 plan and used progress commentary as the terminal result. |
| [Codex #34095](https://github.com/openai/codex/issues/34095) | Twenty-four compactions preserved the broad goal while degrading the execution frontier enough to prevent convergence. |
| [Claude Code #85311](https://github.com/anthropics/claude-code/issues/85311) | A child implemented the opposite of an explicit one-path constraint, then wrote a passing test that legitimized the violation. |
| [Claude Code #86359](https://github.com/anthropics/claude-code/issues/86359) | A machine-generated summary's specific next step outranked project instruction files after continuation. |
| [Claude Code #76844](https://github.com/anthropics/claude-code/issues/76844) | Maintainer-reproduced: resume kept task files but attached TaskList to a new runtime identity. |
| [Claude Code #74990](https://github.com/anthropics/claude-code/issues/74990) | Maintainer-reproduced: compaction retained the registry but omitted its model-visible capability index. |

WorkBuddy has no attributable public product issue tracker for this failure
class. `Tencent/workbuddy-bench` is an evaluation framework, not public
WorkBuddy product source. It must not be cited as an official product defect.

## External benchmark search

### Ranked candidates

| Rank | Candidate | Published DeepSeek-V4-Flash result | Fit | Main confound |
| --- | --- | --- | --- | --- |
| 1 | [EvoCode-Bench `jobforge-dag-runner`](https://github.com/UniPat-AI/EvoCodeBench/blob/f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32/docs/data/analysis/theme_d1_w1_code_build_greenfield_implementation.json) | 5/9 rounds = 55.6; 98% cases | Nine cumulative requirements, an explicit correction in round 4, exact output contracts, deterministic local verifier. DeepSeek-V4-Pro reaches 9/9, so the model family can solve it. | Public task and solution create medium contamination risk; published result used `terminus-2`, not DSH rc.7. |
| 2 | [EvoCode-Bench `forgekit`](https://github.com/UniPat-AI/EvoCodeBench/blob/f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32/docs/data/analysis/theme_d1_w11_code_build_automation_scripting.json) | 3/8 rounds = 37.5; 98% cases | Brownfield cumulative behavior and old-behavior preservation. | Cache and mtime semantics defeat nearly every model, so loss may measure coding capability rather than continuity. |
| 3 | [EvoCode-Bench `secsentinel`](https://github.com/UniPat-AI/EvoCodeBench/blob/f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32/docs/data/analysis/theme_d9_w11_security_automation_scripting.json) | 9/15 rounds = 60.0; 96% cases | Longest requirement chain and cumulative verifier. | Exact numeric formulas and malformed-input handling are strong non-harness confounds. |

The selected benchmark source commit is
`f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32`. The clean re-release explicitly
fixed Harbor's shared-verifier leak and reran the benchmark. During agent phases,
`/tests` and `/logs/verifier` must remain absent.

Other candidates were rejected for V24:

- ICAE-Bench is relevant to ambiguous product intake, but its Oracle and critic
  add model calls and its repository/release licensing needs clarification.
- FeatureBench and SWE-bench Pro offer hidden local grading but are single-turn
  implementation tasks, not natural compaction/revision/resume workloads.
- WorkBuddy Bench has broad real-role tasks but no DSH adapter or demonstrated
  long-task continuity failure.
- LongCodeBench currently lacks public tasks and a usable grader.

## V24 development selection

Use the official nine-round `jobforge` chain as the first native-only
calibration family. Preserve every product instruction and official cumulative
verifier. Add only arm-neutral host lifecycle boundaries:

1. Run rounds 1-3 in one persisted root Session.
2. Require a successful native compaction after round 3. A failed, aborted, or
   truncated compaction is infrastructure failure, not model score.
3. Deliver official round 4 unchanged. Its comma-to-space DOT correction is the
   material revision; all unrelated older requirements remain authoritative.
4. Flush and cold-restart after round 5, resume the same Session, and deliver
   official round 6 without restating prior requirements.
5. After round 7, require exactly one foreground fork audit. The parent authors
   the child prompt under native rules and is not prevented from restating all
   required context. The audit result is evidence, not a replacement grader.
6. Require a second successful native compaction after round 7, then run rounds
   8 and 9.
7. Grade each official round with the cumulative hidden verifier. Separately
   grade trace integrity: successful compaction brackets, Todo freshness,
   current-revision child input, same-Session resume, no replay of retired
   behavior, and no terminal completion while work remains.

This is a development selection, not a frozen V24 protocol. No driver or grader
may be adapted after candidate output is observed.

## Native qualification gate

Before any Plan Lattice arm:

1. Freeze the runtime candidate, native wrapper, task bytes, official verifier,
   lifecycle schedule, model route, budget, timeout, and failure taxonomy.
2. Run five native-only development calibrations with DSH rc.7 and
   `deepseek-v4-flash`.
3. Qualify only if all five scores are below 90, the median is at most 85, the
   maximum-minus-minimum spread is at most 15 points, and the losses are
   attributable to continuity/control failures rather than ordinary Go errors.
4. If `jobforge` fails this gate, reject it before any candidate run and repeat
   the same process with `forgekit`, then `secsentinel`.
5. Once one family qualifies, freeze a previously unused instance/seed before
   paired execution. Do not inspect candidate output and then change the task,
   grader, thresholds, or selected family.

The paired release gate remains separate: same model, budget, runtime, prompts,
stage order, lifecycle boundaries, and fixture in both arms; candidate uplift
must be at least 15 absolute points and 30% relative, with case score not lower.
Failures and all allowed infrastructure reruns must be published.

## Current decision

Research found a credible stronger task family, but it has **not yet proved**
native DSH rc.7 is stably below 90. The next action is to build only the
native-calibration adapter for `jobforge`, freeze it, and run the five native
qualifying samples. Candidate execution remains forbidden until the gate passes.
