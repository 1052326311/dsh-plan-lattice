#!/usr/bin/env node
import { access, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireArchives } from './acquire-archives.mjs'
import {
  agreementDigests,
  annotatorNames,
  buildV12AgreementReport,
  createAnnotationCandidates,
  createV12AdjudicationPacket,
  createV12AnnotationPackets,
  resolveV12Adjudication,
  restoreV12AnnotationSets,
} from './annotation-pipeline.mjs'
import { prepareBlindSelectionCapacity, selectBlindCorpus } from './blind-selection.mjs'
import { collectSourceFrame } from './collect-source-frame.mjs'
import {
  createFreezeManifest,
  requiredFreezeArtifacts,
  runOneReveal,
} from './freeze-reveal.mjs'
import {
  assertProtocolFreeze,
  canonical,
  here,
  loadSpec,
  sanitizedFailure,
  sha256,
  stableLines,
} from './protocol.mjs'
import { buildFrozenRuntimeArtifact } from './runtime-artifact.mjs'

const dataRoot = resolve(process.env.PLAN_LATTICE_V12_DATA_DIR ?? here)
const pathFor = name => resolve(dataRoot, name)
const shortAnnotator = name => name.slice('annotator-'.length)

const files = Object.freeze({
  archiveManifest: 'archive-manifest.json',
  sourceFrame: 'source-frame.jsonl',
  sourceManifest: 'source-frame.manifest.json',
  sourceRejections: 'source-frame.rejections.json',
  annotationCandidates: 'annotation-candidates.jsonl',
  annotationPacketManifest: 'annotation-packet-manifest.json',
  annotationMappings: 'annotation-mappings.json',
  agreementReport: 'agreement-report.json',
  adjudicationPacket: 'adjudication-packet.jsonl',
  adjudicationDecisions: 'adjudication-decisions.jsonl',
  adjudicated: 'adjudicated.jsonl',
  capacityManifest: 'capacity-manifest.json',
  capacityWitness: 'capacity-witness.json',
  drandResponseRaw: 'drand-response.raw.json',
  drandChainInfoRaw: 'drand-chain-info.raw.json',
  drandExternalVerification: 'drand-external-verification.json',
  drandVerifierPublicKey: 'drand-verifier-public-key.pem',
  beaconResponse: 'beacon-response.json',
  selectionManifest: 'selection-manifest.json',
  selectionWitness: 'selection-witness.json',
  prompts: 'prompts.jsonl',
  labels: 'labels.jsonl',
  sources: 'sources.jsonl',
  runtimeArtifact: 'runtime-artifact',
  freezeManifest: 'freeze-manifest.json',
  freezeManifestDigest: 'freeze-manifest.sha256',
  revealAttempt: 'reveal-attempt.json',
  revealResult: 'reveal-result.json',
  revealFailure: 'reveal-failure.json',
})

function annotationPacketFile(name) {
  return `annotation-packet-${shortAnnotator(name)}.jsonl`
}

