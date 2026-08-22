import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const EVOCODE_ROUND_COUNT = 9

const CASE_RE = /^CASE_RESULT\s+case_id=(\S+)\s+origin_step=(\S+)\s+requirement_ref=(\S+)\s+case_type=(\S+)\s+status=(\S+).*?\sscenario="([A-Za-z0-9_.:-]+)"/gm
const SUMMARY_RE = /^CASE_SUMMARY\s+total_cases=(\d+)\s+success_count=(\d+)\s+fail_count=(\d+)\s*$/m

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function portablePath(path) {
  return path.split(sep).join('/')
}

async function walkFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const name = portablePath(relative(root, path))
    if (entry.isSymbolicLink()) throw new Error(`EvoCode task assets must not contain symlinks: ${name}`)
    if (entry.isDirectory()) files.push(...await walkFiles(root, path))
    else if (entry.isFile()) files.push({ path, name })
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

function parseTomlString(source, context) {
  const value = source.trim().replace(/\s+#.*$/, '')
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch {}
  }
  const literal = value.match(/^'([^']*)'$/)
  if (literal) return literal[1]
  throw new Error(`task.toml has an invalid ${context}`)
}

export function parseEvoCodeTaskToml(source) {
  if (typeof source !== 'string') throw new TypeError('task.toml source must be a string')
  const steps = []
  let inStep = false
  let inRequirementChain = false
  let declaredSteps
  let pendingName
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^\[\[?.*\]\]?$/.test(line)) {
      if (inStep) {
        if (!pendingName) throw new Error('task.toml contains a [[steps]] entry without a name')
        steps.push(pendingName)
      }
      inStep = line === '[[steps]]'
      inRequirementChain = line === '[metadata.requirement_chain]'
      pendingName = undefined
      continue
    }
    if (inStep) {
      const name = line.match(/^name\s*=\s*(.+)$/)
      if (name) {
        if (pendingName) throw new Error('task.toml contains multiple names in one [[steps]] entry')
        pendingName = parseTomlString(name[1], 'step name')
      }
    }
    if (inRequirementChain) {
      const count = line.match(/^num_steps\s*=\s*(\d+)\s*(?:#.*)?$/)
      if (count) declaredSteps = Number(count[1])
    }
  }
  if (inStep) {
    if (!pendingName) throw new Error('task.toml contains a [[steps]] entry without a name')
    steps.push(pendingName)
  }
  if (declaredSteps === undefined) throw new Error('task.toml must declare metadata.requirement_chain.num_steps')
  if (declaredSteps !== EVOCODE_ROUND_COUNT || steps.length !== EVOCODE_ROUND_COUNT) {
    throw new Error(`V28 requires exactly ${EVOCODE_ROUND_COUNT} task steps`)
  }
  const expected = Array.from({ length: EVOCODE_ROUND_COUNT }, (_, index) => `round-${index + 1}`)
  if (new Set(steps).size !== steps.length || steps.some((step, index) => step !== expected[index])) {
    throw new Error(`V28 task steps must be ordered ${expected.join(', ')}`)
  }
  return steps
}

