import assert from 'node:assert/strict'
import test from 'node:test'
import {
  inspectV27PublicManifestCommit,
  V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
  V27_MANIFEST_RELATIVE_PATH,
  V27_PUBLIC_REF,
  V27_PUBLIC_REMOTE_URL,
} from '../public-anchor.mjs'

const DRIVER_COMMIT = 'a'.repeat(40)
const MANIFEST_COMMIT = 'b'.repeat(40)
const MANIFEST_BLOB = 'c'.repeat(40)

function fixtureGit(overrides = {}) {
  return args => {
    const key = args.join(' ')
    if (key in overrides) return overrides[key]
    if (args[0] === 'rev-list') return `${MANIFEST_COMMIT} ${DRIVER_COMMIT}`
    if (args[0] === 'diff') return V27_MANIFEST_RELATIVE_PATH
    if (args[0] === 'rev-parse' && args[1] === `${MANIFEST_COMMIT}:${V27_MANIFEST_RELATIVE_PATH}`) return MANIFEST_BLOB
    if (args[0] === 'hash-object') return MANIFEST_BLOB
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return MANIFEST_COMMIT
    if (args[0] === 'remote') return 'git@github.com:1052326311/dsh-plan-lattice.git'
    if (args[0] === 'ls-remote') return `${MANIFEST_COMMIT}\t${V27_PUBLIC_REF}`
    return ''
  }
}

function manifest() {
  return {
    driver: { commit: DRIVER_COMMIT },
    publicationAnchor: {
      schemaVersion: 1,
      manifestPath: V27_MANIFEST_RELATIVE_PATH,
      commitEnvironmentVariable: V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE,
      publicRemoteUrl: V27_PUBLIC_REMOTE_URL,
      publicRef: V27_PUBLIC_REF,
      requiredBeforePaidRequest: true,
      singleParentOfDriverCommit: true,
      exactRemoteRefRequired: true,
      currentExactTagEqualityRequired: true,
      tagHistoryAuthority: 'current-remote-equality-only; historical immutability is operator-attested',
    },
  }
}

test('accepts only the public single-child commit containing the frozen manifest bytes', () => {
  assert.deepEqual(inspectV27PublicManifestCommit({
    manifest: manifest(),
    manifestPath: '/tmp/frozen-manifest.json',
    manifestCommit: MANIFEST_COMMIT,
    root: '/tmp/repository',
    requireExactHead: true,
    git: fixtureGit(),
  }), {
    manifestCommit: MANIFEST_COMMIT,
    manifestBlob: MANIFEST_BLOB,
    publicRef: V27_PUBLIC_REF,
  })
})

test('rejects a replaced manifest, extra commit change, or moved public ref', () => {
  for (const overrides of [
    { [`hash-object /tmp/frozen-manifest.json`]: 'd'.repeat(40) },
    { [`diff --name-only ${DRIVER_COMMIT} ${MANIFEST_COMMIT}`]: `${V27_MANIFEST_RELATIVE_PATH}\npackage.json` },
    { [`ls-remote ${V27_PUBLIC_REMOTE_URL} ${V27_PUBLIC_REF}`]: `${'e'.repeat(40)}\t${V27_PUBLIC_REF}` },
  ]) {
    assert.throws(() => inspectV27PublicManifestCommit({
      manifest: manifest(),
      manifestPath: '/tmp/frozen-manifest.json',
      manifestCommit: MANIFEST_COMMIT,
      root: '/tmp/repository',
      requireExactHead: true,
      git: fixtureGit(overrides),
    }))
  }
})
