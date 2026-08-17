import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const adapterPath = join(repositoryRoot, 'eval/pilots/driver/icae_adapter.py')

test('ICAE adapter reports retained agent generation failures before Oracle statistics', () => {
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("icae_adapter_under_test", ${JSON.stringify(adapterPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.retained_agent_failure({"generation": "error", "is_error": True, "detail": "agent_error"}) == "ICAE agent generation failed: agent_error"
assert module.retained_agent_failure({"generation": "error", "detail": "generation_only"}) == "ICAE agent generation failed: generation_only"
assert module.retained_agent_failure({"generation": "success", "is_error": True, "detail": "flag_only"}) == "ICAE agent generation failed: flag_only"
assert module.retained_agent_failure({"generation": "error", "detail": None}) == "ICAE agent generation failed: unspecified agent error"
assert module.retained_agent_failure({"generation": "success", "is_error": False}) is None
print("ok")
`
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /ok/)
})

test('ICAE adapter promotes structured pre-agent provisioning errors to infrastructure failures', () => {
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("icae_adapter_under_test", ${JSON.stringify(adapterPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
docker = module.pre_agent_infrastructure_failure({"generation": "error", "reason": "docker: corrupt image blob"})
assert isinstance(docker, module.InfrastructureFailure)
assert docker.code == "container_runtime_failure"
assert str(docker) == "ICAE container provisioning failed before agent execution: corrupt image blob"
prd = module.pre_agent_infrastructure_failure({"generation": "error", "reason": "prd: source task unavailable"})
assert isinstance(prd, module.InfrastructureFailure)
assert prd.code == "benchmark_service_unavailable"
assert module.pre_agent_infrastructure_failure({"generation": "success"}) is None
assert module.pre_agent_infrastructure_failure({"generation": "error", "reason": "agent_error"}) is None
print("ok")
`
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /ok/)
})

test('exploratory ICAE clarification count uses official turns_used statistics', () => {
  const script = `
import importlib.util
spec = importlib.util.spec_from_file_location("icae_adapter_under_test", ${JSON.stringify(adapterPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.clarification_question_count({"turns_used": 4}) == 4
assert module.clarification_question_count({"turns_used": 0}) == 0
for invalid in ({}, {"turns_used": -1}, {"turns_used": 1.5}, {"turns_used": "4"}, {"turns_used": True}):
    try:
        module.clarification_question_count(invalid)
    except RuntimeError as error:
        assert "turns_used" in str(error)
    else:
        raise AssertionError(f"accepted invalid official statistics: {invalid!r}")
print("ok")
`
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /ok/)
})
