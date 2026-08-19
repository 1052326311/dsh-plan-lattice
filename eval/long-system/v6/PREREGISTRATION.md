# RC7 Native Long-System V6 Preregistration

## Claim Under Test

With the same official DeepSeek Harness `dsh-v0.1.0-rc.7` runtime, model,
temperature, request/token budget, workspace permissions, shell adapter,
five-stage task, context replacements, restart boundary, delegated child stage,
and material human revision, the candidate must retain more of the accepted
system contract than native DSH.

The candidate is commit `f9d6cec25ab88cfec756f9d13a97c72d1a7d1df9`. It uses
DSH's own prompt assembly, conversation replay, compaction, plan mode, tool
transport, and child delivery. Plan Lattice supplies only durable authority,
the current execution address, and fresh-basis authorization for protected
work. It does not replace native planning or delegation prompts.

## Retained Negative Evidence

V5 remains a valid negative result. It used the same task and hidden grader,
but candidate commit `8b451ac18f6f44f6757744cc4b30080672994621` reached
1,017,437 observed input tokens and scored `5/100`, the same as native. Its
mechanical refresh/checkpoint history amplified large tool payloads. V6 does
not modify V5 artifacts or reinterpret that result.

V6 tests the post-V5 corrections: controller-owned bootstrap, native DSH
compaction/pruning ownership, semantic-only checkpoints, compact runtime
state, and a child scope bound to the exact parent leaf.

## Frozen Task And Arms

The task and grader are copied byte-for-byte from V5. It requires:

1. Foundation implementation from a complete initial specification.
2. A real DSH compaction before continuing the state machine in a new root process.
3. A real native child session that implements reporting without a replayed parent conversation.
4. A material human revision that replaces `reopen` with `requeue`.
5. Another real DSH compaction before final integration and hidden grading.

`native` has no Plan Lattice package. `v0.4-lattice` installs only the exact
candidate built from its frozen commit. Both use the same `workspace-tree`
shell adapter, permissions, model endpoint, model settings, process timeout,
and `60` agent-request / `1,000,000` input-token / `80,000` output-token
budget. The frozen order is native then candidate; each arm gets a fresh
workspace, DSH home, sessions, proxy attempt, and budget counter.

## Outcome And Gate

The hidden grader scores `0..100`, hard-requirement misses, stale removed
behavior, revision-artifact coverage, and child-report regression. A positive
targeted signal requires both arms to complete within budget and the candidate
to meet all of:

- at least `15` score points and `30%` relative score above native;
- at least `50%` fewer hard-requirement misses;
- no stale `reopen` behavior;
- no regression of reporting completed by the delegated child;
- at least two native compaction summaries and an authenticated child lineage.

Every output, failure, and partial workspace is retained. The pair cannot
justify a general quality claim, a release, or a ranking. A positive pair only
permits a separately preregistered multi-task replication study.

## Freeze And Execution

`freeze.mjs --write` reads the actual official rc.7 runtime tarball and binds
its SHA-256 with every controller, task, fixture, wrapper, grader, and shared
driver source digest. The candidate commit must be an ancestor of the clean
driver checkout but cannot be changed by an execution environment variable.

`preflight.mjs` verifies the frozen manifest, candidate tree, exact runtime
bytes, required local tools, and clean driver checkout before it reports whether
credentials are present. `run-pair.mjs` refuses to run without that preflight
and accepts model credentials only through `DEEPSEEK_API_KEY` in its process
environment. Credentials, bearer headers, and proxy tokens are redacted from
retained model logs.
