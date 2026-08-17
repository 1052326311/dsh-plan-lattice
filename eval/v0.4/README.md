# v0.4 strict evaluation sidecar

> **Historical controller.** Its exact runnable assets are frozen at commit
> `0414dfa5035e6ca5cdc511964883b64be62ad44e`. Current `main` intentionally
> fails its protocol checksum after later router work; it must not silently
> reinterpret that old matrix. The RC.4 successor lives in
> [`prospective/model-rc4-study`](../../prospective/model-rc4-study/PREREGISTRATION.md).

This directory is an auditable evaluation controller. It does not contain a
DeepSeek API key, a built-in paid-model adapter, or real experimental results.
Every command below is free and local unless it invokes `secure-run.sh`.

## Protocol amendments

- Amendment 1, before any model run, changed the bootstrap unit from repeated
  runs to independent tasks.
- Amendment 2, before any model run, replaced a non-portable direct CLI deploy
  with a generated root containing every workspace package reachable from the
  CLI through production dependencies and required peers. It materializes
  every deploy-time source link, adds a real CLI startup smoke, and pins the
  exact Node image tag. The failed pre-amendment runtime workflow
  `31972629687` remains public infrastructure evidence. It reached no model
  invocation and produced no task outcome.
- Amendment 3, before any model run, bound ICAE's official golden repositories,
  authoritative tests, and hidden PRD bundle by their Zenodo URLs and SHA256
  values in `benchmark-lock.json`. The selected private task assets were
  acquired and encrypted before any API credential was installed; no model
  outcome was observed before this amendment.
