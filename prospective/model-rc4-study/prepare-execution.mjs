#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../eval/v0.4/lib/canonical.mjs'
import { verifyPublicFreezeAttestation } from './attestation.mjs'
import { loadAndVerifyBaseAssetsLock } from './base-assets.mjs'
import {
  buildExecutionEnvelope,
  buildRc4Preregistration,
  buildRouterEvidenceRecord,
  buildRuntimeArtifactsRecord,
} from './design.mjs'
import { studySourceDigest } from './integrity.mjs'
import {
  assertCandidateFreeze,
  assertEvaluationBase,
  assertRouterProtocolFreeze,
  assertRuntimeWorkflowFreeze,
  assertStudyProtocolFreeze,
  loadStudySpec,
  repositoryRoot,
} from './protocol.mjs'
import { verifyRuntimeAcquisition } from './runtime-acquisition.mjs'
import { verifyV14EvidenceBundle } from './v14-evidence.mjs'

function exactPath(value, label) {
  if (!isAbsolute(value ?? '')) throw new Error(`${label} must be an absolute path`)
  return resolve(value)
}

function optionalExactPath(value, label) {
  return value === undefined ? undefined : exactPath(value, label)
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

async function assertFreshLedger(path, ledgerId) {
  const absolute = exactPath(path, 'signing ledger path')
  if (absolute === repositoryRoot || absolute.startsWith(`${repositoryRoot}/`)) {
    throw new Error('signing ledger must live outside the repository')
  }
  if (!/^[a-z0-9][a-z0-9._-]{15,127}$/u.test(ledgerId ?? '') || !ledgerId.includes('rc4') || ledgerId.includes('rc3')) {
    throw new Error('signing ledger identity must be a new RC.4-specific identity')
  }
  if (await exists(absolute) && (await stat(absolute)).size !== 0) {
    throw new Error('signing ledger must be new and empty before the execution freeze')
  }
  return absolute
}

function assertExecutionRefMissing(studySpec) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'show-ref', '--verify', '--quiet', studySpec.executionFreeze.futurePublicRef])
  if (result.status === 0) throw new Error('RC.4 execution freeze already exists; it cannot be replaced')
  if (result.status !== 1) throw new Error('unable to verify the RC.4 execution freeze ref')
}

function defaultDependencies(overrides = {}) {
  return {
    loadStudySpec,
    assertCandidateFreeze,
    assertEvaluationBase,
    assertRouterProtocolFreeze,
    assertRuntimeWorkflowFreeze,
    assertStudyProtocolFreeze,
    loadAndVerifyBaseAssetsLock,
    verifyRuntimeAcquisition,
    verifyV14EvidenceBundle,
    buildRuntimeArtifactsRecord,
    buildRouterEvidenceRecord,
    buildRc4Preregistration,
    buildExecutionEnvelope,
    studySourceDigest,
    verifyPublicFreezeAttestation,
    assertFreshLedger,
    assertExecutionRefMissing,
    ...overrides,
  }
}

