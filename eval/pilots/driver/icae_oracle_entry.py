#!/usr/bin/env python3
"""Launch the pinned ICAE Oracle with environment-only model credentials."""

import asyncio
import importlib.util
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse


class CapabilityDeniedResponse:
    status_code = 401
    body = b'{"status":{"ok":false,"error":"controller capability required"}}'

    async def __call__(self, _scope, _receive, send):
        await send({
            "type": "http.response.start",
            "status": self.status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(self.body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": self.body})


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: icae_oracle_entry.py <icae-root> <state-root>")
    icae_root = Path(sys.argv[1]).resolve()
    state_root = Path(sys.argv[2]).resolve()
    user_agent_root = icae_root / "user_agent"
    sys.path.insert(0, str(user_agent_root))

    api_key = os.environ.get("PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN")
    if not api_key or not re.fullmatch(r"plan-lattice-oracle-[0-9a-f]{64}", api_key):
        raise SystemExit("credential-isolated Oracle proxy token is required")
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "")
    endpoint = urlparse(base_url)
    if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or not endpoint.port:
        raise SystemExit("credential-isolated Oracle host proxy endpoint is required")
    controller_capability = os.environ.pop("PLAN_LATTICE_ICAE_CONTROLLER_CAPABILITY", "")
    if not re.fullmatch(r"plan-lattice-icae-controller-[0-9a-f]{64}", controller_capability):
        raise SystemExit("ICAE controller capability is required")

    import user_agent as oracle_core

    oracle_core._load_user_models = lambda: {
        "Plan-Lattice-Eval-Oracle": [
            {
                "api_type": "openai",
                "model_name": "deepseek-v4-flash",
                "base_url": base_url,
                "api_key": api_key,
            }
        ]
    }

    main_spec = importlib.util.spec_from_file_location(
        "plan_lattice_icae_oracle_main",
        user_agent_root / "main.py",
    )
    if main_spec is None or main_spec.loader is None:
        raise RuntimeError("unable to load the pinned ICAE Oracle entrypoint")
    oracle_main = importlib.util.module_from_spec(main_spec)
    main_spec.loader.exec_module(oracle_main)

    upstream_config = oracle_main.uvicorn.Config
    def confined_config(app, *args, **kwargs):
        # Both arms retain the official clarification endpoint. Initialization
        # and hidden statistics remain host-only even when agent Bash enters the
        # benchmark container through Docker.
        kwargs["host"] = "0.0.0.0" if app is oracle_main.chat_app else "127.0.0.1"
        return upstream_config(app, *args, **kwargs)
    oracle_main.uvicorn.Config = confined_config

    async def require_controller_capability(request, call_next):
        if request.headers.get("authorization") != f"Bearer {controller_capability}":
            return CapabilityDeniedResponse()
        return await call_next(request)
    oracle_main.init_app.middleware("http")(require_controller_capability)
    oracle_main.stats_app.middleware("http")(require_controller_capability)

    oracle_main.LOG_DIR = state_root / "logs"
    oracle_main.STATE_DIR = state_root / "state"
    oracle_main.STATE_FILE = oracle_main.STATE_DIR / "append_ids.json"
    oracle_main.SESSION_DIR = oracle_main.STATE_DIR / "sessions"
    for path in (oracle_main.LOG_DIR, oracle_main.STATE_DIR, oracle_main.SESSION_DIR):
        path.mkdir(parents=True, exist_ok=True)
    oracle_main.valid_append_ids = {}
    oracle_main.sessions = {}
    asyncio.run(oracle_main.main())


if __name__ == "__main__":
    main()