function annotationFile(name) {
  return `annotations-${shortAnnotator(name)}.jsonl`
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function readJson(name) {
  const body = await readFile(pathFor(name), 'utf8')
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readJsonLines(name, { allowEmpty = false } = {}) {
  const body = await readFile(pathFor(name), 'utf8')
  const lines = body.trim().split('\n').filter(Boolean)
  if (!allowEmpty && lines.length === 0) throw new Error(`${name} must not be empty`)
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${name}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

async function publishFiles(outputs) {
  await mkdir(dataRoot, { recursive: true })
  const entries = Object.entries(outputs)
  for (const [name] of entries) {
    const target = pathFor(name)
    if (await access(target).then(() => true, () => false)) throw new Error(`immutable V12 output already exists: ${target}`)
  }
  const staging = await mkdtemp(resolve(dataRoot, '.v12-workflow-staging-'))
  const published = []
  try {
    for (const [name, body] of entries) {
      const staged = resolve(staging, name)
      await mkdir(dirname(staged), { recursive: true })
      await writeFile(staged, body, { encoding: typeof body === 'string' ? 'utf8' : undefined, flag: 'wx', mode: 0o600 })
    }
    for (const [name] of entries) {
      const target = pathFor(name)
      await mkdir(dirname(target), { recursive: true })
      await link(resolve(staging, name), target)
      published.push(target)
    }
  } catch (error) {
    for (const target of published.reverse()) await unlink(target).catch(() => {})
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function loadAnnotationState(spec, { withReport = false } = {}) {
  const candidates = await readJsonLines(files.annotationCandidates)
  const mappings = await readJson(files.annotationMappings)
  const annotations = Object.fromEntries(await Promise.all(annotatorNames.map(async name => [
    name,
    await readJsonLines(annotationFile(name)),
  ])))
  const annotationSets = restoreV12AnnotationSets({ candidates, mappings, annotations })
  return {
    candidates,
    mappings,
    annotations,
    annotationSets,
    ...(withReport ? { agreementReport: await readJson(files.agreementReport) } : {}),
    spec,
  }
}

async function loadResolvedState(spec) {
  const state = await loadAnnotationState(spec, { withReport: true })
  const [frame, adjudicationPacket, adjudicationDecisions, adjudicated] = await Promise.all([
    readJsonLines(files.sourceFrame),
    readJsonLines(files.adjudicationPacket, { allowEmpty: true }),
    readJsonLines(files.adjudicationDecisions, { allowEmpty: true }),
    readJsonLines(files.adjudicated),
  ])
  return { ...state, frame, adjudicationPacket, adjudicationDecisions, adjudicated }
}

async function acquireStage() {
  const { spec } = await loadSpec()
  return acquireArchives({
    cacheRoot: process.env[spec.archive.archiveCacheEnvironmentVariable],
    outputPath: pathFor(files.archiveManifest),
  })
}

async function collectStage() {
  const { spec } = await loadSpec()
  return collectSourceFrame({
    outputDirectory: dataRoot,
    archiveManifestPath: pathFor(files.archiveManifest),
    cacheRoot: process.env[spec.archive.archiveCacheEnvironmentVariable],
  })
}

async function packetsStage() {
  const frame = await readJsonLines(files.sourceFrame)
  const candidates = createAnnotationCandidates(frame)
  const generated = createV12AnnotationPackets(candidates)
  await publishFiles({
    [files.annotationCandidates]: stableLines(candidates),
    [files.annotationPacketManifest]: jsonText(generated.manifest),
    [files.annotationMappings]: jsonText(generated.mappings),
    ...Object.fromEntries(annotatorNames.map(name => [annotationPacketFile(name), stableLines(generated.packets[name])])),
  })
  return generated.manifest
}

async function agreementStage() {
  const { spec } = await loadSpec()
  const state = await loadAnnotationState(spec)
  const report = buildV12AgreementReport(
    state.candidates,
    state.annotationSets,
    agreementDigests(state.candidates, state.annotationSets),
    spec.reliabilityGates,
  )
  await publishFiles({ [files.agreementReport]: jsonText(report) })
  return report
}

async function adjudicationStage() {
  const { spec } = await loadSpec()
  const state = await loadAnnotationState(spec, { withReport: true })
  const packet = createV12AdjudicationPacket({
    candidates: state.candidates,
    annotationSets: state.annotationSets,
    agreementReport: state.agreementReport,
    gates: spec.reliabilityGates,
  })
  await publishFiles({ [files.adjudicationPacket]: stableLines(packet) })
  return { disagreements: packet.length }
}

async function capacityStage() {
  const { spec } = await loadSpec()
  const state = await loadAnnotationState(spec, { withReport: true })
  const [frame, adjudicationPacket, adjudicationDecisions] = await Promise.all([
    readJsonLines(files.sourceFrame),
    readJsonLines(files.adjudicationPacket, { allowEmpty: true }),
    readJsonLines(files.adjudicationDecisions, { allowEmpty: true }),
  ])
  const adjudicated = resolveV12Adjudication({
    candidates: state.candidates,
    annotationSets: state.annotationSets,
    packet: adjudicationPacket,
    decisions: adjudicationDecisions,
  })
  const prepared = prepareBlindSelectionCapacity({
    ...state,
    frame,
    adjudicationPacket,
    adjudicationDecisions,
    adjudicated,
  })
  await publishFiles({
    [files.adjudicated]: stableLines(adjudicated),
    [files.capacityManifest]: jsonText(prepared.capacityManifest),
    [files.capacityWitness]: jsonText(prepared.capacityManifest.capacityWitness),
  })
  return prepared.capacityManifest
}

async function selectionStage() {
  const { spec } = await loadSpec()
  const state = await loadResolvedState(spec)
  const [archiveManifest, frozenCapacity, frozenWitness] = await Promise.all([
    readJson(files.archiveManifest),
    readJson(files.capacityManifest),
    readJson(files.capacityWitness),
  ])
  const result = await selectBlindCorpus({
    ...state,
    archiveMerkleRoot: archiveManifest.archiveMerkleRoot,
    loadBeacon: async () => ({
      responseBytes: await readFile(pathFor(files.drandResponseRaw)),
      chainInfoBytes: await readFile(pathFor(files.drandChainInfoRaw)),
      externalVerification: await readJson(files.drandExternalVerification),
    }),
    trustedVerifierPublicKey: await readFile(pathFor(files.drandVerifierPublicKey), 'utf8'),
  })
  if (JSON.stringify(canonical(result.capacityManifest)) !== JSON.stringify(canonical(frozenCapacity))
    || JSON.stringify(canonical(result.capacityManifest.capacityWitness)) !== JSON.stringify(canonical(frozenWitness))) {
    throw new Error('V12 selection capacity differs from the previously frozen exact-capacity evidence')
  }
  await publishFiles({
    [files.beaconResponse]: jsonText(result.beacon),
    [files.selectionManifest]: jsonText(result.selectionManifest),
    [files.selectionWitness]: jsonText(result.selectionWitness),
    [files.prompts]: stableLines(result.prompts),
    [files.labels]: stableLines(result.labels),
    [files.sources]: stableLines(result.sources),
  })
  return result.selectionManifest
}

async function runtimeStage() {
  return buildFrozenRuntimeArtifact(pathFor(files.runtimeArtifact))
}

async function freezeArtifacts() {
  const { bytes: specBytes } = await loadSpec()
  const artifactFiles = {
    spec: specBytes,
    archiveManifest: files.archiveManifest,
    sourceManifest: files.sourceManifest,
    sourceFrame: files.sourceFrame,
    sourceRejections: files.sourceRejections,
    annotationRubric: resolve(here, 'ANNOTATION_RUBRIC.md'),
    annotationSchema: resolve(here, '../v10/annotation-schema.mjs'),
    annotationCandidates: files.annotationCandidates,
    annotationPacketManifest: files.annotationPacketManifest,
    annotationPacketA: annotationPacketFile('annotator-a'),
    annotationPacketB: annotationPacketFile('annotator-b'),
    annotationPacketC: annotationPacketFile('annotator-c'),
    annotationMappings: files.annotationMappings,
    annotationsA: annotationFile('annotator-a'),
    annotationsB: annotationFile('annotator-b'),
    annotationsC: annotationFile('annotator-c'),
    agreementReport: files.agreementReport,
    adjudicationPacket: files.adjudicationPacket,
    adjudicationDecisions: files.adjudicationDecisions,
    adjudicated: files.adjudicated,
    capacityManifest: files.capacityManifest,
    capacityWitness: files.capacityWitness,
    drandResponseRaw: files.drandResponseRaw,
    drandChainInfoRaw: files.drandChainInfoRaw,
    drandExternalVerification: files.drandExternalVerification,
    drandVerifierPublicKey: files.drandVerifierPublicKey,
    beaconResponse: files.beaconResponse,
    selectionManifest: files.selectionManifest,
    selectionWitness: files.selectionWitness,
    prompts: files.prompts,
    labels: files.labels,
    sources: files.sources,
    runtimeManifest: resolve(dataRoot, files.runtimeArtifact, 'manifest.json'),
    statisticsSource: resolve(here, 'statistics.mjs'),
  }
  const entries = await Promise.all(Object.entries(artifactFiles).map(async ([name, value]) => {
    if (name === 'spec') return [name, value]
    const path = resolve(String(value).startsWith('/') ? String(value) : pathFor(String(value)))
    return [name, await readFile(path)]
  }))
  const artifacts = Object.fromEntries(entries)
  for (const name of requiredFreezeArtifacts) {
    if (!Object.hasOwn(artifacts, name)) throw new Error(`workflow does not bind required freeze artifact ${name}`)
  }
  return artifacts
}

async function freezeStage() {
  const { spec } = await loadSpec()
  const protocolFreeze = assertProtocolFreeze(spec)
  const artifacts = await freezeArtifacts()
  const manifest = createFreezeManifest({
    spec,
    protocolFreezeCommit: protocolFreeze.commit,
    artifacts,
  })
  const body = jsonText(manifest)
  await publishFiles({
    [files.freezeManifest]: body,
    [files.freezeManifestDigest]: `${sha256(body)}  ${files.freezeManifest}\n`,
  })
  return manifest
}

async function revealStage() {
  const { spec } = await loadSpec()
  const protocolFreeze = assertProtocolFreeze(spec)
  const artifacts = await freezeArtifacts()
  const manifestText = await readFile(pathFor(files.freezeManifest), 'utf8')
  const digestLine = await readFile(pathFor(files.freezeManifestDigest), 'utf8')
  const expectedManifestDigest = digestLine.trim().split(/\s+/u)[0]
  return runOneReveal({
    manifestText,
    expectedManifestDigest,
    expectedProtocolFreezeCommit: protocolFreeze.commit,
    artifacts,
    spec,
    runtimeArtifactRoot: pathFor(files.runtimeArtifact),
    attemptPath: pathFor(files.revealAttempt),
    resultPath: pathFor(files.revealResult),
    failurePath: pathFor(files.revealFailure),
  })
}

const stages = Object.freeze({
  acquire: acquireStage,
  collect: collectStage,
  packets: packetsStage,
  agreement: agreementStage,
  adjudication: adjudicationStage,
  capacity: capacityStage,
  selection: selectionStage,
  runtime: runtimeStage,
  freeze: freezeStage,
  reveal: revealStage,
})

export async function runStage(name) {
  const stage = stages[name]
  if (stage === undefined) throw new Error(`unknown V12 workflow stage ${JSON.stringify(name)}; choose ${Object.keys(stages).join(', ')}`)
  return stage()
}

async function main() {
  const stage = process.argv[2]
  try {
    const result = await runStage(stage)
    console.log(jsonText({ stage, status: 'complete', result }).trim())
  } catch (error) {
    console.error(jsonText(sanitizedFailure(error, { stage: stage ?? 'workflow-dispatch' })).trim())
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
