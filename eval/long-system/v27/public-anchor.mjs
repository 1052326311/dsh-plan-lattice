import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isolatedGit } from './git-safety.mjs'

export const V27_MANIFEST_RELATIVE_PATH = 'eval/long-system/v27/frozen-manifest.json'
export const V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE = 'PLAN_LATTICE_LONG_SYSTEM_V27_MANIFEST_COMMIT'
export const V27_PUBLIC_REMOTE_URL = 'https://github.com/1052326311/dsh-plan-lattice'
export const V27_PUBLIC_REF = 'refs/tags/v27-native-continuity-prereg-20260822'

function command(root, args) {
  return isolatedGit(root, args)
}

function normalizeRemote(value) {
  const ssh = String(value ?? '').match(/^git@github\.com:(.+?)(?:\.git)?$/u)
  if (ssh) return `https://github.com/${ssh[1]}`
  return String(value ?? '').replace(/\.git$/u, '').replace(/\/$/u, '')
}

export function inspectV27PublicManifestCommit({
  manifest,
  manifestPath,
  manifestCommit,
  root,
  requireExactHead = false,
  git,
}) {
  if (!/^[0-9a-f]{40}$/u.test(manifestCommit ?? '')) {
    throw new Error('V27 manifest commit must be an exact Git commit')
  }
  const anchor = manifest?.publicationAnchor
  if (anchor?.manifestPath !== V27_MANIFEST_RELATIVE_PATH
    || anchor?.commitEnvironmentVariable !== V27_MANIFEST_COMMIT_ENVIRONMENT_VARIABLE
    || anchor?.publicRemoteUrl !== V27_PUBLIC_REMOTE_URL
    || anchor?.publicRef !== V27_PUBLIC_REF
    || anchor?.requiredBeforePaidRequest !== true
    || anchor?.singleParentOfDriverCommit !== true
    || anchor?.exactRemoteRefRequired !== true
    || anchor?.currentExactTagEqualityRequired !== true
    || anchor?.tagHistoryAuthority !== 'current-remote-equality-only; historical immutability is operator-attested'
    || !V27_PUBLIC_REF.startsWith('refs/tags/')) {
    throw new Error('V27 manifest has no valid public pre-execution anchor policy')
  }

  const localGit = args => command(root, args)
  const injected = typeof git === 'function'
  const remoteRoot = injected ? null : mkdtempSync(join(tmpdir(), 'plan-lattice-v27-public-anchor-'))
  let authoritativeGit = git
  try {
    if (!injected) {
      isolatedGit(remoteRoot, ['init', '--bare', '--quiet'])
      const remoteRows = isolatedGit(remoteRoot, ['ls-remote', V27_PUBLIC_REMOTE_URL, V27_PUBLIC_REF])
        .split(/\r?\n/u).filter(Boolean)
      if (remoteRows.length !== 1 || remoteRows[0] !== `${manifestCommit}\t${V27_PUBLIC_REF}`) {
        throw new Error('V27 public tag does not resolve to the exact manifest commit')
      }
      isolatedGit(remoteRoot, [
        'fetch', '--quiet', '--no-tags', '--depth=2', V27_PUBLIC_REMOTE_URL,
        `+${V27_PUBLIC_REF}:refs/v27/public`,
      ])
      if (isolatedGit(remoteRoot, ['rev-parse', 'refs/v27/public^{commit}']) !== manifestCommit) {
        throw new Error('V27 fetched public tag does not contain the exact manifest commit')
      }
      authoritativeGit = (args, options) => isolatedGit(remoteRoot, args, options)
    }

    authoritativeGit(['cat-file', '-e', `${manifestCommit}^{commit}`])
    const lineage = authoritativeGit(['rev-list', '--parents', '-n', '1', manifestCommit]).split(/\s+/u)
    if (lineage.length !== 2 || lineage[1] !== manifest.driver.commit) {
      throw new Error('V27 manifest commit must be the single direct child of the frozen driver commit')
    }
    const changed = authoritativeGit(['diff', '--name-only', manifest.driver.commit, manifestCommit])
      .split(/\r?\n/u).filter(Boolean)
    if (changed.length !== 1 || changed[0] !== V27_MANIFEST_RELATIVE_PATH) {
      throw new Error('V27 manifest commit must change only the frozen manifest')
    }
    const committedBlob = authoritativeGit(['rev-parse', `${manifestCommit}:${V27_MANIFEST_RELATIVE_PATH}`])
    const manifestBytesMatch = injected
      ? committedBlob === authoritativeGit(['hash-object', resolve(manifestPath)])
      : Buffer.compare(
          authoritativeGit(['cat-file', 'blob', committedBlob], { encoding: null }),
          readFileSync(resolve(manifestPath)),
        ) === 0
    if (!manifestBytesMatch) {
      throw new Error('V27 manifest bytes differ from the public manifest commit')
    }
    const head = injected ? authoritativeGit(['rev-parse', 'HEAD']) : localGit(['rev-parse', 'HEAD'])
    if (requireExactHead && head !== manifestCommit) {
      throw new Error('V27 paid execution must run from the exact public manifest commit')
    }
    if (!requireExactHead) {
      const ancestryGit = injected ? authoritativeGit : localGit
      ancestryGit(['merge-base', '--is-ancestor', manifestCommit, head])
    }

    const origin = normalizeRemote(injected
      ? authoritativeGit(['remote', 'get-url', 'origin'])
      : localGit(['remote', 'get-url', 'origin']))
    if (origin !== V27_PUBLIC_REMOTE_URL) {
      throw new Error('V27 checkout origin is not the frozen public repository')
    }
    if (injected) {
      const remoteRows = authoritativeGit(['ls-remote', V27_PUBLIC_REMOTE_URL, V27_PUBLIC_REF])
        .split(/\r?\n/u).filter(Boolean)
      if (remoteRows.length !== 1 || remoteRows[0] !== `${manifestCommit}\t${V27_PUBLIC_REF}`) {
        throw new Error('V27 public tag does not resolve to the exact manifest commit')
      }
    }
    return { manifestCommit, manifestBlob: committedBlob, publicRef: V27_PUBLIC_REF }
  } finally {
    if (remoteRoot !== null) rmSync(remoteRoot, { recursive: true, force: true })
  }
}
