import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V26_PROTOCOL_ID, V26_THRESHOLDS } from './analysis.mjs'

export const PROTOCOL_ID = V26_PROTOCOL_ID
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = '5c1df23e8dd60821658dd6b1359dd68ffccd9c67'
export const CANDIDATE_TREE = '86c5c3e2da99922480a3f9a7e4f60aecb4d1e2bd'
export const CANDIDATE_TARBALL_SHA256 = '5a98b71630ab5694e1af3ecaf02e9cabae7256758109427697aea7f77c13a915'
export const EVOCODE_DATASET_COMMIT = '9fcae3e5539d1c0e85e2481fe06bd6af42cc4bc6'
export const EVOCODE_ARCHIVE_SHA256 = 'a13d0cb47574282372c59366217ac68d895ff49d1387c81098b058f739906184'
export const TASK_RELATIVE_PATH = 'evocodebench_wotraj/theme_d1_w1_code_build_greenfield_implementation'
export const SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE = 'PLAN_LATTICE_LONG_SYSTEM_V26_SIGNING_PRIVATE_KEY'
export const FROZEN_EVIDENCE_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEA8WYHxiF2umisIpaJ9WpgWEJL4mu/A+g69iZQAxk/9h4='
export const FROZEN_EVIDENCE_PUBLIC_KEY_SHA256 = '38bc070ec0a786c5dff8d3e4f7df61d7545532b50baa7dd76cf6663b7b6ffb2e'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
export const FROZEN_MANIFEST_PATH = join(root, 'frozen-manifest.json')

