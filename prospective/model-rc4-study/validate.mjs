#!/usr/bin/env node
import { resolve } from 'node:path'
import { canonicalJson, readJson } from '../../eval/v0.4/lib/canonical.mjs'
import { validateBenchmarkLock, validateManifest, validatePreregistration } from '../../eval/v0.4/lib/validation.mjs'
import { buildRc4RunManifest, verifyExecutionEnvelope } from './design.mjs'
import { loadExecutionEnvelope, studySourceDigest } from './integrity.mjs'
import {
  assertCandidateFreeze,
  assertEvaluationBase,
  assertRouterProtocolFreeze,
  assertRuntimeWorkflowFreeze,
  assertStudyProtocolFreeze,
  loadStudySpec,
} from './protocol.mjs'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const executionReady = args.includes('--execution-ready')
const envelopePath = option('--execution-envelope')
const { spec } = await loadStudySpec()
const basis = {
  candidate: assertCandidateFreeze(spec),
  evaluation: assertEvaluationBase(spec),
  runtimeWorkflow: assertRuntimeWorkflowFreeze(spec),
  routerProtocol: assertRouterProtocolFreeze(spec),
}

if (!envelopePath) {
  if (executionReady) throw new Error('--execution-ready requires --execution-envelope')
  console.log(canonicalJson({ mode: 'study-only', paidModelInvocations: 0, basis }))
  process.exit(0)
}

const studyFreeze = assertStudyProtocolFreeze(spec)
const { envelope, freeze: executionFreeze } = await loadExecutionEnvelope(resolve(envelopePath), spec)
verifyExecutionEnvelope(envelope, spec)
validatePreregistration(envelope.preregistration, { executionReady })
validateManifest(envelope.runManifest)
const benchmarkLock = await readJson(resolve(import.meta.dirname, '../../eval/v0.4/benchmark-lock.json'))
validateBenchmarkLock(benchmarkLock)
const source = studySourceDigest(studyFreeze.commit)
if (source.digest !== envelope.controllerSourceDigest || source.digest !== envelope.driverSourceDigest) {
  throw new Error('execution envelope source digest differs from the study freeze')
}
const regenerated = buildRc4RunManifest({
  studySpec: spec,
  preregistration: envelope.preregistration,
  runtimeArtifacts: envelope.runtimeArtifacts,
  routerEvidence: envelope.routerEvidence,
  driverSourceDigest: source.digest,
})
if (canonicalJson(regenerated) !== canonicalJson(envelope.runManifest)) {
  throw new Error('execution run manifest differs from the deterministic RC.4 design')
}
console.log(canonicalJson({
  mode: executionReady ? 'execution-ready' : 'execution-envelope-validation',
  paidModelInvocations: 0,
  studyProtocolCommit: studyFreeze.commit,
  executionFreezeCommit: executionFreeze.executionCommit,
  envelopeDigest: envelope.envelopeDigest,
  manifestDigest: envelope.runManifest.manifestDigest,
  runs: envelope.runManifest.counts,
}))
