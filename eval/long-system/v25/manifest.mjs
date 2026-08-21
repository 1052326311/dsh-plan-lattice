import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { V25_THRESHOLDS } from './analysis.mjs'

export const PROTOCOL_ID = 'plan-lattice-rc7-evocode-jobforge-v25'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = '5c1df23e8dd60821658dd6b1359dd68ffccd9c67'
export const CANDIDATE_TREE = '86c5c3e2da99922480a3f9a7e4f60aecb4d1e2bd'
export const CANDIDATE_TARBALL_SHA256 = '5a98b71630ab5694e1af3ecaf02e9cabae7256758109427697aea7f77c13a915'
export const EVOCODE_DATASET_COMMIT = '9fcae3e5539d1c0e85e2481fe06bd6af42cc4bc6'
export const EVOCODE_ARCHIVE_SHA256 = 'a13d0cb47574282372c59366217ac68d895ff49d1387c81098b058f739906184'
export const TASK_RELATIVE_PATH = 'evocodebench_wotraj/theme_d1_w1_code_build_greenfield_implementation'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
export const FROZEN_MANIFEST_PATH = join(root, 'frozen-manifest.json')

function exact(value, pattern, field) {
  if (!pattern.test(value ?? '')) throw new Error(`${field} is not an exact immutable identity`)
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

export function validateV25Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('V25 frozen manifest must be an object')
  }
  const { manifestDigest, ...body } = manifest
  exact(manifestDigest, /^[0-9a-f]{64}$/, 'manifest digest')
  if (sha256(body) !== manifestDigest) throw new Error('V25 frozen manifest digest mismatch')
  if (manifest.schemaVersion !== 1
    || manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-native-calibration'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidateExecutionInitiallyAllowed !== false
    || manifest.calibration?.nativeRuns !== V25_THRESHOLDS.requiredNativeAttempts
    || manifest.calibration?.candidateRunsMaximum !== 1
    || manifest.outputPolicy?.exclusiveCreate !== true
    || manifest.outputPolicy?.overwriteAllowed !== false) {
    throw new Error('V25 frozen manifest lost its execution or immutability gates')
  }
  if (!same(manifest.thresholds, V25_THRESHOLDS)) {
    throw new Error('V25 frozen manifest thresholds differ from the preregistered analyzer')
  }
  if (!same(manifest.terminalOutcomePolicy, {
    scorableTerminalKinds: ['completed', 'max-tokens'],
    officialVerifierAfterEveryProductTerminal: true,
    continueAfterMaxTokens: false,
    unreachedRoundsScoreZero: true,
    candidateMaxTokenProductTerminals: 0,
  })) {
    throw new Error('V25 terminal outcome policy differs from the preregistered analyzer')
  }
  if (!same(manifest.priorObservation, {
    protocolId: 'plan-lattice-rc7-evocode-jobforge-v24',
    runId: 'v24-2026-08-21t10-50-49-322z-387a51e3',
    attemptId: 'v24-2026-08-21t10-50-49-322z-387a51e3-native-1',
    resultClass: 'preregistered-negative',
    scoringStatus: 'unscored-by-v24-policy',
    terminalReason: 'max-tokens',
    candidateExecuted: false,
    manifestDigest: '955d16c1555591c3d39a34bb8eba6970d7a243103620cadec706e6dfa616f765',
    reportDigest: '720ded251769138e1bf9e7fcae20a8dd8f8101818e69e97dfebe8a63a55ab6af',
    initialWorkspaceSha256: 'c8b58996c19ec7f1f07471694146ad3afc578714495645060557f6c2b2f302ed',
    finalWorkspaceSha256: 'c8b58996c19ec7f1f07471694146ad3afc578714495645060557f6c2b2f302ed',
    usage: { agentRequests: 3, inputTokens: 22563, outputTokens: 33136, terminalOutputTokens: 32766 },
    sourceDigests: {
      finalReport: '45b33d962b583fe59195bfdaca3ebb8a42db734ac7068e60af60ff1c364bcc88',
      runEnvelope: '662c2e56d1c3292e3f70a5168e3332a02c6540672ae8cd3857357955d80cc98c',
      modelProxyAudit: '143c499b00dd2458de318df02fb99c96e7c790e4eb0bc144dc8c5f64dda250aa',
      budgetAudit: 'aaf743cc07d34262543613badbbdfb09d68ca45da0740ea548520dea8acc75f2',
      attemptFailure: '45aca696493bb0887b515081f047d63870d043e6147a29e8f290ec98ae262fda',
      harnessStderr: 'c7f5c45c6fdbb3c66d0a1366fe23a1e4e485fa6f3a58d4e50306bbbb62b46b29',
      session: '85696d0f4654051bbb344c0964e0e75ed4697afe169679fbe7234b768f459167',
    },
  })) {
    throw new Error('V25 prior observation provenance differs from the retained V24 result')
  }
  if (manifest.harness?.commit !== HARNESS_COMMIT
    || manifest.harness?.tag !== 'dsh-v0.1.0-rc.7'
    || manifest.harness?.runtimePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V25_HOST_RUNTIME') {
    throw new Error('V25 Harness identity is not the fixed rc.7 runtime')
  }
  exact(manifest.harness?.runtimeSha256, /^[0-9a-f]{64}$/, 'Harness runtime digest')
  if (manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.candidate?.tree !== CANDIDATE_TREE
    || manifest.candidate?.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate?.tarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.candidate?.packagePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V25_CANDIDATE_PACKAGE') {
    throw new Error('V25 candidate identity differs from the fixed rc.9 package')
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
    throw new Error('V25 candidate execution mode differs from the evaluated wrapper')
  }
  if (manifest.task?.datasetCommit !== EVOCODE_DATASET_COMMIT
    || manifest.task?.archiveSha256 !== EVOCODE_ARCHIVE_SHA256
    || manifest.task?.relativePath !== TASK_RELATIVE_PATH
    || manifest.task?.rootPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V25_TASK_ROOT'
    || manifest.task?.datasetPathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V25_DATASET_ROOT'
    || manifest.task?.archivePathEnvironmentVariable !== 'PLAN_LATTICE_LONG_SYSTEM_V25_DATASET_ARCHIVE'
    || manifest.task?.rounds !== 9) {
    throw new Error('V25 task identity differs from the fixed nine-round EvoCode task')
  }
  for (const [name, value] of Object.entries(manifest.task?.digests ?? {})) {
    exact(value, /^[0-9a-f]{64}$/, `task ${name} digest`)
  }
  if (!same(Object.keys(manifest.task?.digests ?? {}).sort(), ['hidden', 'oracle', 'public'])) {
    throw new Error('V25 task must freeze separate public, hidden, and oracle digests')
  }
  exact(manifest.task?.assetSha256, /^[0-9a-f]{64}$/, 'task asset digest')
  if (sha256(manifest.task.digests) !== manifest.task.assetSha256) {
    throw new Error('V25 task partition table does not match its asset digest')
  }
  exact(manifest.driver?.commit, /^[0-9a-f]{40}$/, 'driver commit')
  exact(manifest.driver?.tree, /^[0-9a-f]{40}$/, 'driver tree')
  exact(manifest.driver?.sourceDigest, /^[0-9a-f]{64}$/, 'driver source digest')
  if (sha256(manifest.driver?.sourceObjects ?? {}) !== manifest.driver.sourceDigest) {
    throw new Error('V25 driver object table does not match its source digest')
  }
  exact(manifest.image?.manifestSha256, /^[0-9a-f]{64}$/, 'Docker manifest digest')
  exact(manifest.image?.configSha256, /^[0-9a-f]{64}$/, 'Docker config digest')
  if (manifest.image?.taskPublicSha256 !== manifest.task.digests.public) {
    throw new Error('V25 Docker image is not bound to the frozen public task bytes')
  }
  if (typeof manifest.image?.reference !== 'string'
    || !manifest.image.reference.endsWith(`@sha256:${manifest.image.manifestSha256}`)) {
    throw new Error('V25 Docker image must use the frozen manifest digest reference')
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
    throw new Error('V25 model or arm contract differs from the frozen execution boundary')
  }
  return manifest
}

export async function readV25FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  return validateV25Manifest(JSON.parse(await readFile(path, 'utf8')))
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(canonicalJson(await readV25FrozenManifest()))
}
