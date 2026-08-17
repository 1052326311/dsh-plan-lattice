import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractIcaeContainerId, resolveHarnessPermissionMode } from '../../pilots/driver/lib/runtime.mjs'
import { parseIcaeDockerExec, validateIcaeWorkspaceMount } from '../../pilots/driver/candidate-wrapper/shell-adapter.js'
import { assertIcaeToolBoundary, hiddenIcaeHostTools } from '../../pilots/driver/candidate-wrapper/tool-boundary.js'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

test('exploratory ICAE permission mode is safe by default and rejects unknown values', () => {
  assert.equal(resolveHarnessPermissionMode(), 'workspace-write')
  assert.equal(resolveHarnessPermissionMode('danger-full-access'), 'danger-full-access')
  assert.equal(resolveHarnessPermissionMode('read-only'), 'read-only')
  assert.throws(() => resolveHarnessPermissionMode('unconfined'), /unsupported Harness permission mode/)
})

test('ICAE container identity and strict docker-exec command are structurally bound', () => {
  const id = 'a'.repeat(64)
  assert.equal(extractIcaeContainerId(`container ID is \`${id}\`\nRunning container: \`${id}\``), id)
  assert.throws(() => extractIcaeContainerId('no full container id'), /exactly one/)
  assert.equal(
    parseIcaeDockerExec(`docker exec -w /workspace ${id} bash -lc 'npm test && printf ok > result.txt'`, id).containerId,
    id,
  )
  assert.throws(
    () => parseIcaeDockerExec(`docker exec -w /workspace ${id} bash -lc 'npm test'; rm host.txt`, id),
    /operators|single docker exec/,
  )
  assert.throws(
    () => parseIcaeDockerExec(`docker exec -w /tmp ${id} bash -lc 'npm test'`, id),
    /\/workspace/,
  )
  assert.throws(
    () => parseIcaeDockerExec(`docker exec -w /workspace ${'b'.repeat(64)} bash -lc 'npm test'`, id),
    /frozen ICAE container/,
  )
})

test('ICAE candidate has only one host mutation channel', async () => {
  for (const name of ['write', 'edit', 'str_replace_editor', 'pwsh', 'run_code', 'terminal_open']) {
    assert.throws(() => assertIcaeToolBoundary({ name }), /blocks host-side tool/)
  }
  assert.doesNotThrow(() => assertIcaeToolBoundary({ name: 'bash' }))
  assert.doesNotThrow(() => assertIcaeToolBoundary({ name: 'read' }))
  assert.deepEqual(
    hiddenIcaeHostTools(['read', 'write', 'bash', 'edit', 'write', 'terminal_send']),
    ['edit', 'terminal_send', 'write'],
  )
})

test('ICAE candidate removes host mutation tools before prompt assembly', async () => {
  const wrapperSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/candidate-wrapper/index.js'), 'utf8')
  assert.match(wrapperSource, /agent\.ctx\.tools\.restrict\(\{ deny \}\)/)
  assert.match(wrapperSource, /agent\/inbox\/inserted/)
  assert.match(wrapperSource, /agent\/disposed/)
  assert.match(wrapperSource, /restrictions\.get\(key\)\?\.\(\)/)
  assert.match(wrapperSource, /failed to hide host mutation tools/)
})

test('ICAE candidate requires one writable bind mount for the exact workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'plan-lattice-icae-mount-'))
  try {
    const mount = { Destination: '/workspace', Source: workspace, Type: 'bind', RW: true }
    assert.equal(validateIcaeWorkspaceMount({ Mounts: [mount] }, workspace).mount, mount)
    assert.throws(
      () => validateIcaeWorkspaceMount({ Mounts: [mount, { ...mount }] }, workspace),
      /exactly one/,
    )
    assert.throws(
      () => validateIcaeWorkspaceMount({ Mounts: [{ ...mount, Type: 'volume' }] }, workspace),
      /writable bind mount/,
    )
    assert.throws(
      () => validateIcaeWorkspaceMount({ Mounts: [{ ...mount, RW: false }] }, workspace),
      /writable bind mount/,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('exploratory ICAE driver passes its explicit inner permission mode end to end', async () => {
  const runtimeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/lib/runtime.mjs'), 'utf8')
  const bridgeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/bridge.mjs'), 'utf8')
  const icaeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/icae_adapter.py'), 'utf8')
  assert.match(runtimeSource, /permissionMode = 'workspace-write'/)
  assert.match(runtimeSource, /PLAN_LATTICE_ICAE_DOCKER_HOST/)
  assert.match(runtimeSource, /DOCKER_HOST: process\.env\.PLAN_LATTICE_ICAE_DOCKER_HOST/)
  assert.match(runtimeSource, /DSH_PERMISSION_MODE: resolvedPermissionMode/)
  assert.match(bridgeSource, /permissionMode: request\.permissionMode/)
  assert.match(icaeSource, /"permissionMode": spec\.get\("model", \{\}\)\.get\("permissionMode", "workspace-write"\)/)
  assert.match(icaeSource, /PLAN_LATTICE_ICAE_CONTROLLER_CAPABILITY/)
  assert.match(icaeSource, /headers\["authorization"\] = f"Bearer \{capability\}"/)
  assert.match(icaeSource, /Oracle status\.remaining/)
  assert.match(icaeSource, /invalid Oracle status\.remaining/)
  assert.match(icaeSource, /"no space left on device" in detail and "dsh\/node_modules" in detail/)
  assert.ok(icaeSource.indexOf('"no space left on device" in detail') < icaeSource.indexOf('elif EXECUTION_STARTED'))
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
  assert.match(pilotSource, /dockerHostSha256: sha256\(dockerHost\)/)
  assert.match(pilotSource, /name=rcb_realcode_301_/)
  assert.match(pilotSource, /assertNoLeakedTaskContainer\(\)/)
  assert.match(pilotSource, /for \(const arm of selectedArms\)/)
  assert.match(pilotSource, /strictBash: true/)
  assert.match(pilotSource, /shellAdapter: 'icae-container'/)
  assert.doesNotMatch(profileSource, /'strictBash'/)
  const runtimeSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/lib/runtime.mjs'), 'utf8')
  assert.match(runtimeSource, /materializeCandidateWrapper/)
  assert.match(runtimeSource, /arm\.shellAdapter === 'icae-container'/)
  assert.match(runtimeSource, /verifyInstalledCandidate/)
  assert.match(runtimeSource, /candidatePackageSha256/)
  assert.match(pilotSource, /allSelectedCompleted/)
})
