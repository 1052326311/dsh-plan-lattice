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
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFile = promisify(execFileCallback)

export const exactCommit = '7cb3c77f9dab6ef193eb77318fb87389b877b526'
export const exactTree = '10970e580c45891ffd8bbfe395ac920401f65799'
export const frozenNodeVersion = 'v22.23.0'
export const frozenTypeScriptVersion = '5.9.3'
export const sourceFiles = ['src/router.ts', 'src/task-invariants.ts']
export const artifactEntrypoint = 'lib/router.js'
export const artifactManifest = 'manifest.json'
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const artifactKind = 'dsh-plan-lattice-v14-frozen-router-runtime'
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
    maxBuffer: 32 * 1024 * 1024,
  })
}

async function assertFrozenGitIdentity() {
  const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
    run('git', ['rev-parse', '--verify', `${exactCommit}^{commit}`], { cwd: repositoryRoot }),
    run('git', ['rev-parse', '--verify', `${exactCommit}^{tree}`], { cwd: repositoryRoot }),
  ])
  if (commit.trim() !== exactCommit) throw new Error(`V14 runtime commit resolved to ${commit.trim()}`)
  if (tree.trim() !== exactTree) throw new Error(`V14 runtime tree resolved to ${tree.trim()}`)
}

async function nodeIdentity() {
  if (process.version !== frozenNodeVersion) {
    throw new Error(`V14 runtime requires Node ${frozenNodeVersion}, received ${process.version}`)
  }
  const executable = await realpath(process.execPath)
  const executableBytes = await readFile(executable)
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
    executableName: basename(executable),
    executableBytes: executableBytes.byteLength,
    executableSha256: sha256(executableBytes),
  })
}

async function loadTypeScript() {
  const requireFromRepository = createRequire(join(repositoryRoot, 'package.json'))
  const packagePath = requireFromRepository.resolve('typescript/package.json')
  const compilerPath = requireFromRepository.resolve('typescript')
  const [packageBytes, compilerBytes] = await Promise.all([
    readFile(packagePath),
    readFile(compilerPath),
  ])
  const packageJson = JSON.parse(packageBytes.toString('utf8'))
  if (packageJson.version !== frozenTypeScriptVersion) {
    throw new Error(`V14 runtime requires TypeScript ${frozenTypeScriptVersion}, received ${packageJson.version}`)
  }
  const summary = identity({
    name: packageJson.name,
    version: packageJson.version,
    packageBytes: packageBytes.byteLength,
    packageSha256: sha256(packageBytes),
    compilerBytes: compilerBytes.byteLength,
    compilerSha256: sha256(compilerBytes),
  })
  return { typescript: requireFromRepository('typescript'), summary }
}

function lockedTypeScriptVersion(lockfile) {
  const match = lockfile.match(/(?:^|\n)      typescript:\r?\n        specifier: [^\r\n]+\r?\n        version: ([^\s(]+)/)
  if (match === null) throw new Error('the archived lockfile does not pin the root TypeScript dependency')
  return match[1]
}

async function extractFrozenCommit(temporaryRoot) {
  const archivePath = join(temporaryRoot, 'commit.tar')
  const checkout = join(temporaryRoot, 'checkout')
  await mkdir(checkout)
  await run('git', ['archive', '--format=tar', '--output', archivePath, exactCommit], { cwd: repositoryRoot })
  const archiveBytes = await readFile(archivePath)
  await run('tar', ['-xf', archivePath, '-C', checkout])
  return {
    archiveIdentity: {
      format: 'git-archive-tar',
      bytes: archiveBytes.byteLength,
      sha256: sha256(archiveBytes),
    },
    checkout,
  }
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

  const roots = sourceFiles.map(path => join(checkout, ...path.split('/')))
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
    const bytes = await readFile(join(root, ...path.split('/')))
    records[path] = { bytes: bytes.byteLength, sha256: sha256(bytes) }
  }
  return records
}

