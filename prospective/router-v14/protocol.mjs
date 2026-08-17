import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '../..')
export const protocolId = 'observable-authorization-v14-rc4-shared-v13-corpus'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

function exactDigest(value, context, length) {
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value ?? '')) throw new Error(`${context} is invalid`)
  return value
}

function exactConfiguration(value) {
  const expected = {
    activationMode: 'auto',
    clarificationPolicy: 'critical',
    controlCeiling: 'lattice',
    longTaskThreshold: 8,
  }
  if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(expected))) {
    throw new Error('V14 candidate configuration changed')
  }
}

export function validateSpec(spec) {
  if (spec?.schemaVersion !== 1 || spec.protocol !== protocolId) throw new Error('invalid V14 candidate spec identity')
  const freeze = spec.protocolFreeze
  if (freeze?.publicRef !== 'refs/tags/router-v14-protocol-freeze'
    || freeze.deadline !== '2026-08-18T00:15:00Z'
    || freeze.binding !== 'the complete Git tree reached by the public tag'
    || freeze.postFreezeCodeChanges !== 'retire-v14') {
    throw new Error('V14 public protocol freeze changed')
  }
  const candidate = spec.candidateFreeze
  if (candidate?.publicRef !== 'refs/tags/router-v14-rc4-candidate-freeze'
    || candidate.commit !== '7cb3c77f9dab6ef193eb77318fb87389b877b526'
    || candidate.tree !== '10970e580c45891ffd8bbfe395ac920401f65799'
    || candidate.sourceDigest !== '6ac8983227a9ca0825fd62432b5d7f2904fe4077620771e578eb14317c64af68') {
    throw new Error('V14 RC.4 candidate identity changed')
  }
  if (JSON.stringify(candidate.files) !== JSON.stringify(['src/router.ts', 'src/task-invariants.ts'])) {
    throw new Error('V14 candidate source file set changed')
  }
  exactConfiguration(candidate.configuration)
  const runtime = candidate.runtimeArtifact
  if (runtime?.source !== 'git-archive-exact-commit'
    || runtime.node !== 'v22.23.0'
    || runtime.typescript !== '5.9.3'
    || runtime.sourceSha256 !== 'ef233993d4ed46f027c1f8d7403d82dd8b1645da7144004fd57fa2dc09d2afde'
    || JSON.stringify(runtime.sourceFiles) !== JSON.stringify(candidate.files)
    || runtime.entryExport !== 'routeRequest') {
    throw new Error('V14 candidate runtime identity changed')
  }
  const corpus = spec.sharedCorpus
  if (corpus?.protocol !== 'observable-authorization-v13'
    || corpus.protocolFreezeRef !== 'refs/tags/router-v13-protocol-freeze'
    || corpus.protocolFreezeCommit !== 'ef9c321a9dfd7379f1c8a73f9293f7c5fa93803d'
    || corpus.specSha256 !== '8ea75d2db951fabd2d1c114be8f570881858527006eb16169338a8c8716e2cae'
    || corpus.sourceWindowStart !== '2026-08-17T00:00:00Z'
    || corpus.sourceWindowEnd !== '2026-08-18T00:00:00Z'
    || corpus.acquisitionNotBefore !== '2026-08-18T00:15:00Z'
    || corpus.selectionBeaconRound !== 6391766
    || corpus.selectionBeaconTime !== '2026-08-20T00:00:00Z') {
    throw new Error('V14 shared V13 corpus identity changed')
  }
  const expectedGates = {
    simpleFalseActivationRateMax: 0.05,
    complexCriticalRecallMin: 0.9,
    outcomeCriticalBypassMax: 0,
    exactAccuracyMin: 0.8,
    macroF1Min: 0.8,
    latticeRecallMin: 0.9,
    probeRecallMin: 0.85,
    probeFalsePositiveRateMax: 0.1,
    knownCounterexamplesMustPass: true,
  }
  if (JSON.stringify(canonical(spec.releaseGates)) !== JSON.stringify(canonical(expectedGates))) {
    throw new Error('V14 release gates changed')
  }
  if (!Array.isArray(spec.knownCounterexamples) || spec.knownCounterexamples.length !== 3
    || spec.knownCounterexamples.some(row => row.expected !== 'contract' || typeof row.text !== 'string')) {
    throw new Error('V14 known counterexample gate changed')
  }
  if (spec.reportingPolicy?.publishV13AndV14RegardlessOfOutcome !== true
    || spec.reportingPolicy.oneRevealPerCandidate !== true
    || spec.reportingPolicy.noPostRevealCandidateChanges !== true
    || spec.reportingPolicy.routerAccuracyIsNotSoftwareTaskUplift !== true) {
    throw new Error('V14 reporting policy changed')
  }
  return spec
}

export async function loadSpec(path = resolve(here, 'candidate-spec.json')) {
  const bytes = await readFile(path)
  return { spec: validateSpec(JSON.parse(bytes)), bytes, path }
}

function resolveCommit(ref, context) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' })
  const commit = result.status === 0 ? result.stdout.trim() : ''
  return exactDigest(commit, context, 40)
}

function resolveTree(commit, context) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8' })
  const tree = result.status === 0 ? result.stdout.trim() : ''
  return exactDigest(tree, context, 40)
}

export async function assertCandidateFreeze(spec) {
  const commit = resolveCommit(spec.candidateFreeze.publicRef, 'V14 public candidate tag')
  if (commit !== spec.candidateFreeze.commit) throw new Error('V14 candidate tag resolves to another commit')
  const tree = resolveTree(commit, 'V14 candidate tree')
  if (tree !== spec.candidateFreeze.tree) throw new Error('V14 candidate tree changed')
  const records = []
  for (const path of spec.candidateFreeze.files) {
    const result = spawnSync('git', ['-C', repositoryRoot, 'show', `${commit}:${path}`], { encoding: null, maxBuffer: 16 * 1024 * 1024 })
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error(`V14 candidate source is unavailable: ${path}`)
    records.push(`${path}\0${sha256(result.stdout)}`)
  }
  if (sha256(`${records.join('\n')}\n`) !== spec.candidateFreeze.sourceDigest) {
    throw new Error('V14 candidate source digest changed')
  }
  return { commit, tree, sourceDigest: spec.candidateFreeze.sourceDigest }
}

export function assertProtocolFreeze(spec) {
  const commit = resolveCommit(spec.protocolFreeze.publicRef, 'V14 public protocol freeze')
  const protectedPaths = ['prospective/router-v14', 'test/router-v14-protocol.test.ts', 'test/router-v14-runtime.test.ts']
  const changed = spawnSync('git', ['-C', repositoryRoot, 'diff', '--quiet', commit, '--', ...protectedPaths])
  if (changed.status !== 0) throw new Error('V14 protocol implementation changed after its public freeze')
  const untracked = spawnSync('git', ['-C', repositoryRoot, 'ls-files', '--others', '--exclude-standard', '--', ...protectedPaths], { encoding: 'utf8' })
  if (untracked.status !== 0 || untracked.stdout.trim() !== '') throw new Error('V14 protocol has untracked files after its public freeze')
  return { commit, ref: spec.protocolFreeze.publicRef }
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`immutable V14 output already exists: ${path}`)
    throw error
  }
}

export function sanitizedMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:gh[pousr]|sk)[-_][A-Za-z0-9_-]{16,}\b/gu, '<redacted>')
}