function partitionFor(name) {
  if (name === 'task.toml' || name.startsWith('environment/') || /^steps\/[^/]+\/instruction\.md$/.test(name)) {
    return 'public'
  }
  if (/^steps\/[^/]+\/tests\//.test(name)) return 'hidden'
  if (/^steps\/[^/]+\/solution\//.test(name)) return 'oracle'
  return undefined
}

async function digestFiles(entries) {
  const files = []
  for (const entry of entries) {
    const bytes = await readFile(entry.path)
    files.push({ path: entry.name, bytes: bytes.length, sha256: sha256(bytes) })
  }
  return { sha256: sha256(JSON.stringify(files)), files }
}

export async function inspectEvoCodeTask(taskRoot) {
  const root = await realpath(resolve(taskRoot))
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error('EvoCode task root must be a directory')
  const taskToml = await readFile(join(root, 'task.toml'), 'utf8')
  const steps = parseEvoCodeTaskToml(taskToml)
  const files = await walkFiles(root)
  const partitions = { public: [], hidden: [], oracle: [] }
  for (const entry of files) {
    const partition = partitionFor(entry.name)
    if (partition) partitions[partition].push(entry)
  }

  const names = new Set(files.map((entry) => entry.name))
  for (const step of steps) {
    for (const required of [
      `steps/${step}/instruction.md`,
      `steps/${step}/tests/test.sh`,
    ]) {
      if (!names.has(required)) throw new Error(`EvoCode task is missing ${required}`)
    }
    if (!partitions.oracle.some((entry) => entry.name.startsWith(`steps/${step}/solution/`))) {
      throw new Error(`EvoCode task is missing oracle assets for ${step}`)
    }
  }
  if (!partitions.public.some((entry) => entry.name.startsWith('environment/'))) {
    throw new Error('EvoCode task is missing environment assets')
  }

  return {
    schemaVersion: 1,
    root,
    roundCount: EVOCODE_ROUND_COUNT,
    steps,
    digests: {
      public: await digestFiles(partitions.public),
      hidden: await digestFiles(partitions.hidden),
      oracle: await digestFiles(partitions.oracle),
    },
  }
}

function parseOriginStep(value) {
  if (value === 'base') return { id: 'base', round: 0 }
  const match = String(value).match(/^round-(\d+)$/)
  if (!match) throw new Error(`invalid CASE_RESULT origin_step: ${value}`)
  const round = Number(match[1])
  if (!Number.isInteger(round) || round < 1 || round > EVOCODE_ROUND_COUNT) {
    throw new Error(`invalid CASE_RESULT origin_step: ${value}`)
  }
  return { id: `round-${round}`, round }
}

function parseReward(value) {
  const reward = typeof value === 'number' ? value : Number(String(value).trim())
  if (reward !== 0 && reward !== 1) throw new Error(`official EvoCode reward must be binary, received ${value}`)
  return reward
}

export function parseOfficialVerifierOutput(text, { round, reward }) {
  if (!Number.isInteger(round) || round < 1 || round > EVOCODE_ROUND_COUNT) {
    throw new Error(`round must be between 1 and ${EVOCODE_ROUND_COUNT}`)
  }
  const cases = []
  for (const match of String(text).matchAll(CASE_RE)) {
    if (!['success', 'fail'].includes(match[5])) throw new Error(`invalid CASE_RESULT status: ${match[5]}`)
    const origin = parseOriginStep(match[2])
    if (origin.round > round) {
      throw new Error(`CASE_RESULT ${match[1]} claims future origin ${origin.id} in round ${round}`)
    }
    cases.push({
      caseId: match[1],
      originStep: origin.id,
      originRound: origin.round,
      scenario: match[6],
      identity: `${origin.id}:${match[3]}:${match[6]}`,
      requirementRef: match[3],
      caseType: match[4],
      status: match[5],
      round,
    })
  }
  const summary = String(text).match(SUMMARY_RE)
  if (!summary) throw new Error('official EvoCode verifier output has no CASE_SUMMARY')
  const successes = Number(summary[2])
  const failures = Number(summary[3])
  const total = Number(summary[1])
  if (total === 0 || total !== successes + failures || total !== cases.length) {
    throw new Error('CASE_SUMMARY does not match parsed CASE_RESULT records')
  }
  const identities = cases.map(entry => entry.identity)
  if (new Set(identities).size !== identities.length) {
    throw new Error('official EvoCode verifier emitted a duplicate stable case identity')
  }
  const parsedReward = parseReward(reward)
  const expectedReward = failures === 0 ? 1 : 0
  if (parsedReward !== expectedReward) {
    throw new Error('successful reward conflicts with verifier case results')
  }
  return {
    round,
    reached: true,
    reward: parsedReward,
    total,
    successes,
    failures,
    caseRatio: total > 0 ? successes / total : 0,
    summaryPresent: true,
    cases,
  }
}

export function summarizeOfficialRounds(rounds) {
  const byRound = new Map()
  for (const entry of rounds) {
    if (!Number.isInteger(entry?.round) || entry.round < 1 || entry.round > EVOCODE_ROUND_COUNT) {
      throw new Error(`round must be between 1 and ${EVOCODE_ROUND_COUNT}`)
    }
    if (byRound.has(entry.round)) throw new Error(`duplicate EvoCode result for round ${entry.round}`)
    byRound.set(entry.round, entry)
  }
  const padded = Array.from({ length: EVOCODE_ROUND_COUNT }, (_, index) => {
    const round = index + 1
    return byRound.get(round) ?? {
      round,
      reached: false,
      reward: 0,
      total: 0,
      successes: 0,
      failures: 0,
      caseRatio: 0,
      summaryPresent: false,
      cases: [],
    }
  })
  const previous = new Map()
  const regressions = new Set()
  for (const result of padded) {
    for (const entry of result.cases) {
      const key = entry.identity
      if (previous.get(key) === 'success' && entry.status === 'fail' && entry.originRound < result.round) {
        regressions.add(key)
      }
      previous.set(key, entry.status)
    }
  }
  const reward = padded.reduce((sum, entry) => sum + parseReward(entry.reward), 0)
  const caseRatio = padded.reduce((sum, entry) => sum + (Number(entry.caseRatio) || 0), 0)
  return {
    rounds: padded,
    reachedRounds: byRound.size,
    rewardScore: 100 * reward / EVOCODE_ROUND_COUNT,
    cumulativeCaseScore: 100 * caseRatio / EVOCODE_ROUND_COUNT,
    historicalRequirementRegressions: regressions.size,
    historicalRegressionKeys: [...regressions].sort(),
  }
}

function overlaps(left, right) {
  const fromLeft = relative(left, right)
  const fromRight = relative(right, left)
  return fromLeft === ''
    || (!fromLeft.startsWith(`..${sep}`) && fromLeft !== '..' && !isAbsolute(fromLeft))
    || (!fromRight.startsWith(`..${sep}`) && fromRight !== '..' && !isAbsolute(fromRight))
}

function mount(source, target, readOnly = false) {
  if (source.includes(',') || source.includes('\n')) throw new Error('Docker bind source contains an unsupported character')
  return `type=bind,src=${source},dst=${target}${readOnly ? ',readonly' : ''}`
}

export const PRIVATE_STDIN_GRADER = [
  'grader_source=$(cat)',
  'exec </dev/null',
  'eval "$grader_source"',
  'grader_status=$?',
  'unset grader_source',
  'exit "$grader_status"',
].join('; ')

export async function runOfficialRoundInDocker({
  taskRoot,
  workspaceRoot,
  round,
  image,
  dockerExecutable = 'docker',
  timeoutMs = 1_800_000,
  verifierTempRoot = tmpdir(),
}) {
  if (!image || typeof image !== 'string') throw new Error('a frozen Docker image is required')
  const identity = await inspectEvoCodeTask(taskRoot)
  if (!Number.isInteger(round) || round < 1 || round > EVOCODE_ROUND_COUNT) {
    throw new Error(`round must be between 1 and ${EVOCODE_ROUND_COUNT}`)
  }
  const workspace = await realpath(resolve(workspaceRoot))
  if (!(await stat(workspace)).isDirectory()) throw new Error('agent workspace must be a directory')
  if (overlaps(identity.root, workspace)) {
    throw new Error('agent workspace must be disjoint from the EvoCode task root')
  }
  await mkdir(resolve(verifierTempRoot), { recursive: true })
  const verifierParent = await realpath(resolve(verifierTempRoot))
  if (overlaps(identity.root, verifierParent) || overlaps(workspace, verifierParent)) {
    throw new Error('verifier temporary root must be disjoint from task assets and the agent workspace')
  }

  const verifierRoot = await mkdtemp(join(verifierParent, 'plan-lattice-v28-verifier-'))
  const workspaceSnapshot = join(verifierRoot, 'workspace')
  const testScript = join(identity.root, 'steps', `round-${round}`, 'tests', 'test.sh')
  await readdir(dirname(testScript))
  const testScriptBytes = await readFile(testScript)
  await cp(workspace, workspaceSnapshot, { recursive: true, force: false, errorOnExist: true })
  const args = [
    'run', '--rm', '--interactive', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--workdir', '/app',
    '--mount', mount(workspaceSnapshot, '/app'),
    '--tmpfs', '/tmp:rw,nosuid,size=512m',
    '--tmpfs', '/logs/verifier:rw,nosuid,nodev,noexec,size=1m',
    '--entrypoint', '/bin/bash', image, '-c', PRIVATE_STDIN_GRADER,
  ]
  try {
    const result = spawnSync(dockerExecutable, args, {
      encoding: 'utf8',
      input: testScriptBytes,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (result.error?.code === 'ETIMEDOUT') throw new Error(`official EvoCode verifier timed out in round ${round}`)
    if (result.error) throw result.error
    const summary = String(result.stdout).match(SUMMARY_RE)
    if (!summary) throw new Error('official EvoCode verifier output has no CASE_SUMMARY')
    const reward = Number(summary[1]) > 0 && Number(summary[3]) === 0 ? 1 : 0
    const parsed = parseOfficialVerifierOutput(result.stdout, { round, reward })
    if (result.status !== 0 || result.signal !== null) {
      throw new Error(`official EvoCode verifier exited ${String(result.status)} signal ${String(result.signal)} in round ${round}`)
    }
    return {
      ...parsed,
      process: { status: result.status, signal: result.signal, stderr: result.stderr },
    }
  } finally {
    await rm(verifierRoot, { recursive: true, force: true })
  }
}
