import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractIcaeContainerId, resolveHarnessPermissionMode } from '../../pilots/driver/lib/runtime.mjs'
import { icaeShellAdapter, parseIcaeDockerExec, validateIcaeWorkspaceMount } from '../../pilots/driver/candidate-wrapper/shell-adapter.js'
import { assertIcaeToolBoundary, createIcaeToolBoundary, hiddenIcaeExecutionTools } from '../../pilots/driver/candidate-wrapper/tool-boundary.js'

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

test('ICAE shell identity ignores display metadata but preserves the exact command', () => {
  const command = `docker exec -w /workspace ${'a'.repeat(64)} bash -lc 'npm test'`
  assert.deepEqual(
    icaeShellAdapter.normalizeArguments({ command, description: 'Run tests', run_in_background: false }),
    { command },
  )
  assert.notDeepEqual(
    icaeShellAdapter.normalizeArguments({ command: `${command} `, description: 'Run tests' }),
    { command },
  )
  assert.throws(() => icaeShellAdapter.normalizeArguments({ description: 'Missing command' }), /non-empty text/)
})

test('ICAE shell verification rejects execution metadata omitted from semantic identity', async () => {
  const id = 'a'.repeat(64)
  const command = `docker exec -w /workspace ${id} bash -lc 'npm test'`
  const previous = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
  process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID = id
  try {
    for (const extra of [
      { workdir: '/workspace' },
      { run_in_background: true },
      { timeoutMs: 10_000 },
    ]) {
      await assert.rejects(
        icaeShellAdapter.snapshot({
          workspace: process.cwd(),
          resource: `container:${id}`,
          arguments: { command, description: 'Run tests', ...extra },
        }),
        /does not allow execution metadata/,
      )
      assert.match(
        icaeShellAdapter.verify({
          workspace: process.cwd(),
          resource: `container:${id}`,
          arguments: { command, description: 'Run tests', ...extra },
          expectedStateDigest: 'not-observed',
        }),
        /does not allow execution metadata/,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
    else process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID = previous
  }
})

test('ICAE candidate exposes only the guarded Bash execution channel', async () => {
  for (const name of [
    'write',
    'edit',
    'str_replace_editor',
    'pwsh',
    'run_code',
    'terminal_open',
    'subagent',
    'subagent_fork',
    'subagent_codex',
    'workflow',
    'ralph',
    'send_message',
    'list_agents',
    'interrupt_agent',
    'web_search',
    'web_fetch',
    'job_output',
    'job_kill',
    'schedule_create',
  ]) {
    assert.throws(() => assertIcaeToolBoundary({ name }), /blocks out-of-bound tool/)
  }
  assert.doesNotThrow(() => assertIcaeToolBoundary({ name: 'bash' }))
  assert.doesNotThrow(() => assertIcaeToolBoundary({ name: 'read' }))
  assert.deepEqual(
    hiddenIcaeExecutionTools([
      'read', 'write', 'bash', 'edit', 'write', 'terminal_send', 'subagent', 'subagent_fork',
      'workflow', 'ralph', 'send_message', 'list_agents', 'interrupt_agent', 'web_search',
      'job_list', 'schedule_create',
    ]),
    [
      'edit', 'interrupt_agent', 'job_list', 'list_agents', 'ralph', 'schedule_create',
      'send_message', 'subagent', 'subagent_fork', 'terminal_send', 'web_search', 'workflow',
      'write',
    ],
  )
})

test('ICAE candidate permits one Oracle intake batch per owning agent', () => {
  const assertBoundary = createIcaeToolBoundary()
  const root = { id: 'root' }
  assert.doesNotThrow(() => assertBoundary({ name: 'lattice_intake', agent: root }))
  assert.throws(
    () => assertBoundary({ name: 'lattice_intake', agent: root }),
    /one Oracle intake batch/,
  )
  assert.doesNotThrow(() => assertBoundary({ name: 'lattice_intake', agent: { id: 'other' } }))
  assert.doesNotThrow(() => assertBoundary({ name: 'lattice_commit_intake', agent: root }))
  assert.throws(() => assertBoundary({ name: 'lattice_intake' }), /owning agent/)
})

test('ICAE candidate removes host mutation tools before prompt assembly', async () => {
  const wrapperSource = await readFile(join(repositoryRoot, 'eval/pilots/driver/candidate-wrapper/index.js'), 'utf8')
  assert.match(wrapperSource, /agent\.ctx\.tools\.restrict\(\{ deny \}\)/)
  assert.match(wrapperSource, /agent\/inbox\/inserted/)
  assert.match(wrapperSource, /agent\/disposed/)
  assert.match(wrapperSource, /restrictions\.get\(key\)\?\.\(\)/)
  assert.match(wrapperSource, /failed to hide direct or delegated execution tools/)
  assert.match(wrapperSource, /exactly one valid lattice_intake call/)
  assert.match(wrapperSource, /one short, independently answerable, outcome-critical contract fact/)
  assert.match(wrapperSource, /If intake returns HTTP 400, HTTP 429, or any other error, do not retry/)
  assert.match(wrapperSource, /Never contact the Oracle through Bash, web search, direct HTTP, delegation, workflows, or background agents/)
  assert.match(wrapperSource, /the next control call must be lattice_commit_intake/)
  assert.match(wrapperSource, /Do not set workdir, run_in_background, or timeoutMs/)
  assert.match(wrapperSource, /Never issue lattice_refresh_context and Bash in the same parallel tool batch/)
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
  assert.match(icaeSource, /class InfrastructureFailure\(RuntimeError\)/)
  assert.match(icaeSource, /pre_agent_infrastructure_failure\(repo\)/)
  assert.ok(icaeSource.indexOf('pre_agent_infrastructure_failure(repo)') < icaeSource.indexOf('ICAE ledger slot executed the agent'))
  assert.ok(icaeSource.indexOf('isinstance(error, InfrastructureFailure)') < icaeSource.indexOf('elif EXECUTION_STARTED'))
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
