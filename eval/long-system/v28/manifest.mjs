import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V28_EXECUTION_PLAN, V28_PROTOCOL_ID, V28_THRESHOLDS } from './analysis.mjs'
import {
  V28_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
  V28_MANIFEST_RELATIVE_PATH,
  V28_PUBLIC_REF,
  V28_PUBLIC_REMOTE_URL,
} from './public-anchor.mjs'

export const PROTOCOL_ID = V28_PROTOCOL_ID
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = 'e79413ff2770b2b67217ce2010cd1df4c1b2aa87'
export const CANDIDATE_TREE = 'd88d47d8b74a93c739bda3359a69aa735fb72c71'
export const CANDIDATE_TARBALL_SHA256 = '7a7a17b12927890e11fe537d796d43897d5f4dbaba379dc5cb9f9242d6d8c7f1'
export const CANDIDATE_LOCKFILE_SHA256 = '1fbfd191c614e98ac9062d67eb239d45ae383d0109f9ec4a2d0b6daef574c521'
export const CANDIDATE_SOURCE_PAYLOAD_SHA256 = 'ba78f7a3b03144186e118992d2a4e4ebe6a517249355169b0dfc8eae71f960e4'
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
export const V28_ZSTD_VERSION = '1.5.7'
export const V28_ZSTD_SHA256 = '9738d3b7cc68c96ebb6ab150e300b98bd2d0de05af76eb08275439bbac1a2ba1'
export const V28_ZSTD_SOURCE_ARCHIVE_SHA256 = 'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3'
export const V28_ZSTD_RELEASE_URL = 'https://github.com/facebook/zstd/releases/tag/v1.5.7'
export const TASK_RELATIVE_PATH = 'evocodebench_wotraj/theme_d1_w1_code_build_greenfield_implementation'
export const SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE = 'PLAN_LATTICE_LONG_SYSTEM_V28_SIGNING_PRIVATE_KEY'
export const FROZEN_EVIDENCE_PUBLIC_KEY_BASE64 = 'MCowBQYDK2VwAyEA8WYHxiF2umisIpaJ9WpgWEJL4mu/A+g69iZQAxk/9h4='
export const FROZEN_EVIDENCE_PUBLIC_KEY_SHA256 = '38bc070ec0a786c5dff8d3e4f7df61d7545532b50baa7dd76cf6663b7b6ffb2e'
export const V28_UPSTREAM_BASE_URL = 'https://api.deepseek.com'
export const V28_UPSTREAM_BASE_URL_SHA256 = sha256(V28_UPSTREAM_BASE_URL)
export const V28_MODEL = Object.freeze({
  provider: 'DeepSeek',
  id: 'deepseek-v4-flash',
  upstreamBaseUrl: V28_UPSTREAM_BASE_URL,
  upstreamBaseUrlSha256: V28_UPSTREAM_BASE_URL_SHA256,
  temperature: 0,
  agentMaxOutputTokens: 32768,
  compactionMaxOutputTokens: 8192,
  timeoutMsPerEpoch: 14_400_000,
})
export const V28_ATTEMPT_BUDGET = Object.freeze({
  maxAgentRequests: 240,
  maxInputTokens: 6_000_000,
  maxOutputTokens: 750_000,
})
export const V28_EXECUTION_SANDBOX = Object.freeze({
  harnessProcessBoundary: 'unconfined-host-driver',
  modelBashPermissionMode: 'workspace-write-strict-seatbelt-provider',
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
export const V28_DRIVER_OBJECT_PATHS = Object.freeze([
  'eval/long-system/v28',
  'eval/long-system/driver/model-proxy.mjs',
  'eval/pilots/driver/budget-proxy.mjs',
  'eval/v0.4/driver/lib',
  'eval/v0.4/lib/canonical.mjs',
])
export const V28_PRIOR_OBSERVATION = Object.freeze({
  protocolId: 'plan-lattice-rc7-evocode-jobforge-v27',
  runId: 'v27-2026-08-22-paired-a',
  resultClass: 'preregistered-negative-incomplete',
  scoringStatus: 'unscoreable-incomplete-trial',
  failureReason: 'trial ended during pair-7 Native before its attempt record and before a final report',
  candidateExecuted: true,
  manifestCommit: '109dd3a2a73d600eca7f435e071ce4782da3ebcc',
  manifestDigest: 'ab19067ed7cb2f78cfb11757438bd17e0bd86291db739355439fd50fc4eecd79',
  trialClaimDigest: 'aed808a0900630de558ee25916a45a5afc4af55a7e46731ff1bf0e272e9e83e4',
  signingLedgerRecords: 13,
  signingLedgerHead: 'c5354747cc01224104ef16413f2e5c273c0e6bb710dee9ecc604eb2f27d18436',
  retainedAttempts: { native: 6, candidate: 7 },
  nativeScores: [0, 0, 0, 0, 33.333333333333336, 11.11111111111111],
  candidateScores: [0, 0, 0, 0, 0, 0, 0],
  nativeReachedRounds: [1, 1, 1, 1, 3, 1],
  candidateReachedRounds: [1, 1, 1, 1, 1, 1, 1],
  nativeTerminalKinds: [
    'max-tokens', 'max-tokens', 'max-tokens', 'max-tokens',
    'attempt-budget-exhausted', 'attempt-budget-exhausted',
  ],
  candidateTerminalKinds: [
    'attempt-budget-exhausted', 'attempt-budget-exhausted', 'attempt-budget-exhausted',
    'attempt-budget-exhausted', 'attempt-budget-exhausted', 'attempt-budget-exhausted',
    'max-tokens',
  ],
  retainedPair1Candidate: {
    score: 0,
    reachedRounds: 1,
    modelTurns: 89,
    inputTokens: 6_142_664,
    contextRefreshCalls: 21,
    todoWrites: 12,
    completedTodoTransitions: 0,
    terminalKind: 'attempt-budget-exhausted',
  },
  retainedDiagnosis: 'local Bash, test, and guard failures created authority-refresh debt; repeated unchanged authority reads then consumed the task budget without advancing the active Todo',
  sourceDigests: {
    trialClaim: '611bf03bb253fc6765d93b88d551761119b82396e31e5b3ab81af10dc0f6f349',
    runEnvelope: '0182ea2a5495ceff6c71bc8363371ce01bdb9d3797e83020fe90ecf54c54be76',
    signingLedger: '4a6cb0e6937bf6583b3495422f8124976a6aaca9ca877fdbb39615f5ceccb82e',
    modelProxyAudit: 'ab144a8cca38de0654ad89dbdd01190afcf0c490edaa2db424eb28c919b26c06',
    budgetAudit: 'ca35853f0f26ceb6d7f7cf09fb9c5c4082cea387ef94260a72652c6c6c7c81e7',
    pair1Candidate: '1405b6cfde8d39034d8c6f727b2f7cbaa2f70a1b0c763e666933877d447c307d',
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

export function validateV28Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('V28 frozen manifest must be an object')
  }
  const { manifestDigest, ...body } = manifest
  exact(manifestDigest, /^[0-9a-f]{64}$/, 'manifest digest')
  if (sha256(body) !== manifestDigest) throw new Error('V28 frozen manifest digest mismatch')
  if (manifest.schemaVersion !== 3
    || manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-paired-comparison'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidateExecutionInitiallyAllowed !== true
    || manifest.comparison?.pairs !== V28_THRESHOLDS.requiredPairs
    || manifest.comparison?.attemptsPerArm !== V28_THRESHOLDS.requiredAttemptsPerArm
    || !same(manifest.comparison?.order, V28_EXECUTION_PLAN)
    || manifest.comparison?.aggregation !== 'median-of-twelve-per-arm-with-twelve-contemporaneous-pairs'
    || manifest.comparison?.releaseAuthority !== 'eval/long-system/v28/report-verifier.mjs'
    || !same(manifest.paidRuns, { native: 12, candidate: 12 })
    || manifest.outputPolicy?.rootEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_OUTPUT_ROOT'
    || !isAbsolute(manifest.outputPolicy?.absoluteRoot ?? '')
    || manifest.outputPolicy?.exclusiveCreate !== true
    || manifest.outputPolicy?.overwriteAllowed !== false) {
    throw new Error('V28 frozen manifest lost its execution or immutability gates')
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
      manifestPath: V28_MANIFEST_RELATIVE_PATH,
      commitEnvironmentVariable: V28_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
      publicRemoteUrl: V28_PUBLIC_REMOTE_URL,
      publicRef: V28_PUBLIC_REF,
      requiredBeforePaidRequest: true,
      singleParentOfDriverCommit: true,
      exactRemoteRefRequired: true,
      currentExactTagEqualityRequired: true,
      tagHistoryAuthority: 'current-remote-equality-only; historical immutability is operator-attested',
    })) {
    throw new Error('V28 trial identity, disclosure scope, or public manifest anchor is not frozen')
  }
  if (!same(manifest.thresholds, V28_THRESHOLDS)) {
    throw new Error('V28 frozen manifest thresholds differ from the preregistered analyzer')
  }
  if (!same(manifest.executionSandbox, V28_EXECUTION_SANDBOX)) {
    throw new Error('V28 execution sandbox differs from the frozen explicit-read boundary')
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
    throw new Error('V28 terminal outcome policy differs from the preregistered analyzer')
  }
  if (manifest.evidenceSigning?.algorithm !== 'Ed25519'
    || manifest.evidenceSigning?.schemaVersion !== 3
    || manifest.evidenceSigning?.signedPayload !== 'canonical-complete-attempt-envelope'
    || manifest.evidenceSigning?.privateKeyPathEnvironmentVariable !== SIGNING_PRIVATE_KEY_PATH_ENVIRONMENT_VARIABLE
    || manifest.evidenceSigning?.publicKeyBase64 !== FROZEN_EVIDENCE_PUBLIC_KEY_BASE64
    || manifest.evidenceSigning?.publicKeySha256 !== FROZEN_EVIDENCE_PUBLIC_KEY_SHA256) {
    throw new Error('V28 evidence signer is not frozen into the manifest')
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
    throw new Error('V28 evidence signing public key is invalid')
  }
  if (!same(manifest.priorObservation, V28_PRIOR_OBSERVATION)) {
    throw new Error('V28 prior observation provenance differs from the retained V27 result')
  }
  if (manifest.harness?.commit !== HARNESS_COMMIT
    || manifest.harness?.tag !== 'dsh-v0.1.0-rc.7'
    || manifest.harness?.runtimePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_HOST_RUNTIME') {
    throw new Error('V28 Harness identity is not the fixed rc.7 runtime')
  }
  exact(manifest.harness?.runtimeSha256, /^[0-9a-f]{64}$/, 'Harness runtime digest')
  exact(manifest.harness?.runtimeMetadataSha256, /^[0-9a-f]{64}$/, 'Harness metadata digest')
  if (manifest.harness?.platform !== 'darwin'
    || manifest.harness?.architecture !== 'arm64'
    || manifest.harness?.node !== 'v22.23.0') {
    throw new Error('V28 Harness host identity differs from the frozen execution host')
  }
  if (manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.candidate?.tree !== CANDIDATE_TREE
    || manifest.candidate?.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate?.tarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.candidate?.packagePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_CANDIDATE_PACKAGE') {
    throw new Error('V28 candidate identity differs from the fixed rc.9 package')
  }
  if (!same(manifest.candidate?.sourceProvenance, CANDIDATE_SOURCE_PROVENANCE)
    || manifest.candidate?.sourceProvenanceSha256 !== sha256(CANDIDATE_SOURCE_PROVENANCE)) {
    throw new Error('V28 candidate package is not reproducible from the frozen public source commit')
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
    throw new Error('V28 candidate execution mode differs from the evaluated wrapper')
  }
  exact(manifest.candidate?.packageManifestSha256, /^[0-9a-f]{64}$/, 'candidate package manifest digest')
  if (manifest.task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || manifest.task?.datasetRemote !== EVOCODE_DATASET_REMOTE
    || manifest.task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || manifest.task?.archiveRelativePath !== EVOCODE_ARCHIVE_RELATIVE_PATH
    || manifest.task?.relativePath !== TASK_RELATIVE_PATH
    || manifest.task?.rootPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_TASK_ROOT'
    || manifest.task?.datasetPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_DATASET_ROOT'
    || manifest.task?.archivePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_DATASET_ARCHIVE'
    || manifest.task?.decompressorPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V28_ZSTD'
    || manifest.task?.decompressorVersion !== V28_ZSTD_VERSION
    || manifest.task?.decompressorSha256 !== V28_ZSTD_SHA256
    || manifest.task?.decompressorSourceArchiveSha256 !== V28_ZSTD_SOURCE_ARCHIVE_SHA256
    || manifest.task?.decompressorReleaseUrl !== V28_ZSTD_RELEASE_URL
    || manifest.task?.rounds !== 9) {
    throw new Error('V28 task identity differs from the fixed nine-round EvoCode task')
  }
  for (const [name, value] of Object.entries(manifest.task?.digests ?? {})) {
    exact(value, /^[0-9a-f]{64}$/, `task ${name} digest`)
  }
  if (!same(Object.keys(manifest.task?.digests ?? {}).sort(), ['hidden', 'oracle', 'public'])) {
    throw new Error('V28 task must freeze separate public, hidden, and oracle digests')
  }
  exact(manifest.task?.assetSha256, /^[0-9a-f]{64}$/, 'task asset digest')
  exact(manifest.task?.datasetTree, /^[0-9a-f]{40}$/, 'task dataset tree')
  exact(manifest.task?.archivePointerBlob, /^[0-9a-f]{40}$/, 'task archive pointer blob')
  exact(manifest.task?.decompressorSha256, /^[0-9a-f]{64}$/, 'task decompressor digest')
  exact(manifest.task?.taskTreeSha256, /^[0-9a-f]{64}$/, 'task checkout tree digest')
  if (!Number.isSafeInteger(manifest.task?.taskFileCount) || manifest.task.taskFileCount < 1) {
    throw new Error('V28 task checkout file count is not frozen')
  }
  if (!Number.isSafeInteger(manifest.task?.archiveBytes) || manifest.task.archiveBytes < 1) {
    throw new Error('V28 task archive size is not frozen')
  }
  if (sha256(manifest.task.digests) !== manifest.task.assetSha256) {
    throw new Error('V28 task partition table does not match its asset digest')
  }
  exact(manifest.driver?.commit, /^[0-9a-f]{40}$/, 'driver commit')
  exact(manifest.driver?.tree, /^[0-9a-f]{40}$/, 'driver tree')
  exact(manifest.driver?.sourceDigest, /^[0-9a-f]{64}$/, 'driver source digest')
  if (!same(Object.keys(manifest.driver?.sourceObjects ?? {}).sort(), [...V28_DRIVER_OBJECT_PATHS].sort())) {
    throw new Error('V28 driver source object paths differ from the frozen dependency closure')
  }
  for (const [path, object] of Object.entries(manifest.driver.sourceObjects)) {
    exact(object, /^[0-9a-f]{40}$/, `driver source object ${path}`)
  }
  if (sha256(manifest.driver?.sourceObjects ?? {}) !== manifest.driver.sourceDigest) {
    throw new Error('V28 driver object table does not match its source digest')
  }
  if (manifest.driver.sourceObjects['eval/long-system/v28'] !== manifest.driver.tree) {
    throw new Error('V28 driver tree is not the frozen analyzer tree object')
  }
  exact(manifest.image?.manifestSha256, /^[0-9a-f]{64}$/, 'Docker manifest digest')
  exact(manifest.image?.configSha256, /^[0-9a-f]{64}$/, 'Docker config digest')
  if (manifest.image?.taskPublicSha256 !== manifest.task.digests.public) {
    throw new Error('V28 Docker image is not bound to the frozen public task bytes')
  }
  if (typeof manifest.image?.reference !== 'string'
    || !manifest.image.reference.endsWith(`@sha256:${manifest.image.manifestSha256}`)) {
    throw new Error('V28 Docker image must use the frozen manifest digest reference')
  }
  if (!same(manifest.model, V28_MODEL)
    || !same(manifest.budgetPerAttempt, V28_ATTEMPT_BUDGET)
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
    throw new Error('V28 model or arm contract differs from the frozen execution boundary')
  }
  return manifest
}

export async function readV28FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  return validateV28Manifest(JSON.parse(await readFile(path, 'utf8')))
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(canonicalJson(await readV28FrozenManifest()))
}
