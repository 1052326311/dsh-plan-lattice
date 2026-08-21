import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V27_EXECUTION_PLAN, V27_PROTOCOL_ID, V27_THRESHOLDS } from './analysis.mjs'
import {
  V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
  V27_MANIFEST_RELATIVE_PATH,
  V27_PUBLIC_REF,
  V27_PUBLIC_REMOTE_URL,
} from './public-anchor.mjs'

export const PROTOCOL_ID = V27_PROTOCOL_ID
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = '5c1df23e8dd60821658dd6b1359dd68ffccd9c67'
export const CANDIDATE_TREE = '86c5c3e2da99922480a3f9a7e4f60aecb4d1e2bd'
export const CANDIDATE_TARBALL_SHA256 = '5a98b71630ab5694e1af3ecaf02e9cabae7256758109427697aea7f77c13a915'
export const CANDIDATE_LOCKFILE_SHA256 = '1fbfd191c614e98ac9062d67eb239d45ae383d0109f9ec4a2d0b6daef574c521'
export const CANDIDATE_SOURCE_PAYLOAD_SHA256 = '3ffc4e7c36eadfd3de79a7fa424194685b4a9ea5adc5a61045aeb7251729fc17'
export const CANDIDATE_NODE_VERSION = 'v22.23.0'
export const CANDIDATE_PNPM_VERSION = '11.19.0'
export const CANDIDATE_NPM_VERSION = '10.9.8'
export const CANDIDATE_SOURCE_PROVENANCE = Object.freeze({
  method: 'git-archive+pnpm-offline-frozen-lockfile+tsc+npm-pack-payload',
  commit: CANDIDATE_COMMIT,
  tree: CANDIDATE_TREE,
  lockfileSha256: CANDIDATE_LOCKFILE_SHA256,
  node: CANDIDATE_NODE_VERSION,
  pnpm: CANDIDATE_PNPM_VERSION,
  npm: CANDIDATE_NPM_VERSION,
  payloadSha256: CANDIDATE_SOURCE_PAYLOAD_SHA256,
  entryCount: 67,
})
export const EVOCODE_DATASET_COMMIT = '9fcae3e5539d1c0e85e2481fe06bd6af42cc4bc6'
export const EVOCODE_ARCHIVE_SHA256 = 'a13d0cb47574282372c59366217ac68d895ff49d1387c81098b058f739906184'
export const EVOCODE_DATASET_REMOTE = 'https://huggingface.co/datasets/UnipatAI/EvoCodeBench'
export const EVOCODE_ARCHIVE_RELATIVE_PATH = 'archives/evocodebench_wotraj.tar.zst'
export const V27_ZSTD_VERSION = '1.5.7'
export const V27_ZSTD_SHA256 = '9738d3b7cc68c96ebb6ab150e300b98bd2d0de05af76eb08275439bbac1a2ba1'
export const V27_ZSTD_SOURCE_ARCHIVE_SHA256 = 'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3'
export const V27_ZSTD_RELEASE_URL = 'https://github.com/facebook/zstd/releases/tag/v1.5.7'
export const TASK_RELATIVE_PATH = 'evocodebench_wotraj/theme_d1_w1_code_build_greenfield_implementation'
export const SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE = 'PLAN_LATTICE_LONG_SYSTEM_V27_SIGNING_PRIVATE_KEY'
export const FROZEN_EVIDENCE_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEA8WYHxiF2umisIpaJ9WpgWEJL4mu/A+g69iZQAxk/9h4='
export const FROZEN_EVIDENCE_PUBLIC_KEY_SHA256 = '38bc070ec0a786c5dff8d3e4f7df61d7545532b50baa7dd76cf6663b7b6ffb2e'
export const V27_UPSTREAM_BASE_URL = 'https://api.deepseek.com'
export const V27_UPSTREAM_BASE_URL_SHA256 = sha256(V27_UPSTREAM_BASE_URL)
export const V27_MODEL = Object.freeze({
  provider: 'DeepSeek',
  id: 'deepseek-v4-flash',
  upstreamBaseUrl: V27_UPSTREAM_BASE_URL,
  upstreamBaseUrlSha256: V27_UPSTREAM_BASE_URL_SHA256,
  temperature: 0,
  agentMaxOutputTokens: 32768,
  compactionMaxOutputTokens: 8192,
  timeoutMsPerEpoch: 14_400_000,
})
export const V27_ATTEMPT_BUDGET = Object.freeze({
  maxAgentRequests: 240,
  maxInputTokens: 6_000_000,
  maxOutputTokens: 750_000,
})
export const V27_EXECUTION_SANDBOX = Object.freeze({
  harnessProcessBoundary: 'unconfined-host-driver',
  modelBashPermissionMode: 'workspace-write-private-host-deny-seatbelt-command',
  bashEscalationAllowed: false,
  filesystemReadBoundary: 'native-read-tools-disabled-bash-private-host-denylist',
  userDataReadBoundary: 'workspace-and-isolated-home-tmp-only',
  systemRuntimeMetadataReadable: true,
  outboundNetworkAllowed: false,
  priorAttemptReadAllowed: false,
  repositoryAndGraderReadAllowed: false,
  toolchainReadRoots: 'explicit-frozen-host-runtime-roots-only',
  protectedRuntimeTrees: true,
  finalDecoderSource: 'frozen-harness-tarball',
})
export const V27_DRIVER_OBJECT_PATHS = Object.freeze([
  'eval/long-system/v27',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/v0.4/driver/lib',
  'eval/v0.4/lib/canonical.mjs',
])
export const V27_PRIOR_OBSERVATION = Object.freeze({
  protocolId: 'plan-lattice-rc7-evocode-jobforge-v26',
  runId: 'v26-2026-08-21t23-02-00-frozen',
  resultClass: 'preregistered-negative',
  scoringStatus: 'candidate-prohibited-by-v26-policy',
  failureReason: 'native-score-spread-exceeded-preregistered-bound',
  candidateExecuted: false,
  manifestDigest: '0228c485734a7ce825aec86578630a7cc88ac001780fd36233090bc07b42cce0',
  reportDigest: '98afdc54c60d28388e4d89461c74efcf3256fa2a2a01b458bd97f472677ca670',
  signingLedgerHead: '937cae4fbe6f9a938887611b8c5d9ea2c1ab64eb9cdc170752a4e961897ccc9b',
  retainedNativeAttempts: 5,
  nativeScores: [0, 0, 33.333333333333336, 0, 0],
  nativeScoreSpread: 33.333333333333336,
  terminalKinds: ['max-tokens', 'max-tokens', 'attempt-budget-exhausted', 'max-tokens', 'max-tokens'],
  diskVerifierObservation: 'semantic exhausted-dimension arrays were compared with order-sensitive JSON.stringify after canonical serialization reordered object keys',
  sourceDigests: {
    finalReport: 'e6d08c8a07b62aa77da57435a63c82834bc1184292e32a73c04c35c60546466d',
    nativeQualification: 'e940c7efc8a564a494d052029c86fcecfd3556421c38548d92ba0e62d2d38b2a',
    modelProxyAudit: '928b88882874476aac5b0ea1404f8c7eccefca0fba0a7f4ae33f2eb8bc26e4d9',
    budgetAudit: '95e2f2fe4cfe81c4e18a5b3722d53099ca8575bfb8839103e15493d401f9032a',
    signingLedger: 'a5020e04ca89ac5cb3cd78934f4dce8ad5acc1dabd38dc089b28ad2240fd5d2d',
    runEnvelope: '46f177befb74aa7fb0cc5de79965383fda2bc4d8223f707b319f9b9edf6b074c',
  },
})

