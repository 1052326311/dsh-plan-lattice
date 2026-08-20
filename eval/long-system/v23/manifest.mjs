#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DRAFT_PROTOCOL_ID = 'plan-lattice-rc7-native-boundary-long-system-v23-draft-a'
export const PROTOCOL_ID = 'plan-lattice-rc7-native-boundary-long-system-v23'
export const HARNESS_COMMIT = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
export const CANDIDATE_COMMIT = '5c1df23e8dd60821658dd6b1359dd68ffccd9c67'
export const CANDIDATE_TREE = '86c5c3e2da99922480a3f9a7e4f60aecb4d1e2bd'
export const CANDIDATE_TARBALL_SHA256 = '5a98b71630ab5694e1af3ecaf02e9cabae7256758109427697aea7f77c13a915'

const root = resolve(dirname(fileURLToPath(import.meta.url)))
export const FROZEN_MANIFEST_PATH = join(root, 'frozen-manifest.json')
export const FREE_SMOKE_REPORT_PATH = join(root, 'FREE_SMOKE.json')
export const NATIVE_PILOT_REPORT_PATH = join(root, 'NATIVE_PILOT.json')

export async function readV23DraftManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.unfrozen.json'), 'utf8'))
  if (manifest.protocolId !== DRAFT_PROTOCOL_ID
    || manifest.status !== 'candidate-frozen-driver-unresolved'
    || manifest.executionAllowed !== false
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate.commit !== CANDIDATE_COMMIT
    || manifest.candidate.tree !== CANDIDATE_TREE
    || manifest.candidate.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate.verifiedTarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.harness.commit !== HARNESS_COMMIT
    || manifest.harness.runtimeSha256 !== 'UNRESOLVED_UNTIL_CODE_FREEZE') {
    throw new Error('V23 draft manifest lost its frozen candidate or mandatory execution block')
  }
  return manifest
}

export async function readV23FrozenManifest(path = FROZEN_MANIFEST_PATH) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest.protocolId !== PROTOCOL_ID
    || manifest.status !== 'preregistered-unexecuted'
    || manifest.executionAllowed !== true
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate?.commit !== CANDIDATE_COMMIT
    || manifest.candidate?.tree !== CANDIDATE_TREE
    || manifest.candidate?.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate?.verifiedTarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.harness?.commit !== HARNESS_COMMIT
    || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest ?? '')) {
    throw new Error('V23 frozen manifest is malformed or no longer execution-gated')
  }
  return manifest
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.stdout.write(`${JSON.stringify(await readV23DraftManifest(), null, 2)}\n`)
}
