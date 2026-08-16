import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)

export const exactCommit = '3d34a2e6fe71870caedb0bedecd53cfdb38195ef'
export const sourceFiles = ['src/router.ts', 'src/task-invariants.ts']
export const artifactEntrypoint = 'lib/router.js'
export const artifactManifest = 'manifest.json'
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const artifactKind = 'dsh-plan-lattice-router-runtime'
const lockfilePath = 'pnpm-lock.yaml'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function identity(value) {
  return { ...value, sha256: sha256(canonical(value)) }
}

async function run(command, args, options = {}) {
  return execFile(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function resolvedCommit() {
  const { stdout } = await run('git', ['rev-parse', '--verify', `${exactCommit}^{commit}`], {
    cwd: repositoryRoot,
  })
  const resolved = stdout.trim()
  if (resolved !== exactCommit) throw new Error(`V10 runtime commit resolved to ${resolved}, expected ${exactCommit}`)
  return resolved
}

function nodeIdentity() {
  return identity({
    version: process.version,
    release: process.release.name,
    platform: process.platform,
    arch: process.arch,
    modules: process.versions.modules,
    napi: process.versions.napi,
    v8: process.versions.v8,
    uv: process.versions.uv,
    openssl: process.versions.openssl,
  })
}

async function loadTypeScript() {
  const requireFromRepository = createRequire(join(repositoryRoot, 'package.json'))
  const packagePath = requireFromRepository.resolve('typescript/package.json')
  const compilerPath = requireFromRepository.resolve('typescript')
  const [packageBody, compilerBody] = await Promise.all([
    readFile(packagePath),
    readFile(compilerPath),
  ])
  const packageJson = JSON.parse(packageBody.toString('utf8'))
  const summary = identity({
    name: packageJson.name,
    version: packageJson.version,
    packageSha256: sha256(packageBody),
    compilerSha256: sha256(compilerBody),
  })
  return { typescript: requireFromRepository('typescript'), summary }
}

function lockedTypeScriptVersion(lockfile) {
  const match = lockfile.match(/(?:^|\n)      typescript:\r?\n        specifier: [^\r\n]+\r?\n        version: ([^\s(]+)/)
  if (match === null) throw new Error('the archived lockfile does not pin the root TypeScript dependency')
  return match[1]
}

async function extractCommit(checkoutRoot) {
  const archivePath = join(checkoutRoot, 'commit.tar')
  const checkout = join(checkoutRoot, 'checkout')
  await mkdir(checkout)
  await run('git', ['archive', '--format=tar', '--output', archivePath, exactCommit], {
    cwd: repositoryRoot,
  })
  await run('tar', ['-xf', archivePath, '-C', checkout])
  return checkout
}

function formatDiagnostics(typescript, diagnostics, checkout) {
  return typescript.formatDiagnostics(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => checkout,
    getNewLine: () => '\n',
  })
}

async function compileRouter(checkout, typescript) {
  const configPath = join(checkout, 'tsconfig.json')
  const config = typescript.readConfigFile(configPath, typescript.sys.readFile)
  if (config.error !== undefined) {
    throw new Error(`cannot read archived tsconfig.json:\n${formatDiagnostics(typescript, [config.error], checkout)}`)
  }
  const parsed = typescript.parseJsonConfigFileContent(config.config, typescript.sys, checkout, {
    outDir: join(checkout, 'lib'),
    rootDir: join(checkout, 'src'),
  }, configPath)
  if (parsed.errors.length > 0) {
    throw new Error(`archived TypeScript configuration is invalid:\n${formatDiagnostics(typescript, parsed.errors, checkout)}`)
  }

  const roots = sourceFiles.map(path => join(checkout, path))
  const program = typescript.createProgram(roots, parsed.options)
  const emit = program.emit()
  const diagnostics = [...typescript.getPreEmitDiagnostics(program), ...emit.diagnostics]
  if (emit.emitSkipped || diagnostics.length > 0) {
    throw new Error(`frozen router compilation failed:\n${formatDiagnostics(typescript, diagnostics, checkout)}`)
  }
}

function resolveRuntimeImport(importer, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    throw new Error(`${importer} imports non-artifact runtime dependency ${JSON.stringify(specifier)}`)
  }
  const imported = posix.normalize(posix.join(posix.dirname(importer), specifier))
  if (imported === 'lib' || !imported.startsWith('lib/')) {
    throw new Error(`${importer} imports outside the artifact lib directory: ${JSON.stringify(specifier)}`)
  }
  return imported
}

async function collectRuntimeClosure(root, typescript) {
  const pending = [artifactEntrypoint]
  const visited = new Set()
  const imports = {}

  while (pending.length > 0) {
    const path = pending.shift()
    if (visited.has(path)) continue
    const absolutePath = join(root, ...path.split('/'))
    const info = await lstat(absolutePath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is not a regular runtime file`)
    const body = await readFile(absolutePath, 'utf8')
    const dependencies = typescript.preProcessFile(body, true, true).importedFiles
      .map(reference => resolveRuntimeImport(path, reference.fileName))
      .sort()
    imports[path] = dependencies
    visited.add(path)
    for (const dependency of dependencies) pending.push(dependency)
  }

  return {
    files: [...visited].sort(),
    imports: Object.fromEntries(Object.entries(imports).sort(([left], [right]) => left.localeCompare(right))),
  }
}

async function fileRecords(root, paths) {
  const records = {}
  for (const path of [...paths].sort()) {
    const body = await readFile(join(root, ...path.split('/')))
    records[path] = { bytes: body.byteLength, sha256: sha256(body) }
  }
  return records
}

async function copyArtifactFiles(checkout, staging, paths) {
  for (const path of paths) {
    const destination = join(staging, ...path.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(checkout, ...path.split('/')), destination)
  }
}

async function entriesBelow(root) {
  const files = []
  const directories = []
  async function visit(directory, relative = '') {
    const values = await readdir(directory, { withFileTypes: true })
    for (const value of values) {
      const path = relative === '' ? value.name : `${relative}/${value.name}`
      const absolutePath = join(directory, value.name)
      if (value.isSymbolicLink()) throw new Error(`runtime artifact contains symbolic link ${path}`)
      if (value.isDirectory()) {
        directories.push(path)
        await visit(absolutePath, path)
      } else if (value.isFile()) {
        files.push(path)
      } else {
        throw new Error(`runtime artifact contains unsupported entry ${path}`)
      }
    }
  }
  await visit(root)
  return { files: files.sort(), directories: directories.sort() }
}

async function sealReadOnly(root) {
  const { files, directories } = await entriesBelow(root)
  for (const path of files) await chmod(join(root, ...path.split('/')), 0o444)
  for (const path of directories.sort((left, right) => right.length - left.length)) {
    await chmod(join(root, ...path.split('/')), 0o555)
  }
  await chmod(root, 0o555)
}

async function assertReadOnly(root) {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('runtime artifact path is not a directory')
  const { files, directories } = await entriesBelow(root)
  for (const path of ['', ...directories, ...files]) {
    const info = path === '' ? rootInfo : await lstat(join(root, ...path.split('/')))
    if ((info.mode & 0o222) !== 0) throw new Error(`runtime artifact entry is writable: ${path || '.'}`)
  }
  return files
}

function assertSame(actual, expected, message) {
  if (canonical(actual) !== canonical(expected)) throw new Error(message)
}

async function assertAbsent(path) {
  try {
    await lstat(path)
    throw new Error(`runtime artifact already exists: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function buildRuntimeArtifact(outputPath) {
  await resolvedCommit()
  const artifactPath = resolve(outputPath)
  await assertAbsent(artifactPath)
  await mkdir(dirname(artifactPath), { recursive: true })

  const checkoutRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v10-checkout-'))
  const staging = await mkdtemp(join(dirname(artifactPath), `.${basename(artifactPath)}-staging-`))
  let moved = false
  try {
    const checkout = await extractCommit(checkoutRoot)
    const lockfile = await readFile(join(checkout, lockfilePath))
    const { typescript, summary: typescriptSummary } = await loadTypeScript()
    const lockVersion = lockedTypeScriptVersion(lockfile.toString('utf8'))
    if (lockVersion !== typescriptSummary.version) {
      throw new Error(`installed TypeScript ${typescriptSummary.version} does not match archived lockfile ${lockVersion}`)
    }

    await compileRouter(checkout, typescript)
    const runtime = await collectRuntimeClosure(checkout, typescript)
    const copiedFiles = [...sourceFiles, ...runtime.files]
    await copyArtifactFiles(checkout, staging, copiedFiles)

    const core = {
      schemaVersion: 1,
      kind: artifactKind,
      exactCommit,
      entrypoint: artifactEntrypoint,
      sourceFiles: [...sourceFiles],
      runtimeFiles: runtime.files,
      imports: runtime.imports,
      identities: {
        lockfile: { path: lockfilePath, sha256: sha256(lockfile) },
        typescript: typescriptSummary,
        node: nodeIdentity(),
      },
      files: await fileRecords(staging, copiedFiles),
    }
    const manifest = { ...core, artifactSha256: sha256(canonical(core)) }
    await writeFile(join(staging, artifactManifest), `${JSON.stringify(manifest, null, 2)}\n`)
    await sealReadOnly(staging)
    await rename(staging, artifactPath)
    moved = true
    return verifyRuntimeArtifact(artifactPath)
  } finally {
    await rm(checkoutRoot, { recursive: true, force: true })
    if (!moved) await rm(staging, { recursive: true, force: true })
  }
}

export async function verifyRuntimeArtifact(inputPath) {
  const artifactPath = resolve(inputPath)
  await resolvedCommit()
  const actualEntries = await assertReadOnly(artifactPath)
  const manifest = JSON.parse(await readFile(join(artifactPath, artifactManifest), 'utf8'))

  if (manifest.schemaVersion !== 1 || manifest.kind !== artifactKind) {
    throw new Error('runtime artifact manifest has an unsupported schema or kind')
  }
  if (manifest.exactCommit !== exactCommit) throw new Error('runtime artifact is bound to the wrong commit')
  if (manifest.entrypoint !== artifactEntrypoint) throw new Error('runtime artifact has the wrong entrypoint')
  assertSame(manifest.sourceFiles, sourceFiles, 'runtime artifact has the wrong source file set')

  const { artifactSha256, ...core } = manifest
  if (artifactSha256 !== sha256(canonical(core))) throw new Error('runtime artifact manifest digest mismatch')

  const declaredFiles = Object.keys(manifest.files).sort()
  assertSame(actualEntries, [...declaredFiles, artifactManifest].sort(), 'runtime artifact file inventory mismatch')
  const records = await fileRecords(artifactPath, declaredFiles)
  assertSame(records, manifest.files, 'runtime artifact file digest mismatch')

  const { typescript, summary: typescriptSummary } = await loadTypeScript()
  assertSame(manifest.identities.typescript, typescriptSummary, 'runtime artifact TypeScript identity mismatch')
  assertSame(manifest.identities.node, nodeIdentity(), 'runtime artifact Node identity mismatch')

  const checkoutRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v10-verify-'))
  try {
    const checkout = await extractCommit(checkoutRoot)
    const frozenLockfile = await readFile(join(checkout, lockfilePath))
    assertSame(
      manifest.identities.lockfile,
      { path: lockfilePath, sha256: sha256(frozenLockfile) },
      'runtime artifact lockfile identity mismatch',
    )
    if (lockedTypeScriptVersion(frozenLockfile.toString('utf8')) !== typescriptSummary.version) {
      throw new Error('installed TypeScript does not match the frozen lockfile')
    }

    for (const path of sourceFiles) {
      const archivedSource = await readFile(join(checkout, ...path.split('/')))
      if (manifest.files[path]?.sha256 !== sha256(archivedSource)) {
        throw new Error(`runtime artifact source does not match ${exactCommit}:${path}`)
      }
    }

    await compileRouter(checkout, typescript)
    const expectedRuntime = await collectRuntimeClosure(checkout, typescript)
    const actualRuntime = await collectRuntimeClosure(artifactPath, typescript)
    assertSame(manifest.runtimeFiles, expectedRuntime.files, 'runtime artifact import closure mismatch')
    assertSame(manifest.imports, expectedRuntime.imports, 'runtime artifact import graph mismatch')
    assertSame(actualRuntime, expectedRuntime, 'runtime artifact imports differ from the frozen compilation')
    assertSame(
      await fileRecords(artifactPath, expectedRuntime.files),
      await fileRecords(checkout, expectedRuntime.files),
      'runtime artifact compiled file digest mismatch',
    )
    assertSame(
      declaredFiles,
      [...sourceFiles, ...expectedRuntime.files].sort(),
      'runtime artifact contains undeclared files',
    )
  } finally {
    await rm(checkoutRoot, { recursive: true, force: true })
  }

  const entrypointPath = join(artifactPath, ...artifactEntrypoint.split('/'))
  return {
    artifactPath,
    entrypointPath,
    entrypointUrl: pathToFileURL(entrypointPath).href,
    manifest,
  }
}

export async function importFrozenRouter(artifactPath) {
  const verified = await verifyRuntimeArtifact(artifactPath)
  return import(verified.entrypointUrl)
}
