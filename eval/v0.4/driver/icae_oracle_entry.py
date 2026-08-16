#!/usr/bin/env python3
"""Launch the pinned ICAE Oracle with environment-only model credentials."""

import asyncio
import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: icae_oracle_entry.py <icae-root> <state-root>")
    icae_root = Path(sys.argv[1]).resolve()
    state_root = Path(sys.argv[2]).resolve()
    sys.path.insert(0, str(icae_root))

    api_key = os.environ.get("PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN")
    if not api_key:
        raise SystemExit("credential-isolated Oracle proxy token is required")
    base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

    from user_agent import user_agent as oracle_core

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

    from user_agent import main as oracle_main

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
