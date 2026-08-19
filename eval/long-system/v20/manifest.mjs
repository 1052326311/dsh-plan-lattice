#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DRAFT_PROTOCOL_ID = 'plan-lattice-rc7-native-foreground-long-system-v20-draft-a'
export const PROTOCOL_ID = 'plan-lattice-rc7-native-foreground-long-system-v20'
export const CANDIDATE_COMMIT = '41b315f6f77a8b660018d4b67cfb095eea5adde4'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
export const FROZEN_MANIFEST_PATH = join(root, 'frozen-manifest.json')
export const FREE_SMOKE_REPORT_PATH = join(root, 'FREE_SMOKE.json')

export async function readV20DraftManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.unfrozen.json'), 'utf8'))
  if (manifest.protocolId !== DRAFT_PROTOCOL_ID
    || manifest.status !== 'unfrozen-draft'
    || manifest.executionAllowed !== false
    || manifest.candidate.commit !== 'UNRESOLVED_UNTIL_CODE_FREEZE'
    || manifest.harness.commit !== HARNESS_COMMIT
    || manifest.harness.runtimeSha256 !== 'UNRESOLVED_UNTIL_CODE_FREEZE') {
    throw new Error('V20 draft manifest lost its mandatory unfrozen execution block')
  }
  return manifest
}

export async function readV20FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-unexecuted'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.harness?.commit !== HARNESS_COMMIT
    || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest ?? '')) {
    throw new Error('V20 frozen manifest is malformed or no longer execution-gated')
  }
  return manifest
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const manifest = await readV20DraftManifest()
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}
