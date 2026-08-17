#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE=${PLAN_LATTICE_NODE:-node}
KEY=${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be supplied to the secure launcher}
UPSTREAM=${DEEPSEEK_BASE_URL:?DEEPSEEK_BASE_URL must be supplied to the secure launcher}
SIGNING_KEY=${PLAN_LATTICE_RESULT_SIGNING_PRIVATE_KEY_BASE64:?result signing private key must be supplied to the secure launcher}
SIGNING_LEDGER=${PLAN_LATTICE_RESULT_SIGNING_LEDGER:?stateful result signing ledger path must be supplied to the secure launcher}
SIGNING_LEDGER_ID=${PLAN_LATTICE_RESULT_SIGNING_LEDGER_ID:?new RC.4 signing ledger identity must be supplied to the secure launcher}
EXECUTION_ENVELOPE=${PLAN_LATTICE_EXECUTION_ENVELOPE:?publicly frozen RC.4 execution envelope path must be supplied}
case "$SIGNING_LEDGER" in
  /*) ;;
  *) echo "result signing ledger path must be absolute" >&2; exit 2 ;;
esac
case "$EXECUTION_ENVELOPE" in
  /*) ;;
  *) echo "execution envelope path must be absolute" >&2; exit 2 ;;
esac
PARENT_ENV=$(ps eww -p "$PPID" 2>/dev/null || true)
case "$PARENT_ENV" in
  *"$KEY"*|*"$SIGNING_KEY"*) echo "refusing paid execution: a private key is visible in the parent process listing; pass it only to this launcher" >&2; exit 2 ;;
esac
PARENT_ENV=
case "$KEY$UPSTREAM$SIGNING_KEY" in
  *"
"*) echo "credential and endpoint must not contain newlines" >&2; exit 2 ;;
esac

unset DEEPSEEK_API_KEY DEEPSEEK_BASE_URL PLAN_LATTICE_RESULT_SIGNING_PRIVATE_KEY_BASE64 PLAN_LATTICE_RESULT_SIGNING_LEDGER
VALIDATION=$("$NODE" "$ROOT/validate.mjs" --execution-ready --execution-envelope "$EXECUTION_ENVELOPE")
EXECUTION_ENVELOPE_DIGEST=$(printf '%s' "$VALIDATION" | "$NODE" -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (!/^[0-9a-f]{64}$/.test(value.envelopeDigest ?? "")) process.exit(2);
  process.stdout.write(value.envelopeDigest);
});
')
VALIDATION=
CONTROL=$(mktemp -d "${TMPDIR:-/tmp}/plan-lattice-proxy.XXXXXX")
INPUT=$CONTROL/input
READY=$CONTROL/ready
ERRORS=$CONTROL/errors
AUDIT=$CONTROL/model-proxy-requests.jsonl
PROXY_PID=
cleanup() {
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  rm -rf "$CONTROL"
}
trap cleanup EXIT INT TERM
mkfifo "$INPUT"
: >"$AUDIT"
chmod 600 "$AUDIT"
env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="${TMPDIR:-/tmp}" "$NODE" "$ROOT/../../eval/v0.4/driver/model-proxy.mjs" <"$INPUT" >"$READY" 2>"$ERRORS" &
PROXY_PID=$!
printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
  "$UPSTREAM" "$KEY" "$AUDIT" "$SIGNING_KEY" "$SIGNING_LEDGER" \
  "$SIGNING_LEDGER_ID" "$EXECUTION_ENVELOPE_DIGEST" >"$INPUT"
KEY=
UPSTREAM=
SIGNING_KEY=
SIGNING_LEDGER=

COUNT=0
while [ ! -s "$READY" ]; do
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then
    sed -n '1,20p' "$ERRORS" >&2 || true
    rm -rf "$CONTROL"
    exit 2
  fi
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -ge 100 ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    rm -rf "$CONTROL"
    echo "timed out starting the credential-isolated model proxy" >&2
    exit 2
  fi
  sleep 0.05
done

TAB=$(printf '\t')
IFS="$TAB" read -r STATUS HOST_URL DOCKER_URL TOKEN ORACLE_TOKEN CONTROL_TOKEN ENDPOINT_DIGEST SIGNING_PUBLIC_KEY <"$READY"
if [ "$STATUS" != READY ]; then
  kill "$PROXY_PID" 2>/dev/null || true
  echo "credential-isolated model proxy returned an invalid handshake" >&2
  exit 2
fi
rm -f "$INPUT" "$READY" "$ERRORS"

exec env \
  DEEPSEEK_API_KEY="$TOKEN" \
  DEEPSEEK_BASE_URL="$HOST_URL" \
  PLAN_LATTICE_DOCKER_MODEL_PROXY_URL="$DOCKER_URL" \
  PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN="$ORACLE_TOKEN" \
  PLAN_LATTICE_MODEL_PROXY_CONTROL_TOKEN="$CONTROL_TOKEN" \
  PLAN_LATTICE_MODEL_PROXY_AUDIT="$AUDIT" \
  PLAN_LATTICE_CREDENTIAL_PROXY_ROOT="$CONTROL" \
  PLAN_LATTICE_UPSTREAM_ENDPOINT_DIGEST="$ENDPOINT_DIGEST" \
  PLAN_LATTICE_RESULT_SIGNING_PUBLIC_KEY_BASE64="$SIGNING_PUBLIC_KEY" \
  PLAN_LATTICE_RESULT_SIGNING_LEDGER_ID="$SIGNING_LEDGER_ID" \
  PLAN_LATTICE_EXECUTION_ENVELOPE_DIGEST="$EXECUTION_ENVELOPE_DIGEST" \
  PLAN_LATTICE_CREDENTIAL_PROXY_PID="$PROXY_PID" \
  PLAN_LATTICE_CREDENTIAL_PROXY=1 \
  PLAN_LATTICE_EVAL_DRIVER="$ROOT/driver.mjs" \
  "$NODE" "$ROOT/controller.mjs" --execution-envelope "$EXECUTION_ENVELOPE" --execute "$@"
