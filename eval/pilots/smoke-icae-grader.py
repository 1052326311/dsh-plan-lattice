#!/usr/bin/env python3
"""Run all three authoritative ICAE tiers without making a model call."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--icae-root", type=Path, required=True)
    args = parser.parse_args()
    root = args.icae_root.resolve()
    sys.path.insert(0, str(root))

    from harness import config as C  # pylint: disable=import-outside-toplevel
    from harness.docker_env import anon_tag_for, ensure_image  # pylint: disable=import-outside-toplevel
    from harness.evaluate import evaluate_repo  # pylint: disable=import-outside-toplevel

    alias = "realcode@301"
    key = C.key_for_alias(alias)
    append_id = f"plan-lattice-grader-smoke-{uuid.uuid4().hex[:12]}"
    generated = C.code_path(append_id, alias)
    source = C.GOLDEN_REPOS_DIR / key
    tar_path = C.lang_tar_path("TypeScript")
    if not source.is_dir():
        raise RuntimeError(f"ICAE golden source is missing: {source}")

    try:
        shutil.copytree(source, generated)
        harness = generated / "rcb_tests"
        harness.mkdir(parents=True, exist_ok=True)
        (harness / "test.sh").write_text(
            "#!/usr/bin/env bash\nset -euo pipefail\n"
            "cases=public_test_cases\n"
            "if [ \"${1:-}\" = --cases-dir ]; then cases=${2:?}; fi\n"
            "mkdir -p \"rcb_tests/stdout/$cases\"\n",
            encoding="utf8",
        )
        (harness / "test.sh").chmod(0o755)
        image = ensure_image(
            tar_path,
            anon_tag=anon_tag_for(alias, tar_path),
            hide_real_tag=False,
        )
        result = evaluate_repo(append_id, alias, image, timeout=300)
        summary = {
            name: {
                "passed": result[name]["passed"],
                "total": result[name]["total"],
            }
            for name in ("public_visible", "hidden", "enhanced")
        }
        if any(item["total"] <= 0 for item in summary.values()):
            raise RuntimeError(f"an authoritative grader tier did not execute: {summary}")
        print(json.dumps({"ok": True, "alias": alias, "tiers": summary}, sort_keys=True))
        return 0
    finally:
        shutil.rmtree(C.RESULTS / append_id, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
