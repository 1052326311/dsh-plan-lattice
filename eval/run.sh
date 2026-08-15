#!/usr/bin/env bash
set -euo pipefail

if [[ -z ${DEEPSEEK_API_KEY:-} ]]; then
  printf 'DEEPSEEK_API_KEY must be supplied through the environment.\n' >&2
  exit 2
fi

project_root=$(cd "$(dirname "$0")/.." && pwd)
harness_root=${DEEPSEEK_HARNESS_ROOT:-"$(cd "$project_root/../deepseek-harness" && pwd)"}
runs=${PLAN_LATTICE_EVAL_RUNS:-3}
arms=${PLAN_LATTICE_EVAL_ARMS:-"native-sparse native-full lattice-guided"}
run_root=$(mktemp -d "${TMPDIR:-/tmp}/dsh-plan-lattice-eval.XXXXXX")

printf 'run_root=%s\n' "$run_root"

for repetition in $(seq 1 "$runs"); do
  for arm in $arms; do
    workspace="$run_root/$arm-$repetition/workspace"
    home="$run_root/$arm-$repetition/home"
    mkdir -p "$workspace" "$home"
    cp -R "$project_root/eval/fixtures/release-planner/." "$workspace/"
    case "$arm" in
      native-sparse)
        task_file="$project_root/eval/tasks/sparse.txt"
        ;;
      native-full)
        task_file="$project_root/eval/tasks/full.txt"
        ;;
      lattice-guided)
        task_file="$project_root/eval/tasks/sparse.txt"
        ;;
      *)
        printf 'unknown evaluation arm: %s\n' "$arm" >&2
        exit 2
        ;;
    esac
    patch="$run_root/$arm-$repetition/patch.json"
    node "$project_root/eval/render-patch.mjs" "$patch" "$project_root" "$arm"
    task=$(<"$task_file")
    (
      cd "$workspace"
      DSH_HOME="$home" node "$harness_root/apps/cli/lib/bin.js" \
        --profile headless --patch "$patch" "$task" \
        >"$run_root/$arm-$repetition/model.txt" 2>"$run_root/$arm-$repetition/model.stderr.txt"
    ) || true
    node "$project_root/eval/grade.mjs" "$workspace" >"$run_root/$arm-$repetition/score.json"
    score=$(node -e "const fs=require('fs'); console.log(JSON.parse(fs.readFileSync(process.argv[1])).score)" \
      "$run_root/$arm-$repetition/score.json")
    printf '%s run %s: %s\n' "$arm" "$repetition" "$score"
  done
done

node - "$run_root" <<'NODE'
const fs = require('fs')
const path = require('path')
const root = process.argv[2]
const rows = fs.readdirSync(root).filter(name => fs.existsSync(path.join(root, name, 'score.json'))).map(name => {
  const arm = name.replace(/-\d+$/, '')
  const run = Number(name.match(/(\d+)$/)?.[1])
  const score = JSON.parse(fs.readFileSync(path.join(root, name, 'score.json'))).score
  return { arm, run, score }
})
const arms = [...new Set(rows.map(row => row.arm))]
const summary = arms.map(arm => {
  const scores = rows.filter(row => row.arm === arm).map(row => row.score)
  return { arm, samples: scores.length, scores, mean: scores.reduce((a, b) => a + b, 0) / scores.length }
})
fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify({ rows, summary }, null, 2)}\n`)
console.log(JSON.stringify(summary, null, 2))
NODE
