import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const here = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(here, '../../..')
export const protocolId = 'observable-authorization-v13'
export const predecessorCutoff = '2026-08-15T23:59:59Z'
export const routes = ['bypass', 'contract', 'lattice', 'probe']
export const languages = ['en', 'zh']

export class ProtocolFailure extends Error {
  constructor(failureClass, message, details = {}) {
    super(message)
    this.name = 'ProtocolFailure'
    this.failureClass = failureClass
    this.stage = details.stage ?? 'unknown'
    this.operation = details.operation
    this.details = details.details
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function stableLines(values) {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

export function validateSpec(spec) {
  if (spec?.schemaVersion !== 1 || spec.protocol !== protocolId) throw new Error('invalid V13 source-frame spec identity')
  if (spec.predecessor?.cutoff !== predecessorCutoff) throw new Error('V13 predecessor cutoff changed')
  if (spec.protocolFreeze?.publicRef !== 'refs/tags/router-v13-protocol-freeze'
    || spec.protocolFreeze.deadline !== '2026-08-17T00:00:00Z'
    || spec.protocolFreeze.binding !== 'the complete Git tree reached by the public tag'
    || spec.protocolFreeze.postFreezeCodeChanges !== 'retire-v13') {
    throw new Error('V13 public protocol freeze changed')
  }
  if (!/^[a-f0-9]{40}$/u.test(spec.routerFreeze?.commit ?? '')) throw new Error('V13 router commit is not exact')
  if (!/^[a-f0-9]{64}$/u.test(spec.routerFreeze?.sourceDigest ?? '')) throw new Error('V13 router source digest is invalid')
  if (JSON.stringify(spec.routerFreeze.files) !== JSON.stringify(['src/router.ts', 'src/task-invariants.ts'])) {
    throw new Error('V13 router file set changed')
  }
  const runtime = spec.routerFreeze.runtimeArtifact
  if (runtime?.source !== 'git-archive-exact-commit'
    || runtime.node !== 'v22.23.0'
    || runtime.typescript !== '5.9.3'
    || JSON.stringify(runtime.sourceFiles) !== JSON.stringify(['src/router.ts', 'src/task-invariants.ts'])
    || runtime.entryExport !== 'routeRequest') {
    throw new Error('V13 frozen runtime identity changed')
  }
  if (spec.archive?.provider !== 'GH Archive' || spec.archive.baseUrl !== 'https://data.gharchive.org') throw new Error('V13 archive provider changed')
  if (!Array.isArray(spec.archive.hours) || spec.archive.hours.length !== 24 || new Set(spec.archive.hours).size !== 24) throw new Error('V13 requires 24 unique frozen hours')
  if (!Array.isArray(spec.archive.formationHours) || spec.archive.formationHours.length !== 12
    || !Array.isArray(spec.archive.followupHours) || spec.archive.followupHours.length !== 12) throw new Error('V13 formation/follow-up partition changed')
  if (JSON.stringify([...spec.archive.formationHours, ...spec.archive.followupHours]) !== JSON.stringify(spec.archive.hours)) throw new Error('V13 archive partition does not cover the frozen hours in order')
  const cutoff = Date.parse(predecessorCutoff)
  for (const [index, hour] of spec.archive.hours.entries()) {
    if (!/^2026-08-17-(?:[0-9]|1[0-9]|2[0-3])$/u.test(hour) || Number(hour.split('-').at(-1)) !== index) throw new Error(`invalid V13 archive hour ${hour}`)
    if (hourBounds(hour).startMs <= cutoff) throw new Error(`V13 archive hour is not post-cutoff: ${hour}`)
  }
  if (spec.archive.prospectiveWindowStart !== '2026-08-17T00:00:00Z' || spec.archive.prospectiveWindowEnd !== '2026-08-18T00:00:00Z') throw new Error('V13 prospective window changed')
  if (!Array.isArray(spec.archive.requiredHeaders) || spec.archive.requiredHeaders.length < 5) throw new Error('V13 archive metadata binding is incomplete')
  if (spec.archive.requiredIndependentDownloads !== 2) throw new Error('V13 requires two independent archive downloads')
  if (spec.selectionBeacon?.access !== 'forbidden-before-annotation-reliability-and-exact-capacity-pass') throw new Error('V13 beacon access policy changed')
  if (spec.selectionBeacon.chainHash !== '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce'
    || spec.selectionBeacon.round !== 6391766
    || spec.selectionBeacon.roundTime !== '2026-08-20T00:00:00Z') throw new Error('V13 future selection beacon changed')
  if (JSON.stringify(spec.constructors?.precedence) !== JSON.stringify(['continuity', 'decision', 'program', 'repository-contingent', 'bounded', 'natural'])) throw new Error('V13 constructor precedence changed')
  const target = spec.blindSelection?.targetPerLanguage
  if (routes.some(route => !Number.isInteger(target?.[route]) || target[route] <= 0)) throw new Error('V13 blind route targets are invalid')
  if (routes.reduce((sum, route) => sum + target[route], 0) !== 60) throw new Error('V13 must select 60 rows per language')
  const releaseGates = spec.releaseGates
  const expectedGates = {
    simpleFalseActivationRateMax: 0.05,
    complexCriticalRecallMin: 0.9,
    outcomeCriticalBypassMax: 0,
    exactAccuracyMin: 0.8,
    macroF1Min: 0.8,
    latticeRecallMin: 0.9,
    probeRecallMin: 0.85,
    probeFalsePositiveRateMax: 0.1,
  }
  if (JSON.stringify(canonical(releaseGates)) !== JSON.stringify(canonical(expectedGates))) {
    throw new Error('V13 release gates changed')
  }
  return spec
}

export async function loadSpec(path = resolve(here, 'source-frame-spec.json')) {
  const bytes = await readFile(path)
  return { spec: validateSpec(JSON.parse(bytes)), bytes, path }
}

export function hourBounds(hour) {
  const match = hour.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{1,2})$/u)
  if (match === null) throw new Error(`invalid GH Archive hour ${hour}`)
  const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]))
  return { startMs, endMs: startMs + 60 * 60 * 1000 }
}

