#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DRAFT_PROTOCOL_ID = 'plan-lattice-rc7-native-boundary-long-system-v21-draft-a'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'

const root = resolve(dirname(fileURLToPath(import.meta.url)))

export async function readV21DraftManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.unfrozen.json'), 'utf8'))
  if (manifest.protocolId !== DRAFT_PROTOCOL_ID
    || manifest.status !== 'unfrozen-draft'
    || manifest.executionAllowed !== false
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate.commit !== 'UNRESOLVED_UNTIL_CODE_FREEZE'
    || manifest.harness.commit !== HARNESS_COMMIT
    || manifest.harness.runtimeSha256 !== 'UNRESOLVED_UNTIL_CODE_FREEZE') {
    throw new Error('V21 draft manifest lost its mandatory pre-freeze execution block')
  }
  return manifest
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(`${JSON.stringify(await readV21DraftManifest(), null, 2)}\n`)
}

