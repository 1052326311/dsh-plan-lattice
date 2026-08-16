import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, chmod, cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildRuntimeArtifact,
  exactCommit,
  importFrozenRouter,
  verifyRuntimeArtifact,
} from '../eval/router-corpus/v8/runtime-artifact.mjs'

const root = process.cwd()
const v8 = join(root, 'eval/router-corpus/v8')
const generatedArtifact = join(v8, 'runtime')
let temporaryRoot: string
let artifactPath: string
let verified: Awaited<ReturnType<typeof verifyRuntimeArtifact>>

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
  if (!info.isDirectory()) {
    await chmod(path, 0o644)
    return
  }
  await chmod(path, 0o755)
  for (const entry of await readdir(path)) await makeWritable(join(path, entry))
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v8-test-'))
  try {
    verified = await verifyRuntimeArtifact(generatedArtifact)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    verified = await buildRuntimeArtifact(join(temporaryRoot, 'runtime'))
  }
  artifactPath = verified.artifactPath
}, 30_000)

afterAll(async () => {
  if (temporaryRoot !== undefined) {
    await makeWritable(temporaryRoot)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

describe('V8 frozen router runtime artifact', () => {
  it('builds the source and actual runtime import closure from the exact archived commit', async () => {
    expect(verified.manifest.exactCommit).toBe(exactCommit)
    expect(verified.manifest.sourceFiles).toEqual(['src/router.ts', 'src/task-invariants.ts'])
    expect(verified.manifest.runtimeFiles).toEqual(['lib/router.js', 'lib/task-invariants.js'])
    expect(verified.manifest.imports).toEqual({
      'lib/router.js': ['lib/task-invariants.js'],
      'lib/task-invariants.js': [],
    })

    for (const path of verified.manifest.sourceFiles) {
      expect(await readFile(join(artifactPath, path))).toEqual(gitBlob(path))
    }
    expect(verified.manifest.identities.lockfile).toEqual({
      path: 'pnpm-lock.yaml',
      sha256: sha256(gitBlob('pnpm-lock.yaml')),
    })
    expect(verified.manifest.identities.typescript.version).toMatch(/^5\./)
    expect(verified.manifest.identities.typescript.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verified.manifest.identities.node.version).toBe(process.version)
    expect(verified.manifest.identities.node.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verified.manifest.artifactSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('imports the evaluator runtime only from the verified read-only artifact path', async () => {
    expect(verified.entrypointPath).toBe(join(artifactPath, 'lib/router.js'))
    expect(verified.entrypointUrl).toBe(pathToFileURL(verified.entrypointPath).href)
    expect(verified.entrypointUrl).not.toBe(pathToFileURL(join(root, 'lib/router.js')).href)

    for (const path of ['manifest.json', 'src/router.ts', 'src/task-invariants.ts', 'lib/router.js', 'lib/task-invariants.js']) {
      expect((await lstat(join(artifactPath, path))).mode & 0o222).toBe(0)
    }
    expect((await lstat(artifactPath)).mode & 0o222).toBe(0)

    const compiledRouter = await readFile(verified.entrypointPath, 'utf8')
    expect(compiledRouter).toContain("from './task-invariants.js'")
    expect(compiledRouter).not.toContain(join(root, 'lib'))

    const router = await importFrozenRouter(artifactPath)
    expect(router.routeRequest('Do not use plan-lattice for this request.', {
      activationMode: 'auto',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
      longTaskThreshold: 8,
    })).toMatchObject({ phase: 'bypass', reasons: ['explicit bypass'] })
  })

  it('rejects a self-consistent manifest whose compiled runtime was changed', async () => {
    const tampered = join(temporaryRoot, 'tampered-runtime')
    await cp(artifactPath, tampered, { recursive: true })
    const routerPath = join(tampered, 'lib/router.js')
    const manifestPath = join(tampered, 'manifest.json')
    await chmod(tampered, 0o755)
    await chmod(join(tampered, 'lib'), 0o755)
    await chmod(routerPath, 0o644)
    await chmod(manifestPath, 0o644)
    await appendFile(routerPath, '\n// tampered\n')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const routerBody = await readFile(routerPath)
    manifest.files['lib/router.js'] = { bytes: routerBody.byteLength, sha256: sha256(routerBody) }
    const { artifactSha256: _oldDigest, ...core } = manifest
    manifest.artifactSha256 = sha256(canonical(core))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await chmod(routerPath, 0o444)
    await chmod(manifestPath, 0o444)
    await chmod(join(tampered, 'lib'), 0o555)
    await chmod(tampered, 0o555)

    await expect(verifyRuntimeArtifact(tampered)).rejects.toThrow('runtime artifact compiled file digest mismatch')
  })
})
