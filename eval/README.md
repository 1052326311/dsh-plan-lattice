# Real-model evaluation

This evaluation measures two different claims instead of collapsing them into
one marketing number:

1. **Elicitation:** does guided Plan Lattice recover requirements that a sparse
   task omitted?
2. **Control:** after the same requirements are available, does the durable
   contract improve implementation accuracy over a long tool run?

## Fixed arms

Each arm starts from a fresh copy of `fixtures/release-planner` and uses the
same DeepSeek Harness checkout, model defaults, API endpoint, scripted human
answers, and external grader. The runner uses Harness's built CLI entrypoint,
matching the published package boundary rather than its TypeScript source entry.

| Arm | Initial task | Plan Lattice |
|---|---|---|
| `native-sparse` | Sparse | No |
| `native-full` | Sparse task plus the complete binding clarification | No |
| `lattice-guided` | Sparse | Adaptive intake; the scripted human selects guided mode |

Run three repetitions per arm before quoting an average. Do not discard failed
or low-scoring runs. `native-full` separates the value of elicitation from the
value of retaining and enforcing already-known information.

## Score

`grade.mjs` owns the rubric before any model run:

- 60 points: six observable success and failure scenarios;
- 20 points: exact deterministic output contract;
- 10 points: stable validation/policy exit-code split;
- 10 points: input immutability and dependency boundary.

The grader is outside the model workspace. The fixture and grader are public
for reproducibility, but a run copies only the fixture into the agent's working
directory.

An improvement claim reports every arm score, mean, and sample count. A 50%
claim is made only when the pre-registered mean actually clears that threshold;
otherwise the measured result is reported without changing the rubric.

## v0.3.0 smoke result

The first valid post-fix smoke used DeepSeek Harness `47f943859b` and one run per
arm. All three arms scored 100/100:

| Arm | Samples | Scores | Mean |
|---|---:|---:|---:|
| `native-sparse` | 1 | 100 | 100 |
| `native-full` | 1 | 100 | 100 |
| `lattice-guided` | 1 | 100 | 100 |

The guided arm completed all 7 graph nodes, made 39 lattice calls with zero
lattice errors, generated 57 passing project tests, and passed every external
grader check. This supports compatibility and non-regression only. It does not
support an uplift claim: one run is too small, and this fixture did not separate
already-correct implementations. A future dynamic-fact benchmark must be
specified before running it and must retain failed and low-scoring samples.

## Running

Build the plugin, export `DEEPSEEK_API_KEY` through a local secret manager or
shell, then run:

```sh
pnpm build
DEEPSEEK_API_KEY=... bash eval/run.sh
```

The script writes disposable workspaces and model stdout under a temporary run
directory. It never copies the credential into an artifact or command-line
argument. To rerun selected arms while diagnosing infrastructure, set a
space-separated `PLAN_LATTICE_EVAL_ARMS`, for example:

```sh
PLAN_LATTICE_EVAL_RUNS=1 \
PLAN_LATTICE_EVAL_ARMS="lattice-guided" \
bash eval/run.sh
```
