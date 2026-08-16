#!/usr/bin/env python3
"""Run one pinned ICAE task while preserving its official setup and graders."""

import asyncio
import hashlib
import http.server
import json
import os
import re
import shutil
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

MODEL_TURNS_OBSERVED = 0
EXECUTION_STARTED = False


def redact(text: str) -> str:
    for name in ("DEEPSEEK_API_KEY", "PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN"):
        secret = os.environ.get(name, "")
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return re.sub(r"(authorization\s*:\s*bearer\s+)[^\s\"']+", r"\1[REDACTED]", text, flags=re.I)


def wait_port(port: int, process: subprocess.Popen, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Oracle exited before port {port} became ready")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"Oracle port {port} did not become ready")


def post_json(port: int, payload: dict) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def objective_score(objective: dict) -> tuple[float, float]:
    suites = [objective.get("hidden", {}), objective.get("enhanced", {})]
    passed = sum(int(suite.get("passed") or 0) for suite in suites)
    total = sum(int(suite.get("total") or 0) for suite in suites)
    return (100.0 * passed / total if total else 0.0, 100.0)


class QuestionRelay:
    def __init__(self, append_id: str, task_id: str, audit_path: Path, maximum_questions: int = 5):
        self.append_id = append_id
        self.task_id = task_id
        self.maximum_questions = maximum_questions
        self.token = secrets.token_urlsafe(32)
        self.audit_path = audit_path
        self.question_count = 0
        self.lock = threading.Lock()
        relay = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - required by BaseHTTPRequestHandler
                try:
                    if self.headers.get("authorization") != f"Bearer {relay.token}":
                        self.send_response(401)
                        self.end_headers()
                        return
                    length = int(self.headers.get("content-length", "0"))
                    if length < 1 or length > 65536:
                        raise ValueError("invalid question request size")
                    payload = json.loads(self.rfile.read(length))
                    question = payload.get("question")
                    if not isinstance(question, str) or not question.strip():
                        raise ValueError("question must be non-empty text")
                    with relay.lock:
                        if relay.question_count >= relay.maximum_questions:
                            self.send_response(429)
                            self.end_headers()
                            return
                        relay.question_count += 1
                        sequence = relay.question_count
                    relay.audit_path.parent.mkdir(parents=True, exist_ok=True)
                    with relay.audit_path.open("a", encoding="utf8") as audit:
                        audit.write(json.dumps({
                            "sequence": sequence,
                            "questionDigest": hashlib.sha256(question.encode()).hexdigest(),
                        }) + "\n")
                    response = post_json(50002, {
                        "append_id": relay.append_id,
                        "task_id": relay.task_id,
                        "question": question,
                    })
                    body = json.dumps(response).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as error:  # noqa: BLE001 - relay exposes no hidden detail
                    body = json.dumps({"status": {"ok": False, "error": type(error).__name__}}).encode()
                    self.send_response(400)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, _format, *_args):
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/"