function exact(value, pattern, field) {
  if (!pattern.test(value ?? '')) throw new Error(`${field} is not an exact immutable identity`)
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

export function validateV26Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('V26 frozen manifest must be an object')
  }
  const { manifestDigest, ...body } = manifest
  exact(manifestDigest, /^[0-9a-f]{64}$/, 'manifest digest')
  if (sha256(body) !== manifestDigest) throw new Error('V26 frozen manifest digest mismatch')
  if (manifest.schemaVersion !== 1
    || manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-native-calibration'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidateExecutionInitiallyAllowed !== false
    || manifest.calibration?.nativeRuns !== V26_THRESHOLDS.requiredNativeAttempts
    || manifest.calibration?.candidateRunsMaximum !== 1
    || manifest.outputPolicy?.exclusiveCreate !== true
    || manifest.outputPolicy?.overwriteAllowed !== false) {
    throw new Error('V26 frozen manifest lost its execution or immutability gates')
  }
  if (!same(manifest.thresholds, V26_THRESHOLDS)) {
    throw new Error('V26 frozen manifest thresholds differ from the preregistered analyzer')
  }
  if (!same(manifest.terminalOutcomePolicy, {
    scorableTerminalKinds: ['completed', 'max-tokens', 'attempt-budget-exhausted'],
    budgetTerminalAuthority: 'host-budget-proxy-first-rejection',
    budgetScope: 'attempt-including-compaction-and-subagents',
    stageStartBarrier: true,
    agentRequestConcurrency: 1,
    firstCrossingResponseRetained: true,
    officialVerifierAfterEveryProductTerminal: true,
    continueAfterPrematureTerminal: false,
    unreachedRoundsScoreZero: true,
    terminalEchoRequired: true,
    receiptDurability: 'exclusive-file-fsync-and-directory-fsync-before-ack',
    attemptSummaryAuthority: 'ed25519-chained-ledger',
    candidatePrematureTaskTerminals: 0,
  })) {
    throw new Error('V26 terminal outcome policy differs from the preregistered analyzer')
  }
  if (manifest.evidenceSigning?.algorithm !== 'Ed25519'
    || manifest.evidenceSigning?.privateKeyPathEnvironmentVariable !== SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE
    || manifest.evidenceSigning?.publicKeyBase64 !== FROZEN_EVIDENCE_PUBLIC_KEY_BASE64
    || manifest.evidenceSigning?.publicKeySha256 !== FROZEN_EVIDENCE_PUBLIC_KEY_SHA256) {
    throw new Error('V26 evidence signer is not frozen into the manifest')
  }
  exact(manifest.evidenceSigning?.publicKeySha256, /^[0-9a-f]{64}$/, 'evidence signing public key digest')
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(manifest.evidenceSigning.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
    if (publicKey.asymmetricKeyType !== 'ed25519'
      || sha256(Buffer.from(manifest.evidenceSigning.publicKeyBase64, 'base64')) !== manifest.evidenceSigning.publicKeySha256) {
      throw new Error('mismatch')
    }
  } catch {
    throw new Error('V26 evidence signing public key is invalid')
  }
  if (!same(manifest.priorObservation, {
    protocolId: 'plan-lattice-rc7-evocode-jobforge-v25',
    runId: 'v25-2026-08-21t11-34-50-183z-55a10ad9',
    resultClass: 'preregistered-negative',
    scoringStatus: 'no-valid-comparison-by-v25-policy',
    failureReason: 'evaluator-budget-terminal-was-unscorable',
    candidateExecuted: false,
    manifestDigest: 'c696ef80f0aa2696a8d76d1c8ebeaf496d309e02a7290184d2f82a109ddfb57f',
    reportDigest: '3f6d3123dddb9c9b1e21ca8320b328ef2b3c3bf1d919192f69e2d9f9988c8392',
    retainedNativeAttempts: 3,
    failedAttempt: {
      id: 'v25-2026-08-21t11-34-50-183z-55a10ad9-native-3',
      successfulModelResponses: 67,
      inputTokens: 6004986,
      outputTokens: 117086,
      localBudgetRejections: 3,
      reachedRoundsDescriptiveOnly: 3,
    },
    sourceDigests: {
      finalReport: '35a66cc2628609889080a4ce12cc25f75cca5e724eb606dc5147f98879243e77',
      modelProxyAudit: '70bcfa96c856acdd3029fee959da7c88cc41b63548793041232e9f12ab7d12ff',
      budgetAudit: '2cc96ed0528a9fcab909ea7a3b0b64afe07cb344177a8db54cf755bd81ae901c',
      attemptFailure: '620ae20b67a899dadaa3acb4222f124400767eaa18264f03aa27ee355b77a774',
    },
  })) {
    throw new Error('V26 prior observation provenance differs from the retained V25 result')
  }
  if (manifest.harness?.commit !== HARNESS_COMMIT
    || manifest.harness?.tag !== 'dsh-v0.1.0-rc.7'
    || manifest.harness?.runtimePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V26_HOST_RUNTIME') {
    throw new Error('V26 Harness identity is not the fixed rc.7 runtime')
  }
  exact(manifest.harness?.runtimeSha256, /^[0-9a-f]{64}$/, 'Harness runtime digest')
  if (manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.candidate?.tree !== CANDIDATE_TREE
    || manifest.candidate?.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate?.tarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.candidate?.packagePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V26_CANDIDATE_PACKAGE') {
    throw new Error('V26 candidate identity differs from the fixed rc.9 package')
  }
  if (!same(manifest.candidate.mode, {
    activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice',
  })
    || !same(manifest.candidate.evaluationWrapper, {
      strictBash: true,
      preconditionAdapter: 'workspace-shell-adapter',
      publicDefaultEquivalent: false,
      claimScope: 'The candidate is the frozen Plan Lattice tarball installed through the disclosed DSH Bash adapter; the adapter is evaluation integration, not part of the candidate tarball.',
    })) {
    throw new Error('V26 candidate execution mode differs from the evaluated wrapper')
  }
  if (manifest.task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || manifest.task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || manifest.task?.relativePath !== TASK_RELATIVE_PATH
    || manifest.task?.rootPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V26_TASK_ROOT'
    || manifest.task?.datasetPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V26_DATASET_ROOT'
    || manifest.task?.archivePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V26_DATASET_ARCHIVE'
    || manifest.task?.rounds !== 9) {
    throw new Error('V26 task identity differs from the fixed nine-round EvoCode task')
  }
  for (const [name, value] of Object.entries(manifest.task?.digests ?? {})) {
    exact(value, /^[0-9a-f]{64}$/, `task ${name} digest`)
  }
  if (!same(Object.keys(manifest.task?.digests ?? {}).sort(), ['hidden', 'oracle', 'public'])) {
    throw new Error('V26 task must freeze separate public, hidden, and oracle digests')
  }
  exact(manifest.task?.assetSha256, /^[0-9a-f]{64}$/, 'task asset digest')
  if (sha256(manifest.task.digests) !== manifest.task.assetSha256) {
    throw new Error('V26 task partition table does not match its asset digest')
  }
  exact(manifest.driver?.commit, /^[0-9a-f]{40}$/, 'driver commit')
  exact(manifest.driver?.tree, /^[0-9a-f]{40}$/, 'driver tree')
  exact(manifest.driver?.sourceDigest, /^[0-9a-f]{64}$/, 'driver source digest')
  if (sha256(manifest.driver?.sourceObjects ?? {}) !== manifest.driver.sourceDigest) {
    throw new Error('V26 driver object table does not match its source digest')
  }
  exact(manifest.image?.manifestSha256, /^[0-9a-f]{64}$/, 'Docker manifest digest')
  exact(manifest.image?.configSha256, /^[0-9a-f]{64}$/, 'Docker config digest')
  if (manifest.image?.taskPublicSha256 !== manifest.task.digests.public) {
    throw new Error('V26 Docker image is not bound to the frozen public task bytes')
  }
  if (typeof manifest.image?.reference !== 'string'
    || !manifest.image.reference.endsWith(`@sha256:${manifest.image.manifestSha256}`)) {
    throw new Error('V26 Docker image must use the frozen manifest digest reference')
  }
  if (manifest.model?.id !== 'deepseek-v4-flash'
    || manifest.model?.temperature !== 0
    || manifest.model?.agentMaxOutputTokens !== 32768
    || manifest.model?.compactionMaxOutputTokens !== 8192
    || !same(manifest.arms?.native, { id: 'native', plugin: 'none' })
    || manifest.arms?.candidate?.id !== 'v0.4-native-continuity'
    || !same(manifest.arms.candidate, {
      id: 'v0.4-native-continuity',
      plugin: 'v0.4.0-rc.9',
      activationMode: 'auto',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
      strictBash: true,
      preconditionAdapter: 'workspace-shell-adapter',
    })) {
    throw new Error('V26 model or arm contract differs from the frozen execution boundary')
  }
  return manifest
}

export async function readV26FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  return validateV26Manifest(JSON.parse(await readFile(path, 'utf8')))
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(canonicalJson(await readV26FrozenManifest()))
}
