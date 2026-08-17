import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveHarnessPermissionMode } from '../../pilots/driver/lib/runtime.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('exploratory ICAE permission mode is safe by default and rejects unknown values', () => {
  assert.equal(resolveHarnessPermissionMode(), 'workspace-write')
  assert.equal(resolveHarnessPermissionMode('danger-full-access'), 'danger-full-access')
  assert.equal(resolveHarnessPermissionMode('read-only'), 'read-only')
  assert.throws(() => resolveHarnessPermissionMode('unconfined'), /unsupported Harness permission mode/)
})

test('exploratory ICAE driver passes its explicit inner permission mode end to end', async () => {
  const runtimeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/lib/runtime.mjs'), 'utf8')
  const bridgeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/bridge.mjs'), 'utf8')
  const icaeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/icae_adapter.py'), 'utf8')
  assert.match(runtimeSource, /permissionMode = 'workspace-write'/)
  assert.match(runtimeSource, /DSH_PERMISSION_MODE: resolvedPermissionMode/)
  assert.match(bridgeSource, /permissionMode: request\.permissionMode/)
  assert.match(icaeSource, /"permissionMode": spec\.get\("model", \{\}\)\.get\("permissionMode", "workspace-write"\)/)
  assert.match(icaeSource, /PLAN_LATTICE_ICAE_CONTROLLER_CAPABILITY/)
  assert.match(icaeSource, /headers\["authorization"\] = f"Bearer \{capability\}"/)
  assert.match(icaeSource, /50003,[\s\S]*?controller_capability/)
  assert.match(icaeSource, /\*spec\.get\("additionalForbiddenReadRoots", \[\]\)/)
  assert.ok(icaeSource.indexOf('agent_failure = retained_agent_failure(repo)') < icaeSource.indexOf('objective = repo.get("objective", {})'))
  assert.ok(icaeSource.indexOf('agent_failure = retained_agent_failure(repo)') < icaeSource.indexOf('stats_response = post_json('))
})

test('exploratory ICAE pilot can execute an isolated retained-baseline arm', async () => {
  const pilotSource = await readFile(join(repositoryRoot, 'eval/pilots/rc7-icae-critical-pilot.mjs'), 'utf8')
  const profileSource = await readFile(join(repositoryRoot, 'eval/v0.4/driver/lib/profile.mjs'), 'utf8')
  assert.match(pilotSource, /PLAN_LATTICE_PILOT_ARMS/)
  assert.match(pilotSource, /PLAN_LATTICE_PILOT_HOST_RUNTIME_SHA256/)
  assert.match(pilotSource, /for \(const arm of selectedArms\)/)
  assert.match(pilotSource, /strictBash: false/)
  assert.match(profileSource, /'strictBash'/)
  assert.match(pilotSource, /allSelectedCompleted/)
})
