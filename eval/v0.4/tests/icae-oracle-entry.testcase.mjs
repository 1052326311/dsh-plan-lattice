import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('ICAE Oracle loads the sibling user_agent.py despite the same-named directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-icae-oracle-import-'))
  const icaeRoot = join(root, 'icae')
  const userAgentRoot = join(icaeRoot, 'user_agent')
  const stateRoot = join(root, 'state')
  await mkdir(userAgentRoot, { recursive: true })
  await writeFile(join(userAgentRoot, 'user_agent.py'), `
class UserAgentSession:
    pass

def get_prd_dir():
    return None

def _load_user_models():
    raise AssertionError("wrapper did not install model configuration")
`, 'utf8')
  await writeFile(join(userAgentRoot, 'main.py'), `
from pathlib import Path
from user_agent import UserAgentSession, get_prd_dir
import user_agent

init_app = object()
chat_app = object()
stats_app = object()

class FakeUvicorn:
    calls = []
    @staticmethod
    def Config(app, *args, **kwargs):
        FakeUvicorn.calls.append((app, kwargs.get("host")))
        return object()

uvicorn = FakeUvicorn()

LOG_DIR = Path("logs")
STATE_DIR = Path("state")
STATE_FILE = STATE_DIR / "append_ids.json"
SESSION_DIR = STATE_DIR / "sessions"
valid_append_ids = {"stale": True}
sessions = {"stale": True}

async def main():
    models = user_agent._load_user_models()
    assert models["Plan-Lattice-Eval-Oracle"][0]["model_name"] == "deepseek-v4-flash"
    assert valid_append_ids == {}
    assert sessions == {}
    uvicorn.Config(init_app, host="0.0.0.0", port=50001)
    uvicorn.Config(chat_app, host="0.0.0.0", port=50002)
    uvicorn.Config(stats_app, host="0.0.0.0", port=50003)
    assert FakeUvicorn.calls == [
        (init_app, "127.0.0.1"),
        (chat_app, "0.0.0.0"),
        (stats_app, "127.0.0.1"),
    ]
`, 'utf8')

  try {
    const result = spawnSync('python3', [
      join(repositoryRoot, 'eval/pilots/driver/icae_oracle_entry.py'),
      icaeRoot,
      stateRoot,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAN_LATTICE_ORACLE_MODEL_PROXY_TOKEN: `plan-lattice-oracle-${'a'.repeat(64)}`,
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:43210',
      },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
