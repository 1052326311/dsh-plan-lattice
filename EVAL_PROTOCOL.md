# Plan Lattice v0.4 strict evaluation protocol

## Status and claim boundary

This protocol is **preregistered but unexecuted**. It defines the evidence that
must exist before `v0.4.0` may be released or described as an improvement. The
checked-in files contain no paid real-model outcomes. Infrastructure smoke runs
are excluded from every statistical claim. Router V1 through V5 first reveals
are immutable failed archives. A source-disjoint V6 set, frozen only after the
invariant router and packaged prior are frozen, is the mandatory preflight
gate. Until it passes, this candidate is not execution-ready and no 6+90 run
may start.

The router evaluation varies languages, repositories, task templates, and
product domains while holding the causal rubric stable. Labels are based on
the completeness of the authoritative mutation basis, its exposure to expiry,
and the impact of acting from a stale basis. Outcome clarity, verification,
execution horizon, boundary coupling, volatility, authority, coordination, and
reversibility are evidence for those three axes. Surface words such as `bug`,
`feature`, `tracking`, framework names, and benchmark family are never labels
by themselves.

The failed V4 router code is frozen at
`97ba3b3fe2dc9d72453735900e73c6f03bf8dd7c`. Its base pool contains 240
real closed issues, balanced 120 English and 120 Chinese, from repositories and
issue URLs absent from every revealed corpus. Two annotators label all rows
without router access; a third independently labels only disagreements. A
separate 120-row tracking, migration, and epic supplement was preregistered for
long-program coverage. Sixty distinct source issues remain English and sixty
distinct issues receive source-bound Chinese translations before blind
annotation. The supplement also shares no repository or URL with prior pools.

Its immutable first reveal did not pass and is development-only. V5 then used
repositories and issue URLs absent from V1 through V4, froze runtime commit
`e5020a07f6e059a4bae9c1f972569e6c484475df`, and revealed exactly once. It
also failed every release gate except probe rate. V6 must use repositories and
issue URLs absent from V1 through V5 and freeze a new runtime, source manifest,
and annotation protocol before its one reveal. V4/V5 prompts, labels,
classifier errors, and post-reveal development results cannot be cited as V6
evidence.

The final 120-row selection is fixed at 60 rows per language: 30 `bypass`, 18
`contract`, and 12 `lattice`. Selection is by a committed SHA-256 seed within
each resolved stratum. If a stratum is too small, evaluation stops; route
thresholds or class counts are not relaxed. Router code cannot change after
collection, translation, annotation, selection, or first reveal.

The candidate commit remains `UNRESOLVED_UNTIL_CODE_FREEZE` until implementation,
grader, task selection, and adapter code are frozen. Paid execution is disabled
while that placeholder remains. A failing release gate blocks both the release
and uplift language; the rubric, failed runs, or task list must not be changed in
response to observed scores.

## Frozen sources

| Source | Repository | Exact commit |
|---|---|---|
| DeepSeek Harness | `deepseek-ai/deepseek-harness` | `47f943859bef60e4160492346772ded9b24f765a` |
| Harbor | `harbor-framework/harbor` | `a27e9c2ae10a31c40b2dcef33ef5486bce36e185` |
| ICAE-Bench | `ALEX-nlp/ICAE-EVAL` | `b33fe657bc813b0744def61d1fca9f5f3f9a1e9d` |
| EvoCodeBench | `UniPat-AI/EvoCodeBench` | `f8fcfaa1c9ad1c5b0bbc433323b587e4ddea2f32` |

`eval/v0.4/benchmark-lock.json` is authoritative. `pin-benchmarks.mjs`
verifies local checkouts against these commits. Resolving moving `HEAD` refs is
provided only for an intentional pre-registration relock; it is not part of a
statistical run.

ICAE tasks are selected from the pinned `harness/repos.yaml` without inspecting
outcomes. For each bucket, candidate `repo_id` values are ordered by
`SHA256(plan-lattice-v0.4-icae-selection-2026-08-15:<repo_id>)`; the first two
are selected. Buckets are JavaScript plus TypeScript, Python, and Go. The six
selected repositories and hashes are checked into the lock. The anonymous
`realcode@NNN` locator is resolved from the pinned ICAE `repo_alias.json` only
when the benchmark workspace is prepared.

EvoCode uses these three pinned Harbor task IDs:

- `theme_d1_w1_code_build_greenfield_implementation`
- `theme_d1_w5_code_build_integration_e2e_wiring`
- `theme_d6_w1_database_storage_greenfield_implementation`

Harbor runs with `--resume-trajectory`. The environment and the exact DSH
session persist across every step. The arm-specific Linux runtime tarball and
base image digest are frozen in `eval/v0.4/runtime-artifacts.json`; unresolved
artifacts make preflight fail before a model call.

Simple and ICAE runs use a separate host-platform Harness runtime tarball. Both
host and Linux runtimes are built from `git archive` at the pinned Harness
commit, then content-addressed in `runtime-artifacts.json`; local ignored build
outputs are never an execution input. Controlled Linux runtimes package the
plugin directly from its exact Git commit and carry checked internal arm,
Harness, plugin-package, plugin-commit, support-plugin, profile-patch, and
base-image metadata. Preflight re-hashes those installed bytes from inside the
tarball instead of trusting metadata alone. The manifest also binds the
complete repository driver source tree.

## Experimental design

All paired arms use the same `deepseek-v4-flash` deployment, endpoint, Harness
commit, token ceiling, timeout, workspace seed, permission policy, and external
grader. Credentials and the endpoint enter only through the one-shot
`secure-run.sh` environment. The launcher transfers the real key to a local
credential proxy over an anonymous pipe and execs the controller with a
one-time token; the upstream key is not present in Harness, container, or agent
parent-process environments and is never written to a run spec, result record,
log, or release artifact. A separate one-time control capability binds the
proxy PID, upstream-endpoint digest, and private audit path before execution;
that capability and the audit path are removed from every driver child. Every
authorized model request is assigned an agent or Oracle role and counted
against durable Harness session metrics. A mismatch is a retained task failure.

Six development runs exercise infrastructure and are permanently marked
`includedInStatistics: false`. All six must complete with valid provenance
before any statistical slot may start or a result set may release. The
statistical manifest contains exactly 90 runs in one deterministic, seeded
random order:

| Suite | Tasks | Arms | Repetitions | Runs |
|---|---:|---:|---:|---:|
| Explicit small tasks | 6 | native, v0.3 always-on, v0.4 auto | 2 | 36 |
| ICAE fuzzy product builds | 6 | native, v0.4 never-ask, v0.4 critical-ask | 2 | 36 |
| EvoCode dynamic requirements | 3 | native, contract ceiling, full lattice | 2 | 18 |

The frozen order and all run IDs are in `eval/v0.4/frozen-manifest.json`.
Regeneration must byte-match its canonical form. Model outcomes are append-only
JSON Lines records and never alter the manifest. Each record is linked to its
predecessor, a controller receipt, the normalized driver payload, and the exact
attempt artifact tree. The tree retains the final simple/ICAE workspace,
external grader outputs, proxy request slice, sanitized raw driver streams, and
the controller-normalized payload. Deleting, reordering, or editing either
records or artifacts fails deterministic analysis-time verification. This hash
chain is reproducibility evidence, not independent third-party attestation.
Before execution, an Ed25519 public key is frozen in the preregistration. Its
private key enters only the isolated proxy/signer process, and every final
record digest must carry a valid signature. The signer also fsyncs an external
append-only state ledger and rejects stale chain heads, duplicate attempt IDs,
manifest changes, and non-contiguous per-run attempts after restart. This
prevents post-run chain rewrites without both the independently retained key and
its state ledger; WORM custody and public timestamping remain deployment duties.

Each accepted result binds the exact Harness commit, model-config digest,
runtime-policy digest, endpoint digest, source-lock digest, and arm-specific
plugin commit, plus the driver-source and runtime-artifact digests. Task and
grader digests must be identical across all arms of the same task/repetition
cell. The configured external driver path must resolve to the repository-owned
driver entry; an arbitrary executable cannot self-report provenance.

Every host Harness child runs under a Darwin `sandbox-exec` profile that denies
process inspection and reads of the evaluation repository and per-attempt
controller-spec directory. For ICAE, the minimal environment also omits
benchmark root paths; the profile denies reads and writes beneath both hidden
benchmark and controller-private roots and direct access to official ports 50001 through
50003. A capability-protected five-question relay exposes no append ID,
statistics endpoint, or missed constraint and independently counts questions;
the Oracle and official grader remain in the parent process. Internal ICAE
retry backoff is disabled and exactly one agent invocation is accepted per
ledger slot. A host without these isolation primitives is not execution-ready.