const root = resolve(dirname(fileURLToPath(import.meta.url)))
export const FROZEN_MANIFEST_PATH = join(root, 'frozen-manifest.json')

function exact(value, pattern, field) {
  if (!pattern.test(value ?? '')) throw new Error(`${field} is not an exact immutable identity`)
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

export function validateV27Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('V27 frozen manifest must be an object')
  }
  const { manifestDigest, ...body } = manifest
  exact(manifestDigest, /^[0-9a-f]{64}$/, 'manifest digest')
  if (sha256(body) !== manifestDigest) throw new Error('V27 frozen manifest digest mismatch')
  if (manifest.schemaVersion !== 3
    || manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-paired-comparison'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidateExecutionInitiallyAllowed !== true
    || manifest.comparison?.pairs !== V27_THRESHOLDS.requiredPairs
    || manifest.comparison?.attemptsPerArm !== V27_THRESHOLDS.requiredAttemptsPerArm
    || !same(manifest.comparison?.order, V27_EXECUTION_PLAN)
    || manifest.comparison?.aggregation !== 'median-of-twelve-per-arm-with-twelve-contemporaneous-pairs'
    || manifest.comparison?.releaseAuthority !== 'eval/long-system/v27/report-verifier.mjs'
    || !same(manifest.paidRuns, { native: 12, candidate: 12 })
    || manifest.outputPolicy?.rootEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_OUTPUT_ROOT'
    || !isAbsolute(manifest.outputPolicy?.absoluteRoot ?? '')
    || manifest.outputPolicy?.exclusiveCreate !== true
    || manifest.outputPolicy?.overwriteAllowed !== false) {
    throw new Error('V27 frozen manifest lost its execution or immutability gates')
  }
  if (!/^[a-z0-9][a-z0-9._-]{7,47}$/u.test(manifest.trial?.runId ?? '')
    || manifest.trial?.outputRoot !== manifest.outputPolicy.absoluteRoot
    || !same(manifest.trial?.disclosurePolicy, {
      publicPrecommitRequired: true,
      accidentalDuplicatePrevention: 'exclusive-local-files',
      maliciousLocalDeletionDetection: false,
      claimScope: 'one publicly preregistered, operator-attested disclosed trial; absence of deleted local trials is not cryptographically proven',
    })
    || !same(manifest.publicationAnchor, {
      schemaVersion: 1,
      manifestPath: V27_MANIFEST_RELATIVE_PATH,
      commitEnvironmentVariable: V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
      publicRemoteUrl: V27_PUBLIC_REMOTE_URL,
      publicRef: V27_PUBLIC_REF,
      requiredBeforePaidRequest: true,
      singleParentOfDriverCommit: true,
      exactRemoteRefRequired: true,
      currentExactTagEqualityRequired: true,
      tagHistoryAuthority: 'current-remote-equality-only; historical immutability is operator-attested',
    })) {
    throw new Error('V27 trial identity, disclosure scope, or public manifest anchor is not frozen')
  }
  if (!same(manifest.thresholds, V27_THRESHOLDS)) {
    throw new Error('V27 frozen manifest thresholds differ from the preregistered analyzer')
  }
  if (!same(manifest.executionSandbox, V27_EXECUTION_SANDBOX)) {
    throw new Error('V27 execution sandbox differs from the frozen explicit-read boundary')
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
    equalHardBudgetPerArm: true,
    realizedUsageIsDescriptive: true,
  })) {
    throw new Error('V27 terminal outcome policy differs from the preregistered analyzer')
  }
  if (manifest.evidenceSigning?.algorithm !== 'Ed25519'
    || manifest.evidenceSigning?.schemaVersion !== 3
    || manifest.evidenceSigning?.signedPayload !== 'canonical-complete-attempt-envelope'
    || manifest.evidenceSigning?.privateKeyPathEnvironmentVariable !== SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE
    || manifest.evidenceSigning?.publicKeyBase64 !== FROZEN_EVIDENCE_PUBLIC_KEY_BASE64
    || manifest.evidenceSigning?.publicKeySha256 !== FROZEN_EVIDENCE_PUBLIC_KEY_SHA256) {
    throw new Error('V27 evidence signer is not frozen into the manifest')
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
    throw new Error('V27 evidence signing public key is invalid')
  }
  if (!same(manifest.priorObservation, V27_PRIOR_OBSERVATION)) {
    throw new Error('V27 prior observation provenance differs from the retained V26 result')
  }
  if (manifest.harness?.commit !== HARNESS_COMMIT
    || manifest.harness?.tag !== 'dsh-v0.1.0-rc.7'
    || manifest.harness?.runtimePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_HOST_RUNTIME') {
    throw new Error('V27 Harness identity is not the fixed rc.7 runtime')
  }
  exact(manifest.harness?.runtimeSha256, /^[0-9a-f]{64}$/, 'Harness runtime digest')
  exact(manifest.harness?.runtimeMetadataSha256, /^[0-9a-f]{64}$/, 'Harness metadata digest')
  if (manifest.harness?.platform !== 'darwin'
    || manifest.harness?.architecture !== 'arm64'
    || manifest.harness?.node !== 'v22.23.0') {
    throw new Error('V27 Harness host identity differs from the frozen execution host')
  }
  if (manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.candidate?.tree !== CANDIDATE_TREE
    || manifest.candidate?.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate?.tarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.candidate?.packagePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_CANDIDATE_PACKAGE') {
    throw new Error('V27 candidate identity differs from the fixed rc.9 package')
  }
  if (!same(manifest.candidate?.sourceProvenance, CANDIDATE_SOURCE_PROVENANCE)
    || manifest.candidate?.sourceProvenanceSha256 !== sha256(CANDIDATE_SOURCE_PROVENANCE)) {
    throw new Error('V27 candidate package is not reproducible from the frozen public source commit')
  }
  if (!same(manifest.candidate.mode, {
    activationMode: 'auto', clarificationPolicy: 'critical', controlCeiling: 'lattice',
  })
    || !same(manifest.candidate.evaluationWrapper, {
      strictBash: true,
      preconditionAdapter: 'workspace-shell-adapter',
      activationEvidence: 'one exclusive fsync-backed receipt per actual Harness process, bound to epoch digest, evaluator nonce, process PID, wrapper, candidate, config, and Bash adapter',
      publicDefaultEquivalent: false,
      claimScope: 'The candidate is the frozen Plan Lattice tarball installed through the disclosed DSH Bash adapter; the adapter is evaluation integration, not part of the candidate tarball.',
    })) {
    throw new Error('V27 candidate execution mode differs from the evaluated wrapper')
  }
  exact(manifest.candidate?.packageManifestSha256, /^[0-9a-f]{64}$/, 'candidate package manifest digest')
  if (manifest.task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || manifest.task?.datasetRemote !== EVOCODE_DATASET_REMOTE
    || manifest.task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || manifest.task?.archiveRelativePath !== EVOCODE_ARCHIVE_RELATIVE_PATH
    || manifest.task?.relativePath !== TASK_RELATIVE_PATH
    || manifest.task?.rootPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_TASK_ROOT'
    || manifest.task?.datasetPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_DATASET_ROOT'
    || manifest.task?.archivePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_DATASET_ARCHIVE'
    || manifest.task?.decompressorPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V27_ZSTD'
    || manifest.task?.decompressorVersion !== V27_ZSTD_VERSION
    || manifest.task?.decompressorSha256 !== V27_ZSTD_SHA256
    || manifest.task?.decompressorSourceArchiveSha256 !== V27_ZSTD_SOURCE_ARCHIVE_SHA256
    || manifest.task?.decompressorReleaseUrl !== V27_ZSTD_RELEASE_URL
    || manifest.task?.rounds !== 9) {
    throw new Error('V27 task identity differs from the fixed nine-round EvoCode task')
  }
  for (const [name, value] of Object.entries(manifest.task?.digests ?? {})) {
    exact(value, /^[0-9a-f]{64}$/, `task ${name} digest`)
  }
  if (!same(Object.keys(manifest.task?.digests ?? {}).sort(), ['hidden', 'oracle', 'public'])) {
    throw new Error('V27 task must freeze separate public, hidden, and oracle digests')
  }
  exact(manifest.task?.assetSha256, /^[0-9a-f]{64}$/, 'task asset digest')
  exact(manifest.task?.datasetTree, /^[0-9a-f]{40}$/, 'task dataset tree')
  exact(manifest.task?.archivePointerBlob, /^[0-9a-f]{40}$/, 'task archive pointer blob')
  exact(manifest.task?.decompressorSha256, /^[0-9a-f]{64}$/, 'task decompressor digest')
  exact(manifest.task?.taskTreeSha256, /^[0-9a-f]{64}$/, 'task checkout tree digest')
  if (!Number.isSafeInteger(manifest.task?.taskFileCount) || manifest.task.taskFileCount < 1) {
    throw new Error('V27 task checkout file count is not frozen')
  }
  if (!Number.isSafeInteger(manifest.task?.archiveBytes) || manifest.task.archiveBytes < 1) {
    throw new Error('V27 task archive size is not frozen')
  }
  if (sha256(manifest.task.digests) !== manifest.task.assetSha256) {
    throw new Error('V27 task partition table does not match its asset digest')
  }
  exact(manifest.driver?.commit, /^[0-9a-f]{40}$/, 'driver commit')
  exact(manifest.driver?.tree, /^[0-9a-f]{40}$/, 'driver tree')
  exact(manifest.driver?.sourceDigest, /^[0-9a-f]{64}$/, 'driver source digest')
  if (!same(Object.keys(manifest.driver?.sourceObjects ?? {}).sort(), [...V27_DRIVER_OBJECT_PATHS].sort())) {
    throw new Error('V27 driver source object paths differ from the frozen dependency closure')
  }
  for (const [path, object] of Object.entries(manifest.driver.sourceObjects)) {
    exact(object, /^[0-9a-f]{40}$/, `driver source object ${path}`)
  }
  if (sha256(manifest.driver?.sourceObjects ?? {}) !== manifest.driver.sourceDigest) {
    throw new Error('V27 driver object table does not match its source digest')
  }
  if (manifest.driver.sourceObjects['eval/long-system/v27'] !== manifest.driver.tree) {
    throw new Error('V27 driver tree is not the frozen analyzer tree object')
  }
  exact(manifest.image?.manifestSha256, /^[0-9a-f]{64}$/, 'Docker manifest digest')
  exact(manifest.image?.configSha256, /^[0-9a-f]{64}$/, 'Docker config digest')
  if (manifest.image?.taskPublicSha256 !== manifest.task.digests.public) {
    throw new Error('V27 Docker image is not bound to the frozen public task bytes')
  }
  if (typeof manifest.image?.reference !== 'string'
    || !manifest.image.reference.endsWith(`@sha256:${manifest.image.manifestSha256}`)) {
    throw new Error('V27 Docker image must use the frozen manifest digest reference')
  }
  if (!same(manifest.model, V27_MODEL)
    || !same(manifest.budgetPerAttempt, V27_ATTEMPT_BUDGET)
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
    throw new Error('V27 model or arm contract differs from the frozen execution boundary')
  }
  return manifest
}

export async function readV27FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  return validateV27Manifest(JSON.parse(await readFile(path, 'utf8')))
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(canonicalJson(await readV27FrozenManifest()))
}
