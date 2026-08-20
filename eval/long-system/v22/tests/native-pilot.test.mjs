import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256 } from '../../../v0.4/lib/canonical.mjs'
import { readNativePilot } from '../freeze.mjs'
import { NATIVE_PILOT_REPORT_PATH } from '../manifest.mjs'

const taskBytes = await readFile(new URL('../task.json', import.meta.url))
const task = JSON.parse(taskBytes.toString('utf8'))
const report = JSON.parse(await readFile(NATIVE_PILOT_REPORT_PATH, 'utf8'))
const input = {
  task,
  taskBytes,
  hostRuntimeSha256: report.hostRuntimeSha256,
  driverCommit: report.driverCommit,
}

test('accepts the exact non-ceiling native pilot selected for V22', async () => {
  const result = await readNativePilot(input)
  assert.equal(result.report.reportDigest, report.reportDigest)
  assert.equal(result.report.grade.score, 87)
  assert.equal(result.report.result.surfaceReplacements, 3)
  assert.equal(result.report.continuity.valid, true)
})

test('rejects a self-consistent pilot receipt that did not complete the lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v22-pilot-test-'))
  try {
    const tampered = structuredClone(report)
    tampered.completeLifecycle = false
    const { reportDigest: ignored, ...body } = tampered
    tampered.reportDigest = sha256(body)
    const path = join(root, 'pilot.json')
    await writeFile(path, canonicalJson(tampered), 'utf8')
    await assert.rejects(readNativePilot(input, path), /incomplete, inconsistent, or no longer non-ceiling/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