## Outcomes and pairing

The external driver owns environment preparation and grading, but must return
the schema in `eval/v0.4/schemas/driver-result.schema.json`. The framework adds
run identity, attempt lineage, timestamps, manifest digest, sanitized stderr
and raw-stdout digests, normalized-payload digest, artifact digest,
controller-receipt digest, and the ordered result-chain digest according to
`run-result.schema.json`.

Simple-task score is normalized to points out of 100. Total tokens are input
plus output tokens. Overhead is `(candidate - native) / native`, paired by task
and repetition. A zero native value has zero overhead only when the candidate is
also zero; otherwise overhead is infinite.

`modelTurns`, input/output tokens, and `durationMs` are derived from persistent
Harness session events and the credential-proxy audit. The proxy rejects agent
requests whose model, temperature, output ceiling, streaming-usage contract, or
session identity differs from the freeze. Every response usage record, including
compaction summaries, must exactly match durable Session usage. Duration is the
timestamp span from the first to last retained event;
one-time profile installation, task
materialization, container setup, and external grader time are excluded.

ICAE's `hiddenFeatureScore` and `criticalRequirementsMissed` come from the
frozen external grader and Oracle statistics. EvoCode's
`historicalRequirementRegressions` and `cumulativeCaseScore` come from the
pinned multi-step grader. Clarification count is the number of user/Oracle
questions initiated by the tested agent, not internal tool calls.

An EvoCode historical regression is one unique `case_id` whose official
`CASE_RESULT` was `success` in an earlier observed round and later becomes
`fail` in a round strictly after its `origin_step`. A case is counted at most
once. `cumulativeCaseScore` is the arithmetic mean of each round's official
`success_count / total_cases * 100`. Missing case identities invalidate the run;
the driver never substitutes reward-only or aggregate-score guesses.

## Failure and retry policy

Every attempt is retained. Agent errors, model timeouts, requirement misses,
submission-caused grader failures, and agent-caused tool errors are outcomes,
not infrastructure faults, and cannot be rerun. A subsequent attempt is valid
only when the immediately preceding record is classified `infrastructure`, its
code is in the preregistered allowlist, and `rerunOfAttemptId` links to it.

Allowed infrastructure codes are limited to benchmark or Oracle service
unavailability, host network outage, container runtime failure, filesystem
capacity exhaustion, and a runner crash proven to occur before a model call.
An unresolved infrastructure slot makes the result set incomplete; an
unclassified failure does not receive a discretionary rerun.

## Release gates

All integrity and performance gates are conjunctive.

Simple tasks:

- Mean paired v0.4-auto score is no worse than native by more than 2 points.
- Added model turns are exactly zero for every pair.
- Median token and duration overhead are at most 5%; P95 is at most 10%.

ICAE:

- Mean hidden-feature score is at least 1.5 times native and at least 15 points
  higher in absolute terms.
- Mean critical-requirement misses fall by at least 50%.
- The deterministic paired-bootstrap 95% confidence interval for hidden-score
  differences has a lower bound greater than zero.

EvoCode:

- Historical valid-requirement regressions fall by at least 50%.
- Mean cumulative case score is higher, and its paired-bootstrap 95% lower bound
  is greater than zero.
- Full Lattice asks a median of at most 3 questions and no more than 5 in a run.

The bootstrap uses 20,000 paired resamples with a seed derived from the frozen
manifest. `analyze.mjs` exits `0` only when all gates pass and `3` otherwise.
Missing data, unauthorized reruns, digest mismatches, or unresolved
infrastructure failures block release. Both execution and analysis independently
recompute protocol checksums, the deterministic manifest, driver digest, and
clean candidate ancestry before accepting evidence.

## Execution sequence

1. Freeze the v0.4 candidate commit before any paid statistical run.
2. Verify source checkouts, protocol checksums, deterministic manifest, driver,
   grader digest, and six excluded infrastructure runs.
3. Execute the 90-run manifest in frozen order. Keep every failure.
4. Analyze the append-only JSONL without editing it.
5. If and only if `releaseAllowed` is true, prepare the tarball, SHA256,
   per-run results, failed samples, grader, exact source commits, and reproduction
   commands. Publishing remains a separate human-reviewed action.

No independent leaderboard is part of this protocol. Therefore it cannot
support a "global top two" claim. A passing result may support only the measured
statement for this fixed model, budget, task set, and harness commit.
