# RC7 Native Long-System V15 Preregistration

## Question

On a bounded, written system-delivery task, does the candidate preserve the
accepted contract across native
compaction, cold process resume, child delegation, and a later human revision
more successfully than the same DSH execution without Plan Lattice?

## Candidate Boundary

Candidate commit `e49eec5f86f7902110c7cbb328af7240a3e4241a` preserves the
native first-turn path and keeps DSH in control of prompt construction, plan
mode, todo projection, compaction, session recovery, and child task delivery.
It observes those native continuity boundaries, reprojects verified task
authority only after a boundary, and independently blocks protected writes
until a fresh basis exists. It does not rewrite the child user prompt or add a
second plan protocol.

V14 is retained as a pre-execution negative result and will not be rerun. Its
real rc.7 smoke passed clean installation plus both native and candidate root
and one-shot-child lifecycles. The later candidate max-token stage made one
request and durably ended as `max-tokens`, but appended no continuation. Auto's
native-first request intentionally has no Lattice assembly attestation, and the
truncation recorder had incorrectly treated that absence as an unknown session.

V15 changes only that lifecycle fault. A request already admitted as DSH's
exact native-first or native-recovery wire may use its final
`GenerateOptions.sessionId` to queue a bounded native `followup()`. It does not
rebuild the prompt, create a second plan, or inject Plan Lattice system text on
either native-first turn. The durable Session remains the continuation budget.

## Causal Boundary

Both arms receive byte-identical task text, fixture, hidden grader, official
`dsh-v0.1.0-rc.7` host runtime, model route, temperature, process-stage order,
compaction schedule, workspace Bash channel, hidden tool list, and time/token
limits. Every stage runs in a new Harness process against its durable session.
The child is created through the native `subagent/start` path and receives its
exact ordinary DSH delegation message. The sole treatment difference is that
the candidate tarball is installed in its default `activationMode: auto`; the native
arm has no plugin and thus preserves rc.7's manual-continuation behavior.

The task is deliberately smaller than V8 and materially different from V9. It
is byte-identical to V14 because V14 failed its zero-cost lifecycle smoke before
the second max-token adapter request and no paid outcome comparison was run. The candidate
identity, protocol identity, manifest, and all source hashes are new. It retains
the behavior under test: five staged implementations, two native
compactions, cold resumes, a child that must recover inherited outcome through
native runtime context, and a human revision that removes an earlier command.
This is a targeted mechanism and outcome experiment, not a general leaderboard
or a claim about all coding work.

## Registered Analysis

The pair runs once in this order: native, candidate. Each arm has at most 22
agent requests, 800,000 observed input tokens, 120,000 output tokens, and one
hour wall time. The frozen task, grader, fixture, candidate package source,
runtime, wrappers, driver, source hashes, and stage-message hashes are bound in
`frozen-manifest.json` before any model call. Failures, partial workspaces,
sessions, audit rows, child evidence, and grader output are retained. Only a
pre-registered infrastructure failure before the first model response permits a
replacement run.

An exploratory-positive signal requires both arms to finish within budget plus:

1. candidate final score improves by at least 15 points and 1.3x;
2. candidate hard-requirement misses fall by at least 50 percent;
3. candidate retains no obsolete `checkout` behavior;
4. candidate has no child reporting regression;
5. both arms cross both scheduled native compactions, run all five process
   epochs, and complete the material revision; and
6. both arms' child lineage, native start binding, and exact initial DSH child
   user message are all verified from persistent Session evidence.

One pair cannot establish statistical uplift, global ranking, or stable-release
eligibility. A failed gate remains a retained result; the candidate, task,
grader, threshold, and source manifest are not edited and rerun under the V15
identity.
