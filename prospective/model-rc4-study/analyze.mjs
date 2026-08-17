#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { analyzeEvaluation } from '../../eval/v0.4/lib/analysis.mjs'
import { verifyAttemptReceipts } from '../../eval/v0.4/lib/attempt-integrity.mjs'
import { canonicalJson } from '../../eval/v0.4/lib/canonical.mjs'
import { readJsonLines } from '../../eval/v0.4/lib/results.mjs'
import { validateManifest, validatePreregistration } from '../../eval/v0.4/lib/validation.mjs'
import { buildRc4RunManifest, verifyExecutionEnvelope } from './design.mjs'
import { loadExecutionEnvelope, studySourceDigest } from './integrity.mjs'
import { assertStudyProtocolFreeze, loadStudySpec } from './protocol.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const envelopePath = option('--execution-envelope')
const resultsPath = option('--results')
const outputPath = option('--out')
if (!envelopePath || !resultsPath) throw new Error('usage: analyze.mjs --execution-envelope <path> --results <path> [--out <path>]')

const { spec } = await loadStudySpec()
const studyFreeze = assertStudyProtocolFreeze(spec)
const { envelope } = await loadExecutionEnvelope(resolve(envelopePath), spec)
const records = await readJsonLines(resolve(resultsPath))
const analysis = analyzeEvaluation({
  preregistration: envelope.preregistration,
  manifest: envelope.runManifest,
  records,
  routerBlindResult: envelope.routerEvidence,
  requireProxyAccounting: true,
})
const controllerErrors = []
try {
  verifyExecutionEnvelope(envelope, spec)
  validatePreregistration(envelope.preregistration, { executionReady: true })
  validateManifest(envelope.runManifest)
  const source = studySourceDigest(studyFreeze.commit)
  if (source.digest !== envelope.controllerSourceDigest || source.digest !== envelope.driverSourceDigest) {
    throw new Error('analysis source differs from the public study freeze')
  }
  const regenerated = buildRc4RunManifest({
    studySpec: spec,
    preregistration: envelope.preregistration,
    runtimeArtifacts: envelope.runtimeArtifacts,
    routerEvidence: envelope.routerEvidence,
    driverSourceDigest: source.digest,
  })
  if (canonicalJson(regenerated) !== canonicalJson(envelope.runManifest)) {
    throw new Error('analysis manifest differs from the deterministic RC.4 design')
  }
} catch (error) {
  controllerErrors.push(String(error?.message ?? error))
}
controllerErrors.push(...await verifyAttemptReceipts(
  records,
  resolve(resultsPath),
  envelope.preregistration.resultSigning.publicKeySpkiBase64,
))
analysis.integrity.gates.unshift({
  name: 'RC.4 study, execution envelope, controller, result chain, and artifact binding',
  passed: controllerErrors.length === 0,
  observed: controllerErrors,
  threshold: 'exact public freezes and no integrity errors',
})
analysis.integrity.errors.push(...controllerErrors)
if (controllerErrors.length > 0) {
  analysis.releaseAllowed = false
  analysis.statement = 'Release blocked. No RC.4 general uplift claim is permitted from this result set.'
}
const rendered = canonicalJson(analysis)
if (outputPath) await writeFile(resolve(outputPath), rendered, 'utf8')
process.stdout.write(rendered)
process.exitCode = analysis.releaseAllowed ? 0 : 3