function recordsDigest(records) {
  return sha256(canonical(records))
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
    for (const value of await readdir(directory, { withFileTypes: true })) {
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

async function buildExpectedState() {
  await assertFrozenGitIdentity()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-v14-archive-'))
  try {
    const { archiveIdentity, checkout } = await extractFrozenCommit(temporaryRoot)
    const lockfile = await readFile(join(checkout, lockfilePath))
    const { typescript, summary: typescriptIdentity } = await loadTypeScript()
    const node = await nodeIdentity()
    if (lockedTypeScriptVersion(lockfile.toString('utf8')) !== frozenTypeScriptVersion) {
      throw new Error(`archived lockfile does not pin TypeScript ${frozenTypeScriptVersion}`)
    }
    await compileRouter(checkout, typescript)
    const runtime = await collectRuntimeClosure(checkout, typescript)
    const sourceRecords = await fileRecords(checkout, sourceFiles)
    const compiledRecords = await fileRecords(checkout, runtime.files)
    const files = { ...sourceRecords, ...compiledRecords }
    return {
      archiveIdentity,
      checkout,
      files,
      identities: {
        git: { commit: exactCommit, tree: exactTree },
        lockfile: { path: lockfilePath, bytes: lockfile.byteLength, sha256: sha256(lockfile) },
        typescript: typescriptIdentity,
        node,
      },
      digests: {
        sourceSha256: recordsDigest(sourceRecords),
        compiledSha256: recordsDigest(compiledRecords),
        artifactTreeSha256: recordsDigest(files),
      },
      runtime,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

export async function buildFrozenRuntimeArtifact(outputPath) {
  const artifactPath = resolve(outputPath)
  await assertAbsent(artifactPath)
  await mkdir(dirname(artifactPath), { recursive: true })
  const staging = await mkdtemp(join(dirname(artifactPath), `.${basename(artifactPath)}-staging-`))
  const expected = await buildExpectedState()
  let moved = false
  try {
    const copiedFiles = [...sourceFiles, ...expected.runtime.files]
    await copyArtifactFiles(expected.checkout, staging, copiedFiles)
    const core = {
      schemaVersion: 2,
      kind: artifactKind,
      exactCommit,
      exactTree,
      entrypoint: artifactEntrypoint,
      sourceFiles: [...sourceFiles],
      runtimeFiles: expected.runtime.files,
      imports: expected.runtime.imports,
      archive: expected.archiveIdentity,
      identities: expected.identities,
      digests: expected.digests,
      files: expected.files,
    }
    const manifest = { ...core, artifactSha256: sha256(canonical(core)) }
    await writeFile(join(staging, artifactManifest), `${JSON.stringify(manifest, null, 2)}\n`)
    await sealReadOnly(staging)
    await rename(staging, artifactPath)
    moved = true
  } finally {
    await expected.cleanup()
    if (!moved) await rm(staging, { recursive: true, force: true })
  }
  return verifyFrozenRuntimeArtifact(artifactPath)
}

export async function verifyFrozenRuntimeArtifact(inputPath) {
  const artifactPath = resolve(inputPath)
  const actualEntries = await assertReadOnly(artifactPath)
  const manifest = JSON.parse(await readFile(join(artifactPath, artifactManifest), 'utf8'))
  if (manifest.schemaVersion !== 2 || manifest.kind !== artifactKind) {
    throw new Error('runtime artifact manifest has an unsupported schema or kind')
  }
  if (manifest.exactCommit !== exactCommit || manifest.exactTree !== exactTree) {
    throw new Error('runtime artifact is bound to the wrong Git identity')
  }
  if (manifest.entrypoint !== artifactEntrypoint) throw new Error('runtime artifact has the wrong entrypoint')
  assertSame(manifest.sourceFiles, sourceFiles, 'runtime artifact has the wrong source file set')

  const { artifactSha256, ...core } = manifest
  if (artifactSha256 !== sha256(canonical(core))) throw new Error('runtime artifact manifest digest mismatch')
  const declaredFiles = Object.keys(manifest.files).sort()
  assertSame(actualEntries, [...declaredFiles, artifactManifest].sort(), 'runtime artifact file inventory mismatch')
  assertSame(await fileRecords(artifactPath, declaredFiles), manifest.files, 'runtime artifact file digest mismatch')
  if (manifest.digests.sourceSha256 !== recordsDigest(Object.fromEntries(sourceFiles.map(path => [path, manifest.files[path]])))) {
    throw new Error('runtime artifact source digest mismatch')
  }
  if (manifest.digests.compiledSha256 !== recordsDigest(Object.fromEntries(manifest.runtimeFiles.map(path => [path, manifest.files[path]])))) {
    throw new Error('runtime artifact compiled digest mismatch')
  }
  if (manifest.digests.artifactTreeSha256 !== recordsDigest(manifest.files)) {
    throw new Error('runtime artifact tree digest mismatch')
  }

  const expected = await buildExpectedState()
  try {
    assertSame(manifest.archive, expected.archiveIdentity, 'runtime artifact archive identity mismatch')
    assertSame(manifest.identities, expected.identities, 'runtime artifact toolchain identity mismatch')
    assertSame(manifest.digests, expected.digests, 'runtime artifact frozen digest mismatch')
    assertSame(manifest.runtimeFiles, expected.runtime.files, 'runtime artifact import closure mismatch')
    assertSame(manifest.imports, expected.runtime.imports, 'runtime artifact import graph mismatch')
    assertSame(manifest.files, expected.files, 'runtime artifact differs from the archived compilation')
    assertSame(
      await collectRuntimeClosure(artifactPath, (await loadTypeScript()).typescript),
      expected.runtime,
      'runtime artifact imports differ from the frozen compilation',
    )
  } finally {
    await expected.cleanup()
  }

  const entrypointPath = join(artifactPath, ...artifactEntrypoint.split('/'))
  return {
    artifactPath,
    entrypointPath,
    entrypointUrl: `${pathToFileURL(entrypointPath).href}?artifact=${manifest.artifactSha256}`,
    manifest,
  }
}

export async function importFrozenRouter(artifactPath) {
  const verified = await verifyFrozenRuntimeArtifact(artifactPath)
  const module = await import(verified.entrypointUrl)
  if (typeof module.routeRequest !== 'function') throw new Error('verified runtime does not export routeRequest')
  return module
}

// Stable compatibility names retained for older V8-V10 orchestration code.
export const buildRuntimeArtifact = buildFrozenRuntimeArtifact
export const verifyRuntimeArtifact = verifyFrozenRuntimeArtifact
