import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyPlanLattice } from 'dsh-plan-lattice'
import { installLongSystemBoundary } from './common-boundary.js'
import { workspaceShellAdapter } from './workspace-shell-adapter.js'

export const name = 'plan-lattice'
export const inject = ['tools']

const ACTIVATION_IDENTITY_ENV = 'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_IDENTITY_JSON'
const ACTIVATION_PROCESS_ENV = 'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_PROCESS_JSON'
const ACTIVATION_RECEIPT_PATH_ENV = 'DSH_PLAN_LATTICE_CANDIDATE_ACTIVATION_RECEIPT_PATH'
const adapterModule = 'workspace-shell-adapter.js'
const configKeys = ['activationMode', 'clarificationPolicy', 'controlCeiling']
const identityKeys = [
  'attemptId',
  'wrapperPackageSha256',
  'candidateCommit',
  'candidateVersion',
  'candidatePackageSha256',
  'candidatePayloadSha256',
]
const processKeys = ['epoch', 'epochSha256', 'processNonce']

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value)
  return createHash('sha256').update(bytes).digest('hex')
}

function activationConfig(config) {
  if (!hasExactKeys(config, configKeys)) {
    throw new Error('candidate activation config differs from the frozen wrapper contract')
  }
  return {
    activationMode: config.activationMode,
    clarificationPolicy: config.clarificationPolicy,
    controlCeiling: config.controlCeiling,
    strictBash: true,
    preconditionAdapter: 'workspace-shell-adapter',
  }
}

function activationIdentityFromEnvironment(environment = process.env) {
  let identity
  let activationProcess
  try {
    identity = JSON.parse(environment[ACTIVATION_IDENTITY_ENV] ?? '')
    activationProcess = JSON.parse(environment[ACTIVATION_PROCESS_ENV] ?? '')
  } catch {
    throw new Error('candidate activation process identity is missing or malformed')
  }
  const receiptPath = environment[ACTIVATION_RECEIPT_PATH_ENV]
  if (!isAbsolute(receiptPath ?? '')
    || !hasExactKeys(identity, identityKeys)
    || identity.attemptId !== environment.DSH_PLAN_LATTICE_EVAL_ATTEMPT_ID
    || !/^[0-9a-f]{64}$/.test(identity.wrapperPackageSha256 ?? '')
    || !/^[0-9a-f]{40}$/.test(identity.candidateCommit ?? '')
    || typeof identity.candidateVersion !== 'string'
    || identity.candidateVersion.length === 0
    || !/^[0-9a-f]{64}$/.test(identity.candidatePackageSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(identity.candidatePayloadSha256 ?? '')
    || !hasExactKeys(activationProcess, processKeys)
    || !Number.isSafeInteger(activationProcess.epoch)
    || activationProcess.epoch < 1
    || !/^[0-9a-f]{64}$/.test(activationProcess.epochSha256 ?? '')
    || !/^[0-9a-f]{64}$/.test(activationProcess.processNonce ?? '')) {
    throw new Error('candidate activation receipt is not bound to the current attempt')
  }
  return { identity, activationProcess, receiptPath }
}

export function buildCandidateActivationReceipt(identity, activationProcess, config, adapterBytes = readFileSync(
  fileURLToPath(new URL(adapterModule, import.meta.url)),
)) {
  const effectiveConfig = activationConfig(config)
  const body = {
    schemaVersion: 2,
    attemptId: identity?.attemptId,
    epoch: activationProcess?.epoch,
    epochSha256: activationProcess?.epochSha256,
    processPid: process.pid,
    processNonce: activationProcess?.processNonce,
    wrapperPackageSha256: identity?.wrapperPackageSha256,
    candidateCommit: identity?.candidateCommit,
    candidateVersion: identity?.candidateVersion,
    candidatePackageSha256: identity?.candidatePackageSha256,
    candidatePayloadSha256: identity?.candidatePayloadSha256,
    config: effectiveConfig,
    configSha256: sha256(effectiveConfig),
    bashAdapter: {
      module: adapterModule,
      sha256: sha256(adapterBytes),
    },
  }
  return { ...body, activationReceiptDigest: sha256(body) }
}

export function persistCandidateActivationReceipt(path, receipt) {
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8')
  let descriptor
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!readFileSync(path).equals(bytes)) {
      throw new Error('candidate activation receipt differs within one Harness process')
    }
    return receipt
  }
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
  return receipt
}

export function apply(ctx, config = {}) {
  const { identity, activationProcess, receiptPath } = activationIdentityFromEnvironment()
  const receipt = buildCandidateActivationReceipt(identity, activationProcess, config)
  const effectiveConfig = {
    ...config,
    strictBash: true,
    preconditionAdapters: {
      ...config.preconditionAdapters,
      bash: workspaceShellAdapter,
    },
  }
  installLongSystemBoundary(ctx)
  applyPlanLattice(ctx, effectiveConfig)
  persistCandidateActivationReceipt(receiptPath, receipt)
}
