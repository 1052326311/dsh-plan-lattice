#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DRAFT_PROTOCOL_ID = 'plan-lattice-rc7-native-boundary-long-system-v21-draft-a'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = 'f9e3e245e629d1013e77dc10e67c06a4f1682a14'
export const CANDIDATE_TREE = '8c12c887ac1c99ffdc33518fc37fa9ba0fa818dd'
export const CANDIDATE_TARBALL_SHA256 = 'ac07771c8b98dccc6489184443d71e1f8680f0c132c71b551f574d8cd13273c4'

const root = resolve(dirname(fileURLToPath(import.meta.url)))

export async function readV21DraftManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.unfrozen.json'), 'utf8'))
  if (manifest.protocolId !== DRAFT_PROTOCOL_ID
    || manifest.status !== 'candidate-frozen-driver-unresolved'
    || manifest.executionAllowed !== false
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate.commit !== CANDIDATE_COMMIT
    || manifest.candidate.tree !== CANDIDATE_TREE
    || manifest.candidate.packageVersion !== '0.4.0-rc.8'
    || manifest.candidate.verifiedTarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.harness.commit !== HARNESS_COMMIT
    || manifest.harness.runtimeSha256 !== 'UNRESOLVED_UNTIL_CODE_FREEZE') {
    throw new Error('V21 draft manifest lost its frozen candidate or mandatory execution block')
  }
  return manifest
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(`${JSON.stringify(await readV21DraftManifest(), null, 2)}\n`)
}
