#!/usr/bin/env node
import { access, link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCandidateFreezeManifest, runCandidateReveal } from './candidate-reveal.mjs'
import { assertCandidateFreeze, assertProtocolFreeze, here, loadSpec, sanitizedMessage, sha256 } from './protocol.mjs'
import { buildFrozenRuntimeArtifact } from './runtime-artifact.mjs'
import { loadSharedCorpus } from './shared-corpus.mjs'

const dataRoot = resolve(process.env.PLAN_LATTICE_V14_DATA_DIR ?? here)
const v13DataRoot = process.env.PLAN_LATTICE_V13_DATA_DIR
const v13SourceRoot = resolve(here, '../../eval/router-corpus/v13')
const files = Object.freeze({
  runtime: 'runtime-artifact',
  freezeManifest: 'candidate-freeze-manifest.json',
  freezeDigest: 'candidate-freeze-manifest.sha256',
  attempt: 'candidate-reveal-attempt.json',
  result: 'candidate-reveal-result.json',
  failure: 'candidate-reveal-failure.json',
})
const pathFor = name => resolve(dataRoot, files[name])

async function publishFiles(outputs) {
  await mkdir(dataRoot, { recursive: true })
  for (const name of Object.keys(outputs)) {
    if (await access(resolve(dataRoot, name)).then(() => true, () => false)) {
      throw new Error(`immutable V14 output already exists: ${resolve(dataRoot, name)}`)
    }
  }
  const staging = await mkdtemp(resolve(dataRoot, '.v14-staging-'))
  const published = []
  try {
    for (const [name, body] of Object.entries(outputs)) {
      const path = resolve(staging, name)
      await writeFile(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    }
    for (const name of Object.keys(outputs)) {
      const target = resolve(dataRoot, name)
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

async function runtimeStage() {
  const { spec } = await loadSpec()
  await assertCandidateFreeze(spec)
  return buildFrozenRuntimeArtifact(pathFor('runtime'))
}

async function statusStage() {
  const { spec } = await loadSpec()
  const candidate = await assertCandidateFreeze(spec)
  const present = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [
    name,
    await access(resolve(dataRoot, file)).then(() => true, () => false),
  ])))
  return { candidate, dataRoot, v13DataRoot: v13DataRoot ?? null, present }
}

async function freezeStage() {
  const { spec } = await loadSpec()
  await assertCandidateFreeze(spec)
  const protocol = assertProtocolFreeze(spec)
  const shared = await loadSharedCorpus({ root: v13DataRoot, sourceRoot: v13SourceRoot, spec, requireUnrevealed: true })
  const runtimeManifest = JSON.parse(await readFile(resolve(pathFor('runtime'), 'manifest.json'), 'utf8'))
  const manifest = createCandidateFreezeManifest({ spec, protocolFreezeCommit: protocol.commit, shared, runtimeManifest })
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  await publishFiles({
    [files.freezeManifest]: body,
    [files.freezeDigest]: `${sha256(body)}  ${files.freezeManifest}\n`,
  })
  return manifest
}

async function revealStage() {
  const { spec } = await loadSpec()
  await assertCandidateFreeze(spec)
  const protocol = assertProtocolFreeze(spec)
  const shared = await loadSharedCorpus({ root: v13DataRoot, sourceRoot: v13SourceRoot, spec, requireRevealed: true })
  const runtimeManifest = JSON.parse(await readFile(resolve(pathFor('runtime'), 'manifest.json'), 'utf8'))
  const manifestText = await readFile(pathFor('freezeManifest'), 'utf8')
  const expectedManifestDigest = (await readFile(pathFor('freezeDigest'), 'utf8')).trim().split(/\s+/u)[0]
  return runCandidateReveal({
    manifestText,
    expectedManifestDigest,
    protocolFreezeCommit: protocol.commit,
    shared,
    spec,
    runtimeManifest,
    runtimeArtifactRoot: pathFor('runtime'),
    attemptPath: pathFor('attempt'),
    resultPath: pathFor('result'),
    failurePath: pathFor('failure'),
  })
}

const stages = { status: statusStage, runtime: runtimeStage, freeze: freezeStage, reveal: revealStage }

export async function runStage(name) {
  if (!Object.hasOwn(stages, name)) throw new Error(`unknown V14 stage ${JSON.stringify(name)}; choose ${Object.keys(stages).join(', ')}`)
  return stages[name]()
}

async function main() {
  const stage = process.argv[2]
  try {
    console.log(JSON.stringify({ stage, status: 'complete', result: await runStage(stage) }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      schemaVersion: 1,
      protocol: 'observable-authorization-v14-rc4-shared-v13-corpus',
      stage: stage ?? 'workflow-dispatch',
      status: 'failed-closed',
      message: sanitizedMessage(error),
    }, null, 2))
    process.exitCode = 2
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