export async function assertRouterFreeze(spec) {
  const records = []
  for (const path of spec.routerFreeze.files) {
    const result = spawnSync('git', ['-C', repositoryRoot, 'show', `${spec.routerFreeze.commit}:${path}`], {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new Error(`V13 router source is unavailable at the frozen commit: ${path}`)
    }
    const bytes = result.stdout
    records.push(`${path}\0${sha256(bytes)}`)
  }
  const digest = sha256(`${records.join('\n')}\n`)
  if (digest !== spec.routerFreeze.sourceDigest) throw new Error('V13 router source differs from the frozen runtime')
  return digest
}

export function assertProtocolFreeze(spec) {
  const ref = spec.protocolFreeze.publicRef
  const resolved = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' })
  const commit = resolved.status === 0 ? resolved.stdout.trim() : ''
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error(`V13 public protocol freeze is unavailable: ${ref}`)
  const changed = spawnSync('git', [
    '-C', repositoryRoot, 'diff', '--quiet', commit, '--',
    'eval/router-corpus/v13',
    'test/router-v13-control.test.ts',
    'test/router-v13-protocol.test.ts',
    'test/router-v13-runtime.test.ts',
    'test/router-v13-source.test.ts',
    'test/router-v13-selection.test.ts',
    'test/router-v13-isolation.test.ts',
    'test/router-v13-workflow.test.ts',
  ])
  if (changed.status !== 0) throw new Error('V13 protocol implementation changed after the public freeze')
  const untracked = spawnSync('git', [
    '-C', repositoryRoot, 'ls-files', '--others', '--exclude-standard', '--',
    'eval/router-corpus/v13', 'test/router-v13-*.test.ts',
  ], { encoding: 'utf8' })
  if (untracked.status !== 0 || untracked.stdout.trim() !== '') {
    throw new Error('V13 protocol has untracked files after the public freeze')
  }
  const tree = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8' })
  if (tree.status !== 0 || !/^[a-f0-9]{40}$/u.test(tree.stdout.trim())) throw new Error('V13 protocol freeze tree is unavailable')
  return { commit, tree: tree.stdout.trim(), ref }
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ProtocolFailure('output-reuse', `immutable V13 output already exists: ${path}`, { stage: 'artifact-write', operation: path })
    throw error
  }
}

export function sanitizedFailure(error, context = {}) {
  const failure = error instanceof ProtocolFailure ? error : new ProtocolFailure('unexpected-source-stage-error', error?.message ?? String(error), { stage: context.stage ?? 'unknown' })
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'retired-before-selection-seed-access',
    selectionSeedAccessed: false,
    stage: failure.stage,
    failureClass: failure.failureClass,
    message: String(failure.message).replace(/gh[pousr]_[A-Za-z0-9_]+/gu, '<redacted>'),
    ...(failure.operation === undefined ? {} : { operation: failure.operation }),
    ...(failure.details === undefined ? {} : { details: failure.details }),
    ...context,
  }
}