- The corrected three-arm ARM64 freeze completed in workflow
  [`31974909964`](https://github.com/1052326311/dsh-plan-lattice/actions/runs/31974909964).
  Each archive passed closure identity verification before upload; their exact
  archive and metadata digests, plus the verified Darwin ARM64 host runtime,
  are locked in `runtime-artifacts.json`.

## Local validation

```sh
node --test eval/v0.4/tests/*.testcase.mjs
node eval/v0.4/validate.mjs
node eval/v0.4/generate-manifest.mjs
node eval/v0.4/checksums.mjs       # expected to reject on current main
node eval/v0.4/run.mjs --json      # expected to fail closed before any call
```

At the historical freeze, the dry run reported 96 scheduled slots and
`paidModelInvocations: 0`. On current `main`, the checksum guard exits before it
reads `DEEPSEEK_API_KEY` or starts Harness.

The repository also includes a no-cost real-runtime fixture. It builds the
pinned Harness CLI, starts an isolated credential proxy against a scripted SSE
upstream, runs the actual headless Agent path, and verifies durable Session
events and token accounting:

```sh
DEEPSEEK_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
node --test eval/v0.4/tests/real-driver.testcase.mjs
```

Passing this fixture establishes driver mechanics only. It does not score a
software task and cannot authorize a quality-uplift claim.

Verify exact local benchmark checkouts:

```sh
DEEPSEEK_HARNESS_ROOT=/absolute/path/to/deepseek-harness \
HARBOR_ROOT=/absolute/path/to/harbor \
ICAE_EVAL_ROOT=/absolute/path/to/ICAE-EVAL \
EVOCODE_BENCH_ROOT=/absolute/path/to/EvoCodeBench \
node eval/v0.4/pin-benchmarks.mjs
```

For a pre-registration audit of current upstream `HEAD` values without changing
the lock:

```sh
node eval/v0.4/pin-benchmarks.mjs --resolve-heads
```

Do not use `--write` after outcomes exist. A source relock creates a different
experiment and requires a new preregistration, manifest, and checksum set.

## Candidate freeze

`preregistration.json` binds the runtime candidate to commit `dc55716525987fcb7cb46579a9c957877cbd23c2`.
The clean evaluation-lock checkout contains the driver, adapters, tasks,
graders, manifest, and checksums and descends from that candidate. The host
Harness runtime and every arm-specific Linux runtime are content-addressed in
`runtime-artifacts.json`.

The preregistration also freezes the Ed25519 SPKI public key used to verify
result records. Its PKCS8 private key stays outside the repository and enters
only the isolated proxy/signer through the secure launcher's anonymous pipe.
The state ledger lives on independently retained append-only storage; the
signer fsyncs each accepted chain head and refuses stale or duplicate attempts
after restart.

Every controlled Linux runtime packages the plugin directly from its exact Git
commit. Its tarball carries checked arm, Harness, plugin-package,
plugin-commit, support-plugin, profile-patch, and base-image identity. The
controller re-hashes the corresponding bytes from inside the tarball; a native
tarball cannot be reused for a contract or lattice arm.

```sh
node eval/v0.4/generate-manifest.mjs --write
node eval/v0.4/validate.mjs --execution-ready
node eval/v0.4/checksums.mjs --write
node eval/v0.4/checksums.mjs
```

The manifest digest changes when the candidate commit changes. That digest is
the batch confirmation token.

## External driver contract

Paid execution uses the frozen `driver/dsh-driver.mjs` through an absolute
executable path in `PLAN_LATTICE_EVAL_DRIVER`. That path must resolve to this
repository's exact entry and its complete source-tree digest must match the
manifest. The runner invokes it with one argument: an absolute
path to a key-free `run-spec.json`. The secure launcher gives the real API key
to a separate local proxy through an anonymous pipe, then replaces itself with
a controller environment containing only one-time model, Oracle, and control
capabilities. The controller verifies the proxy PID, endpoint digest, and audit
path, then strips the control capability from every driver child. Harness,
agent shells, containers, and their inspectable parent environments never
receive the upstream key. The driver writes exactly one JSON object to stdout
following `schemas/driver-result.schema.json` and diagnostic text to stderr.

The driver is responsible for:

- checking out every source at the commit in `benchmark-lock.json`;
- extracting a content-addressed Harness runtime built from the exact pinned
  Git archive rather than using an ambient build directory;
- materializing an isolated task workspace and hiding external grader details;
- placing the run spec in a controller-only subtree and denying every host
  agent reads of that subtree and the evaluation repository;
- selecting the requested plugin arm without altering model or tool budgets;
- adapting Harness questions through a five-question ICAE relay that exposes
  neither official task IDs nor the statistics endpoint;
- stripping benchmark-root environment variables, denying the ICAE model
  process access to hidden benchmark/controller assets, and blocking direct
  connections to official Oracle ports 50001 through 50003;
- executing the pinned Harbor commit with `--resume-trajectory` for all EvoCode
  rounds and preserving case-identity historical-requirement metrics;
- retaining final workspaces and grader artifacts beneath the attempt directory;
- returning exact task and grader SHA256 values.

The controller scrubs proxy tokens and bearer text before writing streams. It
binds the sanitized raw stdout, normalized payload, per-attempt proxy request
slice, final workspace, grader artifacts, receipt, and ordered result record.
Agent-role proxy request counts must equal durable Harness model turns, and
Oracle-role requests are accepted only for ICAE. Result JSONL and the complete
`attempts/` tree must live together outside this repository. The digest chain
detects inconsistent published evidence, and every record digest is signed by
the preregistered Ed25519 key. The protocol does not provide third-party key
custody or public timestamping.

## Paid execution lock

One intentional run requires all controls below. Do not export the real key in
a long-lived parent shell; the launcher refuses when that parent environment
already exposes it.

```sh
DEEPSEEK_API_KEY="$(secret-manager read deepseek-eval)" \
DEEPSEEK_BASE_URL='https://frozen-endpoint.example/v1' \
PLAN_LATTICE_EVAL_DRIVER=/absolute/path/to/repository/eval/v0.4/driver/dsh-driver.mjs \
PLAN_LATTICE_EVAL_ALLOW_PAID=I_UNDERSTAND_THIS_RUN_USES_PAID_MODELS \
PLAN_LATTICE_RESULT_SIGNING_PRIVATE_KEY_BASE64="$(secret-manager read plan-lattice-signing-key)" \
PLAN_LATTICE_RESULT_SIGNING_LEDGER=/absolute/path/to/append-only/signing.jsonl \
./eval/v0.4/secure-run.sh \
  --run-id '<frozen-run-id>' \
  --results-dir /absolute/path/outside/the/repository
```

An intentional batch additionally requires `--execute-all` and the exact
`--confirm-manifest <digest>`. Infrastructure reruns require both
`--run-id <id>` and `--rerun-of <same-id>` and are accepted only when the prior
append-only record carries a preregistered infrastructure code.
All six infrastructure runs must complete before the controller admits the
first statistical run.

Analyze without modifying results:

```sh
node eval/v0.4/analyze.mjs \
  --results /absolute/path/results.jsonl \
  --out /absolute/path/analysis.json
```

Exit code `3` means release blocked. No script here publishes a release or posts
to DeepSeek Harness discussions. Moving `results.jsonl` without its sibling
`attempts/` tree makes artifact verification fail.
