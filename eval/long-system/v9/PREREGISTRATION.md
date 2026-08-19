# RC7 Native Long-System V9 Preregistration

## Question

On a bounded, written system-delivery task, does the candidate preserve the
accepted contract across native DSH compaction, cold process resume, native
child delegation, and a later human revision more successfully than the same
DSH execution without Plan Lattice?

## Candidate Boundary

Candidate commit `f8652cfcf409ad14e059b3709332174b38d31ded` preserves the
native first-turn path and keeps DSH in control of prompt construction, plan
mode, todo projection, compaction, session recovery, and child task delivery.
The plugin restores its durable contract only after a native discontinuity. It
does not rewrite the child user prompt or add a second plan protocol.

The V8 pair is retained as negative and will not be rerun. Its candidate wrapper
incorrectly instructed the model to call `lattice_open` before repository
inspection and to manually construct a full action-binding payload for every
Bash command. V9 removes that wrapper prose entirely. Its candidate arm mounts
only the actual package, the same matched tool boundary as native, and the
minimal host adapter needed to make the existing strict-Bash guard observable.

## Causal Boundary

Both arms receive byte-identical task text, fixture, hidden grader, official
`dsh-v0.1.0-rc.7` host runtime, model route, temperature, process-stage order,
compaction schedule, workspace Bash channel, hidden tool list, and time/token
limits. Every stage runs in a new Harness process against its durable session.
The child is created through the native `subagent/start` path and receives its
exact ordinary DSH delegation message. The only treatment difference is whether
the candidate tarball is installed.

The task is deliberately smaller than V8 but retains the behavior under test:
five staged implementations, two native compactions, cold resumes, a child that
must recover inherited outcome through native runtime context, and a human
revision that removes an earlier command. This is a targeted mechanism and
outcome experiment, not a general leaderboard or a claim about all coding work.

## Registered Analysis

The pair runs once in this order: native, candidate. Each arm has at most 32
agent requests, 300,000 observed input tokens, 40,000 output tokens, and one
hour wall time. The frozen task, grader, fixture, candidate package source,
runtime, wrappers, driver, source hashes, and stage-message hashes are bound in
`frozen-manifest.json` before any model call. Failures, partial workspaces,
sessions, audit rows, child evidence, and grader output are retained. Only a
pre-registered infrastructure failure before the first model response permits a
replacement run.

An exploratory-positive signal requires both arms to finish within budget plus:

1. candidate final score improves by at least 15 points and 1.3x;
2. candidate hard-requirement misses fall by at least 50 percent;
3. candidate retains no obsolete `cancel` behavior;
4. candidate has no child reporting regression;
5. candidate crosses both scheduled native compactions; and
6. candidate child lineage, native start binding, and exact initial DSH child
   user message are all verified from persistent Session evidence.

One pair cannot establish statistical uplift, global ranking, or stable-release
eligibility. A failed gate remains a retained result; the candidate, task,
grader, threshold, and source manifest are not edited and rerun under the V9
identity.
