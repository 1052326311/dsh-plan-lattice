import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configureProfile as configureBaseProfile } from '../../../v0.4/driver/lib/profile.mjs'

/**
 * V11-only profile augmentation. V10 is an immutable negative result and uses
 * the shared profile driver, so experimental config belongs here rather than
 * changing that shared source.
 */
export async function configureProfile(options) {
  const result = await configureBaseProfile(options)
  const value = options.arm?.maxTokenContinuations
  if (value === undefined) return result
  assert.ok(Number.isInteger(value) && value >= 0, 'maxTokenContinuations must be a non-negative integer')
  assert.ok(result.pluginConfig !== undefined, 'a continuation setting requires the candidate plugin')

  const patchPath = join(result.profileDir, 'cordis.patch.yml')
  const patch = await readFile(patchPath, 'utf8')
  const configStart = patch.indexOf('- id: plan-lattice\n  config:\n')
  assert.notEqual(configStart, -1, 'candidate profile has no Plan Lattice config block')
  const nextBlock = patch.indexOf('\n- id:', configStart + 1)
  const blockEnd = nextBlock === -1 ? patch.length : nextBlock + 1
  const block = patch.slice(configStart, blockEnd)
  assert.equal(/\n    maxTokenContinuations:/.test(block), false, 'candidate profile already controls maxTokenContinuations')
  const rewritten = `${patch.slice(0, blockEnd).replace(/\n$/, '')}\n    maxTokenContinuations: ${value}\n${patch.slice(blockEnd)}`
  await writeFile(patchPath, rewritten, 'utf8')
  return { ...result, pluginConfig: { ...result.pluginConfig, maxTokenContinuations: value } }
}
