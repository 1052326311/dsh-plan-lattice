import { createPublicKey, verify } from 'node:crypto'
import { readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { canonicalJson, canonicalize, sha256 } from './canonical.mjs'

export const RESULT_CHAIN_GENESIS = '0'.repeat(64)
const RECEIPT_NAME = 'controller-receipt.json'

async function entriesUnder(root, directory = root) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  const output = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const name = relative(root, path)
    if (name === RECEIPT_NAME) continue
    if (entry.isDirectory()) output.push(...await entriesUnder(root, path))
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path)
      const actual = await realpath(path)
      const resolvedRoot = resolve(root)
      if (actual !== resolvedRoot && !actual.startsWith(`${resolvedRoot}/`)) {
        throw new Error(`attempt artifact symlink escapes the retained tree: ${name}`)
      }
      output.push({ path: name, kind: 'symlink', digest: sha256(target), target: relative(resolvedRoot, actual) })
    }
    else if (entry.isFile()) output.push({ path: name, kind: 'file', digest: sha256(await readFile(path)) })
    else throw new Error(`unsupported attempt artifact type: ${name}`)
  }
  return output
}

export async function digestAttemptArtifacts(attemptDir) {
  return sha256(await entriesUnder(attemptDir))
}

export function digestResultRecord(record) {
  const { recordDigest: _recordDigest, recordSignature: _recordSignature, ...content } = record
  return sha256(content)
}

export function verifyResultChain(records, publicKeySpkiBase64) {
  const errors = []
  let publicKey
  if (publicKeySpkiBase64) {
    try {
      publicKey = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    } catch {
      errors.push('result signing public key is invalid')
    }
  }
  let previous = RESULT_CHAIN_GENESIS
  for (const record of records) {
    if (record.previousRecordDigest !== previous) errors.push(`result chain predecessor mismatch for ${record.attemptId}`)
    const expected = digestResultRecord(record)
    if (record.recordDigest !== expected) errors.push(`result record digest mismatch for ${record.attemptId}`)
    if (publicKey && !verify(null, Buffer.from(record.recordDigest, 'hex'), publicKey, Buffer.from(record.recordSignature ?? '', 'base64'))) {
      errors.push(`result record signature mismatch for ${record.attemptId}`)
    }
    previous = record.recordDigest
  }
  return errors
}

export async function verifyAttemptReceipts(records, resultsPath, publicKeySpkiBase64) {
  const errors = [...verifyResultChain(records, publicKeySpkiBase64)]
  const attemptsRoot = join(dirname(resultsPath), 'attempts')
  for (const record of records) {
    const attemptDir = join(attemptsRoot, record.attemptId)
    try {
      const receipt = JSON.parse(await readFile(join(attemptDir, RECEIPT_NAME), 'utf8'))
      const controllerPayload = JSON.parse(await readFile(join(attemptDir, 'controller-payload.json'), 'utf8'))
      const driverStdout = await readFile(join(attemptDir, 'driver.stdout.log'))
      const artifactDigest = await digestAttemptArtifacts(attemptDir)
      if (artifactDigest !== record.artifactDigest) errors.push(`attempt artifact digest mismatch for ${record.attemptId}`)
      if (sha256(controllerPayload) !== record.driverPayloadDigest) errors.push(`controller payload digest mismatch for ${record.attemptId}`)
      if (sha256(driverStdout) !== record.driverStdoutDigest) errors.push(`driver stdout digest mismatch for ${record.attemptId}`)
      if (sha256(receipt) !== record.controllerReceiptDigest) errors.push(`controller receipt digest mismatch for ${record.attemptId}`)
      const expectedPayload = {
        status: record.status,
        ...(record.failure ? { failure: record.failure } : {}),
        ...(record.metrics ? { metrics: record.metrics } : {}),
        ...(record.provenance ? { provenance: record.provenance } : {}),
      }
      if (canonicalJson(controllerPayload) !== canonicalJson(expectedPayload)) {
        errors.push(`controller payload content mismatch for ${record.attemptId}`)
      }
      for (const key of ['attemptId', 'runId', 'attempt', 'manifestDigest', 'artifactDigest', 'driverPayloadDigest', 'driverStdoutDigest', 'previousRecordDigest']) {
        if (receipt[key] !== record[key]) errors.push(`controller receipt ${key} mismatch for ${record.attemptId}`)
      }
      if (receipt.schemaVersion !== 1) errors.push(`controller receipt schema mismatch for ${record.attemptId}`)
    } catch (error) {
      errors.push(`attempt artifacts unavailable for ${record.attemptId}: ${String(error?.message ?? error)}`)
    }
  }
  return errors
}

export function renderControllerReceipt(record) {
  return {
    schemaVersion: 1,
    attemptId: record.attemptId,
    runId: record.runId,
    attempt: record.attempt,
    manifestDigest: record.manifestDigest,
    artifactDigest: record.artifactDigest,
    driverPayloadDigest: record.driverPayloadDigest,
    driverStdoutDigest: record.driverStdoutDigest,
    previousRecordDigest: record.previousRecordDigest,
  }
}

export function canonicalRecord(record) {
  return `${JSON.stringify(canonicalize(record))}\n`
}
