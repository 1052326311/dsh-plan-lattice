import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildFrozenRuntimeArtifact,
  exactCommit,
  exactTree,
  frozenNodeVersion,
  frozenTypeScriptVersion,
  importFrozenRouter,
  verifyFrozenRuntimeArtifact,
} from '../eval/router-corpus/v13/runtime-artifact.mjs'

const root = process.cwd()
let temporaryRoot: string
let artifactPath: string
let verified: Awaited<ReturnType<typeof verifyFrozenRuntimeArtifact>>

function gitBlob(path: string): Buffer {
  return execFileSync('git', ['show', `${exactCommit}:${path}`], { cwd: root })
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path)
  await chmod(path, info.isDirectory() ? 0o755 : 0o644)
  if (info.isDirectory()) for (const entry of await readdir(path)) await makeWritable(join(path, entry))
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v13-runtime-test-'))
  const sourceMarker = join(root, 'src/router-v13-untracked-marker.ts')
  try {
    await writeFile(sourceMarker, 'export const worktreeOnly = true\n', { flag: 'wx' })
    verified = await buildFrozenRuntimeArtifact(join(temporaryRoot, 'runtime'))
    artifactPath = verified.artifactPath
  } finally {
    await unlink(sourceMarker).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}, 30_000)

afterAll(async () => {
  if (temporaryRoot !== undefined) {
    await makeWritable(temporaryRoot)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

describe('V13 frozen router runtime artifact', () => {
  it('compiles only the exact git-archived closure with the frozen toolchain', async () => {
    expect(verified.manifest.exactCommit).toBe(exactCommit)
    expect(verified.manifest.exactTree).toBe(exactTree)
    expect(execFileSync('git', ['rev-parse', `${exactCommit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()).toBe(exactTree)
    expect(verified.manifest.sourceFiles).toEqual(['src/router.ts', 'src/task-invariants.ts'])
    expect(verified.manifest.runtimeFiles).toEqual(['lib/router.js', 'lib/task-invariants.js'])
    expect(verified.manifest.imports).toEqual({
      'lib/router.js': ['lib/task-invariants.js'],
      'lib/task-invariants.js': [],
    })

    for (const path of verified.manifest.sourceFiles) {
      expect(await readFile(join(artifactPath, path))).toEqual(gitBlob(path))
    }
    expect(verified.manifest.files['src/router-v13-untracked-marker.ts']).toBeUndefined()
    expect(verified.manifest.identities.lockfile.sha256).toBe(sha256(gitBlob('pnpm-lock.yaml')))
    expect(verified.manifest.identities.typescript.version).toBe(frozenTypeScriptVersion)
    expect(verified.manifest.identities.typescript.compilerSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(verified.manifest.identities.node.version).toBe(frozenNodeVersion)
    expect(verified.manifest.identities.node.executableSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(verified.manifest.archive.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(verified.manifest.digests).toEqual({
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      compiledSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      artifactTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
  })

  it('imports routeRequest only through the verified read-only artifact', async () => {
    expect(verified.entrypointPath).toBe(join(artifactPath, 'lib/router.js'))
    expect(verified.entrypointUrl).toContain(pathToFileURL(verified.entrypointPath).href)
    expect(verified.entrypointUrl).not.toContain(pathToFileURL(join(root, 'lib/router.js')).href)
    for (const path of ['manifest.json', 'src/router.ts', 'src/task-invariants.ts', 'lib/router.js', 'lib/task-invariants.js']) {
      expect((await lstat(join(artifactPath, path))).mode & 0o222).toBe(0)
    }
    expect((await lstat(artifactPath)).mode & 0o222).toBe(0)

    const router = await importFrozenRouter(artifactPath)
    expect(router.routeRequest('Do not use Plan Lattice for this request.', {
      activationMode: 'auto',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
      longTaskThreshold: 8,
    })).toMatchObject({ phase: 'bypass', reasons: ['explicit bypass'] })
  })

  it('rejects a self-consistent manifest after compiled runtime tampering', async () => {
    const tampered = join(temporaryRoot, 'tampered-runtime')
    await cp(artifactPath, tampered, { recursive: true })
    const routerPath = join(tampered, 'lib/router.js')
    const manifestPath = join(tampered, 'manifest.json')
    await chmod(tampered, 0o755)
    await chmod(join(tampered, 'lib'), 0o755)
    await chmod(routerPath, 0o644)
    await chmod(manifestPath, 0o644)
    await appendFile(routerPath, '\n// self-consistent tamper\n')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const routerBody = await readFile(routerPath)
    manifest.files['lib/router.js'] = { bytes: routerBody.byteLength, sha256: sha256(routerBody) }
    const compiledFiles = Object.fromEntries(manifest.runtimeFiles.map((path: string) => [path, manifest.files[path]]))
    manifest.digests.compiledSha256 = sha256(canonical(compiledFiles))
    manifest.digests.artifactTreeSha256 = sha256(canonical(manifest.files))
    const { artifactSha256: _old, ...core } = manifest
    manifest.artifactSha256 = sha256(canonical(core))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await chmod(routerPath, 0o444)
    await chmod(manifestPath, 0o444)
    await chmod(join(tampered, 'lib'), 0o555)
    await chmod(tampered, 0o555)

    await expect(verifyFrozenRuntimeArtifact(tampered)).rejects.toThrow('frozen digest mismatch')
  })
})
