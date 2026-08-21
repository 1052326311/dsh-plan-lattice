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
export const CEILING_NATIVE_PILOT_REPORT_PATH = join(root, 'NATIVE_PILOT_CEILING.json')

export async function readV23DraftManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.unfrozen.json'), 'utf8'))
  if (manifest.protocolId !== DRAFT_PROTOCOL_ID
    || manifest.status !== 'blocked-native-pilot-ceiling'
    || manifest.executionAllowed !== false
    || manifest.resultClaimsAllowed !== false
    || manifest.candidate.commit !== CANDIDATE_COMMIT
    || manifest.candidate.tree !== CANDIDATE_TREE
    || manifest.candidate.packageVersion !== '0.4.0-rc.9'
    || manifest.candidate.verifiedTarballSha256 !== CANDIDATE_TARBALL_SHA256
    || manifest.harness.commit !== HARNESS_COMMIT
    || manifest.harness.runtimeSha256 !== '54376394ae04c9458956449e12e24c7838b7646699e2779a93af1f855bc44334'
    || manifest.driver?.executionCommit !== '114b6dcfd099eedea862a24adca36533ee12383c'
    || manifest.driver?.executionTree !== '2b013e44f7bc5f6ea07ab16a5c15253ef2968c73'
    || manifest.freeSmoke?.path !== 'eval/long-system/v23/FREE_SMOKE.json'
    || manifest.freeSmoke?.fileSha256 !== '9f397a628ee5af7e2eb974f97ac2de0dc114ae7160d916a4fad004a6a23ffbcb'
    || manifest.freeSmoke?.status !== 'passed'
    || manifest.freeSmoke?.paidModelCalls !== 0
    || manifest.paidRuns !== 1
    || manifest.pilot?.path !== 'eval/long-system/v23/NATIVE_PILOT_CEILING.json'
    || manifest.pilot?.fileSha256 !== 'b2e3b00fd5e771c402b0ac2b3a55ce12f831cdd7412f31f6294149ca01f77ad7'
    || manifest.pilot?.reportDigest !== '6d3f93db0a111f7b0e6e232b3c98b9e3a1eb91fd6c184a0bad0a3b92f176afd6'
    || manifest.pilot?.completeLifecycle !== true
    || manifest.pilot?.budgetValid !== true
    || manifest.pilot?.nativeScore !== 100
    || manifest.pilot?.nonCeiling !== false
    || manifest.pilot?.pilotSuitableForPairFreeze !== false
    || JSON.stringify(manifest.unresolved) !== JSON.stringify(['native-pilot-ceiling-prevents-pair-freeze'])) {
    throw new Error('V23 blocked manifest lost frozen evidence or its native-ceiling execution block')
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
