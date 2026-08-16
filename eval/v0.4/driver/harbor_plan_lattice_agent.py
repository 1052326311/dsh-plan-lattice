"""Harbor Agent that executes an exact, prebuilt Linux DSH runtime in-task."""

import json
import os
import shlex
import re
from urllib.parse import urlparse
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PlanLatticeHarnessAgent(BaseAgent):
    SUPPORTS_RESUME = True

    @staticmethod
    def name() -> str:
        return "plan-lattice-harness"

    def __init__(self, logs_dir: Path, model_name: str | None = None, runtime_tar: str | None = None, **kwargs):
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        if not runtime_tar:
            raise ValueError("runtime_tar is required")
        self.runtime_tar = Path(runtime_tar).resolve()

    def version(self) -> str:
        return "0.4.0-rc.0"

    @staticmethod
    def _redact(text: str | None, *secrets: str | None) -> str:
        value = text or ""
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
        return value

    async def setup(self, environment: BaseEnvironment) -> None:
        remote_tar = "/logs/agent/plan-lattice-runtime.tar.gz"
        await environment.upload_file(self.runtime_tar, remote_tar)
        result = await environment.exec(
            command=(
                "test -f /installed-agent/runtime/.ready || "
                f"(tar -xzf {shlex.quote(remote_tar)} -C / && "
                "test -x /installed-agent/runtime/node && "
                "test -s /installed-agent/runtime/runtime.json && "
                "touch /installed-agent/runtime/.ready)"
            ),
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError(f"failed to install frozen DSH runtime: {result.stderr}")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        proxy_capability = self._get_env("DEEPSEEK_API_KEY")
        if not proxy_capability or not re.fullmatch(r"plan-lattice-[0-9a-f]{64}", proxy_capability):
            raise RuntimeError("credential-isolated model proxy capability is unavailable to the Harbor Agent")
        base_url = self._get_env("DEEPSEEK_BASE_URL")
        endpoint = urlparse(base_url or "")
        if endpoint.scheme != "http" or endpoint.hostname != "host.docker.internal" or not endpoint.port:
            raise RuntimeError("Harbor requires the credential-isolated Docker proxy endpoint")
        env = {
            "DEEPSEEK_API_KEY": proxy_capability,
            "DEEPSEEK_BASE_URL": base_url,
            "DSH_HOME": "/installed-agent/runtime/home",
            "DSH_PERMISSION_MODE": "workspace-write",
            "DSH_TELEMETRY_DISABLED": "1",
            "DSH_TOOLS_MODE": "native",
            "DSH_PLAN_LATTICE_EVAL_SESSION_ID": f"plan-lattice-evocode-{self.context_id}",
            "DSH_PLAN_LATTICE_SESSION_ROOT": "/installed-agent/state/sessions",
            "DSH_PLAN_LATTICE_ORACLE_AUDIT_PATH": "/installed-agent/state/questions.jsonl",
            "DSH_PLAN_LATTICE_ORACLE_POLICY": "closed-world-task-requirements",
        }
        command = (
            "/installed-agent/runtime/node /installed-agent/runtime/dsh/lib/bin.js "
            f"--profile headless {shlex.quote(instruction)}"
        )
        result = await environment.exec(command=command, env=env, timeout_sec=3600)
        context.metadata = {
            "return_code": result.return_code,
            "stdout_tail": self._redact(result.stdout, proxy_capability, base_url)[-4000:],
            "stderr_tail": self._redact(result.stderr, proxy_capability, base_url)[-4000:],
        }
        export = await environment.exec(
            command=(
                "touch /installed-agent/state/questions.jsonl && "
                "/installed-agent/runtime/node /installed-agent/runtime/session-metrics.mjs "
                "/installed-agent/state/sessions /installed-agent/state/questions.jsonl "
                '"$DSH_PLAN_LATTICE_EVAL_SESSION_ID" '
                "> /logs/agent/dsh-metrics.json && "
                "tar -czf /logs/agent/dsh-session.tar.gz -C /installed-agent/state sessions questions.jsonl"
            ),
            env=env,
        )
        if export.return_code != 0:
            raise RuntimeError(f"failed to export DSH metrics: {export.stderr}")
        if result.return_code != 0:
            detail = self._redact(result.stderr or result.stdout, proxy_capability, base_url)
            raise RuntimeError(f"DSH failed: {detail[-2000:]}")

    async def resume(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self.run(instruction, environment, context)
