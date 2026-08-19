# RC7 Native Long-System V11 Preregistration

## Question

On a bounded, written system-delivery task that reaches DeepSeek's native
output ceiling, does the candidate resume the same controlled task through
DSH's own next-turn queue, then preserve the accepted contract across native
compaction, cold process resume, child delegation, and a later human revision
more successfully than the same DSH execution without Plan Lattice?

## Candidate Boundary

Candidate commit `06aa8f2a1df1b5efbd61586d13beb58684b5fcfd` preserves the
native first-turn path and keeps DSH in control of prompt construction, plan
mode, todo projection, compaction, session recovery, and child task delivery.
After DSH exposes a terminal `max-tokens` result for an active controlled task,
the plugin can enqueue at most two native `agent.followup()` turns. It never
uses same-turn `steer()`, does not rewrite the child user prompt, and does not
add a second plan protocol.

V10 is retained as an executed negative result and will not be rerun. Its
candidate reached one native continuation, then violated the OpenAI-compatible
tool-call ordering contract by appending an input-review marker before the
enclosing tool result. V11 fixes only that native integration fault by using
`ToolRunContext.deferContext()`, which DSH commits after `tool/result`. V11
adds no Plan Lattice control protocol prose. Its candidate arm mounts only the
actual package, the same matched tool boundary as native, and the minimal host
adapter needed to make the existing strict-Bash guard observable.

## Causal Boundary

Both arms receive byte-identical task text, fixture, hidden grader, official
`dsh-v0.1.0-rc.7` host runtime, model route, temperature, process-stage order,
compaction schedule, workspace Bash channel, hidden tool list, and time/token
limits. Every stage runs in a new Harness process against its durable session.
The child is created through the native `subagent/start` path and receives its
exact ordinary DSH delegation message. The sole treatment difference is that
the candidate tarball is installed with `maxTokenContinuations: 2`; the native
arm has no plugin and thus preserves rc.7's manual-continuation behavior.

The task is deliberately smaller than V8 and materially different from V9. It
is reused from V10 solely because the V10 candidate was invalidated before any
fair outcome comparison; the candidate identity, protocol identity, manifest,
and all source hashes are new. It retains the behavior under test: five staged implementations, two native
compactions, cold resumes, a child that must recover inherited outcome through
native runtime context, and a human revision that removes an earlier command.
This is a targeted mechanism and outcome experiment, not a general leaderboard
or a claim about all coding work.

## Registered Analysis

The pair runs once in this order: native, candidate. Each arm has at most 12
agent requests, 400,000 observed input tokens, 100,000 output tokens, and one
hour wall time. The frozen task, grader, fixture, candidate package source,
runtime, wrappers, driver, source hashes, and stage-message hashes are bound in
`frozen-manifest.json` before any model call. Failures, partial workspaces,
sessions, audit rows, child evidence, and grader output are retained. Only a
pre-registered infrastructure failure before the first model response permits a
replacement run.

An exploratory-positive signal requires both arms to finish within budget plus:

1. candidate final score improves by at least 15 points and 1.3x;
2. candidate hard-requirement misses fall by at least 50 percent;
3. candidate retains no obsolete `close` behavior;
4. candidate has no child reporting regression;
5. candidate crosses both scheduled native compactions and records at least one
   bounded native continuation after a `max-tokens` finish; and
6. candidate child lineage, native start binding, and exact initial DSH child
   user message are all verified from persistent Session evidence.

One pair cannot establish statistical uplift, global ranking, or stable-release
eligibility. A failed gate remains a retained result; the candidate, task,
grader, threshold, and source manifest are not edited and rerun under the V11
identity.
