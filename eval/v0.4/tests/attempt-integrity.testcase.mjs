import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESULT_CHAIN_GENESIS,
  digestAttemptArtifacts,
  digestResultRecord,
  renderControllerReceipt,
  verifyAttemptReceipts,
} from '../lib/attempt-integrity.mjs'
import { canonicalJson, sha256 } from '../lib/canonical.mjs'

test('result records are bound to an ordered chain and exact attempt artifacts', async () => {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-attempt-integrity-'))
  const resultsPath = join(root, 'results.jsonl')
  const attemptId = 'attempt-1'
  const attemptDir = join(root, 'attempts', attemptId)
  await mkdir(attemptDir, { recursive: true })
  const logPath = join(attemptDir, 'driver.stdout.log')
  await writeFile(logPath, '{"status":"completed"}\n', 'utf8')
  const payload = { status: 'completed' }
  await writeFile(join(attemptDir, 'controller-payload.json'), canonicalJson(payload), 'utf8')
  const record = {
    attemptId,
    runId: 'run-1',
    attempt: 1,
    manifestDigest: 'a'.repeat(64),
    artifactDigest: await digestAttemptArtifacts(attemptDir),
    status: 'completed',
    driverPayloadDigest: sha256(payload),
    driverStdoutDigest: sha256(Buffer.from('{"status":"completed"}\n')),
    previousRecordDigest: RESULT_CHAIN_GENESIS,
  }
  const receipt = renderControllerReceipt(record)
  await writeFile(join(attemptDir, 'controller-receipt.json'), canonicalJson(receipt), 'utf8')
  record.controllerReceiptDigest = sha256(receipt)
  record.recordDigest = digestResultRecord(record)
  record.recordSignature = sign(null, Buffer.from(record.recordDigest, 'hex'), keys.privateKey).toString('base64')
  assert.deepEqual(await verifyAttemptReceipts([record], resultsPath, publicKey), [])
  const forged = { ...record, status: 'failed' }
  forged.recordDigest = digestResultRecord(forged)
  assert.match((await verifyAttemptReceipts([forged], resultsPath, publicKey)).join('\n'), /record signature mismatch/)

  await writeFile(logPath, '{"status":"tampered"}\n', 'utf8')
  assert.match((await verifyAttemptReceipts([record], resultsPath, publicKey)).join('\n'), /artifact digest mismatch/)
  await writeFile(logPath, '{"status":"completed"}\n', 'utf8')
  await writeFile(join(attemptDir, 'controller-payload.json'), canonicalJson({ status: 'failed' }), 'utf8')
  const payloadErrors = (await verifyAttemptReceipts([record], resultsPath, publicKey)).join('\n')
  assert.match(payloadErrors, /controller payload digest mismatch/)
  assert.match(payloadErrors, /controller payload content mismatch/)
  const external = join(root, 'external.txt')
  await writeFile(external, 'mutable outside the attempt', 'utf8')
  await symlink(external, join(attemptDir, 'external-link'))
  await assert.rejects(digestAttemptArtifacts(attemptDir), /symlink escapes/)
  await rm(root, { recursive: true, force: true })
})