export async function prepareExecutionEnvelope(options, overrides = {}) {
  const deps = defaultDependencies(overrides)
  const { spec: studySpec } = await deps.loadStudySpec()
  deps.assertExecutionRefMissing(studySpec)
  deps.assertCandidateFreeze(studySpec)
  deps.assertEvaluationBase(studySpec)
  deps.assertRouterProtocolFreeze(studySpec)
  deps.assertRuntimeWorkflowFreeze(studySpec)
  const studyFreeze = deps.assertStudyProtocolFreeze(studySpec)
  const studyAttestation = await deps.verifyPublicFreezeAttestation({
    kind: 'study',
    anchorPath: exactPath(options.studyAnchorPath, 'study public anchor'),
    bundlePath: optionalExactPath(options.studyBundlePath, 'study attestation bundle'),
  })
  await deps.loadAndVerifyBaseAssetsLock()

  const runtimeRoot = exactPath(options.runtimeRoot, 'runtime acquisition root')
  await deps.verifyRuntimeAcquisition(runtimeRoot)
  const runtimeArtifacts = deps.buildRuntimeArtifactsRecord()
  const v14Summary = await deps.verifyV14EvidenceBundle({
    dataRoot: exactPath(options.v14DataRoot, 'V14 data root'),
    v13DataRoot: exactPath(options.v13DataRoot, 'V13 data root'),
    v13SourceRoot: exactPath(options.v13SourceRoot, 'V13 source root'),
    runtimeArtifactRoot: exactPath(options.v14RuntimeRoot, 'V14 runtime root'),
  })
  const routerEvidence = deps.buildRouterEvidenceRecord(v14Summary)

  const signingPublicKeySpkiBase64 = options.signingPublicKeySpkiBase64.trim()
  await deps.assertFreshLedger(options.signingLedgerPath, options.signingLedgerId)
  const preregistration = deps.buildRc4Preregistration({
    studySpec,
    signingPublicKeySpkiBase64,
  })
  const source = deps.studySourceDigest(studyFreeze.commit)
  const envelope = deps.buildExecutionEnvelope({
    studySpec,
    studyProtocolCommit: studyFreeze.commit,
    preregistration,
    runtimeArtifacts,
    routerEvidence,
    driverSourceDigest: source.digest,
    controllerSourceDigest: source.digest,
    signingLedgerId: options.signingLedgerId,
  })
  const bytes = canonicalJson(envelope)
  const envelopeSha256 = sha256(bytes)

  if (options.write === false) {
    return { envelope, bytes, envelopeSha256, outputPath: null, checksumPath: null, studyAttestation }
  }
  const outputPath = resolve(repositoryRoot, studySpec.executionFreeze.evidencePath)
  if (options.outputPath && resolve(options.outputPath) !== outputPath) {
    throw new Error('execution envelope must use the preregistered evidence path')
  }
  const checksumPath = resolve(dirname(outputPath), 'execution-envelope.sha256')
  await mkdir(dirname(outputPath), { recursive: true })
  if (await exists(outputPath)) {
    const current = await readFile(outputPath, 'utf8')
    if (current !== bytes) throw new Error('a different execution envelope already exists')
  } else {
    await writeFile(outputPath, bytes, { encoding: 'utf8', mode: 0o644 })
  }
  await writeFile(checksumPath, `${envelopeSha256}  execution-envelope.json\n`, { encoding: 'utf8', mode: 0o644 })
  return { envelope, bytes, envelopeSha256, outputPath, checksumPath, studyAttestation }
}

export async function verifyFrozenExecutionAttestations(options, overrides = {}) {
  const deps = defaultDependencies(overrides)
  const { spec: studySpec } = await deps.loadStudySpec()
  const studyFreeze = deps.assertStudyProtocolFreeze(studySpec)
  const study = await deps.verifyPublicFreezeAttestation({
    kind: 'study',
    anchorPath: exactPath(options.studyAnchorPath, 'study public anchor'),
    bundlePath: optionalExactPath(options.studyBundlePath, 'study attestation bundle'),
  })
  const execution = await deps.verifyPublicFreezeAttestation({
    kind: 'execution',
    anchorPath: exactPath(options.executionAnchorPath, 'execution public anchor'),
    bundlePath: optionalExactPath(options.executionBundlePath, 'execution attestation bundle'),
  })
  if (study.sourceCommit !== studyFreeze.commit) throw new Error('study attestation does not bind the public study freeze')
  return { study, execution }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function isMain() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
}

if (isMain()) {
  const args = process.argv.slice(2)
  if (args.includes('--verify-public-anchors')) {
    const result = await verifyFrozenExecutionAttestations({
      studyAnchorPath: option(args, '--study-anchor'),
      studyBundlePath: option(args, '--study-bundle'),
      executionAnchorPath: option(args, '--execution-anchor'),
      executionBundlePath: option(args, '--execution-bundle'),
    })
    process.stdout.write(canonicalJson({ mode: 'public-anchors-verified', paidModelInvocations: 0, ...result }))
    process.exit(0)
  }
  const keyPath = option(args, '--signing-public-key')
  if (!keyPath) throw new Error('--signing-public-key <absolute DER-base64 text file> is required')
  const result = await prepareExecutionEnvelope({
    runtimeRoot: option(args, '--runtime-root'),
    v14DataRoot: option(args, '--v14-data-root'),
    v13DataRoot: option(args, '--v13-data-root'),
    v13SourceRoot: option(args, '--v13-source-root'),
    v14RuntimeRoot: option(args, '--v14-runtime-root'),
    signingPublicKeySpkiBase64: await readFile(exactPath(keyPath, 'signing public key'), 'utf8'),
    signingLedgerPath: option(args, '--signing-ledger'),
    signingLedgerId: option(args, '--signing-ledger-id'),
    studyAnchorPath: option(args, '--study-anchor'),
    studyBundlePath: option(args, '--study-bundle'),
    outputPath: option(args, '--out'),
    write: !args.includes('--dry-run'),
  })
  process.stdout.write(canonicalJson({
    mode: args.includes('--dry-run') ? 'dry-run' : 'execution-envelope-written',
    paidModelInvocations: 0,
    envelopeSha256: result.envelopeSha256,
    manifestDigest: result.envelope.runManifest.manifestDigest,
    outputPath: result.outputPath,
    checksumPath: result.checksumPath,
    studyAnchorSha256: result.studyAttestation.anchorSha256,
  }))
}