async def run(spec_path: Path) -> dict:
    global EXECUTION_STARTED
    spec = json.loads(spec_path.read_text())
    icae_root = Path(spec["benchmarkRoots"]["icae"]).resolve()
    driver_root = Path(__file__).resolve().parent
    attempt_dir = Path(spec["attemptDir"]).resolve()
    private_root = Path(tempfile.mkdtemp(prefix="plan-lattice-icae-controller-"))
    results_root = attempt_dir / "icae-results"
    oracle_state = private_root / "icae-oracle"
    relay_audit = private_root / "relay-questions.jsonl"
    sys.path.insert(0, str(icae_root))

    from harness import config as C
    from harness import orchestrator as orchestrator
    from harness.agent_runner import AgentResult

    C.RESULTS = results_root
    C.SETTINGS_FILE = results_root / "settings.json"
    C.resolve_model = lambda _name: [{}]
    C.resolve_critic_model = lambda _name: (_ for _ in ()).throw(KeyError("critic disabled by frozen protocol"))

    oracle_log_raw_path = private_root / "icae-oracle.stderr.raw.log"
    oracle_log_path = attempt_dir / "icae-oracle.stderr.log"
    oracle_log = oracle_log_raw_path.open("w", encoding="utf8")
    oracle_process = subprocess.Popen(
        [sys.executable, str(driver_root / "icae_oracle_entry.py"), str(icae_root), str(oracle_state)],
        stdout=oracle_log,
        stderr=subprocess.STDOUT,
        env=os.environ.copy(),
        text=True,
    )
    bridge_metrics: dict = {}
    append_id_holder = {"value": None}
    runner_calls = {"value": 0}

    async def dsh_runner(prompt, cwd, log_path, _model_entry, max_turns=200, timeout=7200):
        global MODEL_TURNS_OBSERVED
        runner_calls["value"] += 1
        if runner_calls["value"] != 1:
            raise RuntimeError("ICAE attempted more than one agent invocation in a ledger slot")
        alias = Path(cwd).name
        append_id = append_id_holder["value"]
        if not append_id:
            raise RuntimeError("Oracle append ID was not established before the agent run")
        request_path = private_root / f"icae-bridge-{alias}.json"
        request = {
            "specPath": str(spec_path),
            "attemptDir": str(attempt_dir / f"icae-dsh-{alias}"),
            "workspace": str(Path(cwd).resolve()),
            "prompt": prompt,
            "arm": spec["run"]["arm"],
            "sessionId": f"plan-lattice-icae-{spec['run']['runId']}",
            "timeoutMs": min(int(float(timeout) * 1000), int(spec["model"]["timeoutMs"])),
            "forbiddenReadRoots": [str(icae_root), str(private_root), str(spec_path.parent)],
            "forbiddenNetworkPorts": [50001, 50002, 50003],
        }
        with QuestionRelay(append_id, alias, relay_audit) as relay:
            request["oracle"] = {"url": relay.url, "token": relay.token}
            request_path.write_text(json.dumps(request), encoding="utf8")
            process = await asyncio.create_subprocess_exec(
                process_exec(), str(driver_root / "bridge.mjs"), str(request_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=os.environ.copy(),
            )
            stdout, stderr = await process.communicate()
            bridge_metrics["clarificationQuestions"] = relay.question_count
        if process.returncode != 0:
            return AgentResult(status="error", is_error=True, detail=stderr.decode(errors="replace")[-2000:])
        payload = json.loads(stdout)
        bridge_metrics.update(payload["metrics"])
        MODEL_TURNS_OBSERVED = max(MODEL_TURNS_OBSERVED, int(payload["metrics"].get("modelTurns", 0)))
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(payload.get("stdout", "") + "\n" + payload.get("stderr", ""), encoding="utf8")
        if payload["status"] != 0:
            return AgentResult(
                status="error",
                is_error=True,
                detail="model_timeout" if payload.get("timedOut") else "agent_error",
                num_turns=payload["metrics"]["modelTurns"],
                input_tokens=payload["metrics"]["inputTokens"],
                output_tokens=payload["metrics"]["outputTokens"],
            )
        return AgentResult(
            status="success",
            num_turns=payload["metrics"]["modelTurns"],
            input_tokens=payload["metrics"]["inputTokens"],
            output_tokens=payload["metrics"]["outputTokens"],
        )

    def process_exec() -> str:
        return os.environ.get("PLAN_LATTICE_NODE", sys.executable.replace("python3", "node").replace("python", "node"))

    orchestrator._select_runner = lambda _framework: dsh_runner
    orchestrator.RATELIMIT_BACKOFF = []
    try:
        for port in (50001, 50002, 50003):
            wait_port(port, oracle_process)
        parser = orchestrator.build_parser()
        args = parser.parse_args([
            "run",
            "--model-name", "plan-lattice-eval",
            "--user-model-name", "DeepSeek-V3.2",
            "--query-count", "5",
            "--repos", spec["run"]["taskLocator"]["repositoryKey"],
            "--concurrency", "1",
            "--max-turns", "200",
            "--timeout", str(spec["model"]["timeoutMs"] / 1000),
        ])
        args.user_model_name = "Plan-Lattice-Eval-Oracle"

        original_mint = orchestrator.ua.mint_or_resume_append_id
        def capture_mint(*mint_args, **mint_kwargs):
            value = original_mint(*mint_args, **mint_kwargs)
            append_id_holder["value"] = value[0]
            return value
        orchestrator.ua.mint_or_resume_append_id = capture_mint
        EXECUTION_STARTED = True
        await orchestrator.run_async(args)
        if runner_calls["value"] != 1:
            raise RuntimeError(f"ICAE ledger slot executed the agent {runner_calls['value']} times")
        append_id = append_id_holder["value"]
        alias = C.resolve_alias(spec["run"]["taskLocator"]["repositoryKey"])
        settings = json.loads((results_root / append_id / "settings.json").read_text())
        repo = settings["repos"][alias]
        objective = repo.get("objective", {})
        if any("error" in objective.get(name, {}) for name in ("hidden", "enhanced")):
            raise RuntimeError("ICAE objective grader did not complete")
        score, max_score = objective_score(objective)
        stats_response = post_json(50003, {"append_id": append_id, "task_id": alias})
        if not stats_response.get("status", {}).get("ok"):
            raise RuntimeError("ICAE Oracle statistics service did not complete")
        stats = stats_response.get("stats")
        if not isinstance(stats, dict) or not isinstance(stats.get("missed_constraints"), list):
            raise RuntimeError("ICAE Oracle statistics omitted missed_constraints")
        (attempt_dir / "icae-objective.json").write_text(json.dumps(objective, sort_keys=True), encoding="utf8")
        (attempt_dir / "icae-stats.json").write_text(json.dumps(stats, sort_keys=True), encoding="utf8")
        return {
            "metrics": {
                "score": score,
                "maxScore": max_score,
                "hiddenFeatureScore": score,
                "criticalRequirementsMissed": len(stats.get("missed_constraints", [])),
                "modelTurns": bridge_metrics.get("modelTurns", 0),
                "inputTokens": bridge_metrics.get("inputTokens", 0),
                "outputTokens": bridge_metrics.get("outputTokens", 0),
                "durationMs": bridge_metrics.get("durationMs", 0),
                "clarificationQuestions": bridge_metrics.get("clarificationQuestions", 0),
            },
            "objective": objective,
            "alias": alias,
        }
    finally:
        oracle_process.terminate()
        try:
            oracle_process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            oracle_process.kill()
        oracle_log.close()
        if oracle_log_raw_path.exists():
            oracle_log_path.write_text(redact(oracle_log_raw_path.read_text(errors="replace")), encoding="utf8")
        if relay_audit.exists():
            shutil.copy2(relay_audit, attempt_dir / "icae-relay-questions.jsonl")
        shutil.rmtree(private_root, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: icae_adapter.py <run-spec.json>")
    try:
        print(json.dumps(asyncio.run(run(Path(sys.argv[1]).resolve()))))
    except Exception as error:  # noqa: BLE001 - classify and retain every failed attempt
        detail = str(error).lower()
        if EXECUTION_STARTED:
            code = None
        elif "oracle" in detail or "5000" in detail:
            code = "oracle_service_unavailable"
        elif any(token in detail for token in ("docker", "container", "image")):
            code = "container_runtime_failure"
        elif any(token in detail for token in ("objective grader", "grader did not complete", "service unavailable")):
            code = "benchmark_service_unavailable"
        else:
            code = None
        print(json.dumps({
            "failure": {
                "classification": "infrastructure" if code else "task",
                "code": code or "benchmark_or_agent_error",
                "message": redact(str(error)),
            }
        }))
