import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../../v0.4/lib/canonical.mjs'
import { isolatedGit } from './git-safety.mjs'
import { V28_DRIVER_OBJECT_PATHS } from './manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function defaultGit(root) {
  return (args, options) => isolatedGit(root, args, options)
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? '')
}

function nulRecords(value) {
  const bytes = asBuffer(value)
  const records = []
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue
    if (index > start) records.push(bytes.subarray(start, index))
    start = index + 1
  }
  if (start !== bytes.length) throw new Error('Git emitted a non-NUL-terminated record list')
  return records
}

function decodeGitPath(bytes) {
  const path = bytes.toString('utf8')
  if (!Buffer.from(path).equals(bytes)) throw new Error('V28 driver closure contains a non-UTF-8 Git path')
  return path
}

function normalizeSourcePaths(sourcePaths) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('V28 driver source closure must contain at least one path')
  }
  const normalized = sourcePaths.map((path) => {
    if (typeof path !== 'string'
      || path.length === 0
      || path.includes('\\')
      || isAbsolute(path)
      || posix.normalize(path) !== path
      || path === '.'
      || path === '..'
      || path.startsWith('../')) {
      throw new Error(`invalid V28 driver source closure path: ${String(path)}`)
    }
    return path
  })
  return [...new Set(normalized)].sort()
}

function literalPathspecs(paths) {
  return paths.map(path => `:(literal)${path}`)
}

function taggedPaths(output, predicate) {
  const paths = []
  for (const record of nulRecords(output)) {
    if (record.length < 3 || record[1] !== 0x20) throw new Error('Git emitted an invalid tagged index record')
    const tag = String.fromCharCode(record[0])
    if (predicate(tag)) paths.push(decodeGitPath(record.subarray(2)))
  }
  return paths.sort()
}

function parseConfig(output) {
  const values = new Map()
  for (const record of nulRecords(output)) {
    const separator = record.indexOf(0x0a)
    const keyBytes = separator === -1 ? record : record.subarray(0, separator)
    const valueBytes = separator === -1 ? Buffer.alloc(0) : record.subarray(separator + 1)
    const key = keyBytes.toString('utf8').toLowerCase()
    const list = values.get(key) ?? []
    list.push(valueBytes.toString('utf8'))
    values.set(key, list)
  }
  return values
}

function enabledConfigValues(config, key) {
  return (config.get(key.toLowerCase()) ?? []).filter(value => !/^(?:false|no|off|0)$/iu.test(value))
}

function validExtensionSignature(bytes, offset) {
  if (offset + 4 > bytes.length) return false
  for (let index = offset; index < offset + 4; index += 1) {
    const byte = bytes[index]
    if (!((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) return false
  }
  return true
}

function extensionChainEndsAt(bytes, start, end) {
  let offset = start
  while (offset < end) {
    if (offset + 8 > end || !validExtensionSignature(bytes, offset)) return false
    const size = bytes.readUInt32BE(offset + 4)
    offset += 8 + size
    if (offset > end) return false
  }
  return offset === end
}

function hasIndexExtension(indexBytes, signature, objectFormat) {
  const checksumLength = objectFormat === 'sha256' ? 32 : 20
  if (indexBytes.length < 12 + checksumLength || indexBytes.subarray(0, 4).toString('ascii') !== 'DIRC') {
    throw new Error('Git index is missing or malformed')
  }
  const bodyEnd = indexBytes.length - checksumLength
  const expectedChecksum = createHash(objectFormat).update(indexBytes.subarray(0, bodyEnd)).digest()
  if (!expectedChecksum.equals(indexBytes.subarray(bodyEnd))) throw new Error('Git index checksum is invalid')

  const marker = Buffer.from(signature, 'ascii')
  let offset = indexBytes.indexOf(marker, 12)
  while (offset !== -1 && offset < bodyEnd) {
    if (extensionChainEndsAt(indexBytes, offset, bodyEnd)) return true
    offset = indexBytes.indexOf(marker, offset + 1)
  }
  return false
}

function sparseIndexPaths(output) {
  const paths = []
  for (const record of nulRecords(output)) {
    const tab = record.indexOf(0x09)
    if (tab === -1) throw new Error('Git emitted an invalid staged index record')
    const header = record.subarray(0, tab).toString('ascii')
    if (header.startsWith('040000 ')) paths.push(decodeGitPath(record.subarray(tab + 1)))
  }
  return paths.sort()
}

export function inspectV28CheckoutSpecialStates({
  root = repositoryRoot,
  git = defaultGit(resolve(root)),
} = {}) {
  const absoluteRoot = realpathSync(resolve(root))
  const binaryOptions = { encoding: null }
  const assumeUnchanged = taggedPaths(
    git(['ls-files', '-v', '-z'], binaryOptions),
    tag => tag === tag.toLowerCase() && tag !== tag.toUpperCase(),
  )
  const skipWorktree = taggedPaths(
    git(['ls-files', '-t', '-z'], binaryOptions),
    tag => tag === 'S',
  )
  const fsmonitorValid = taggedPaths(
    git(['ls-files', '-f', '-z'], binaryOptions),
    tag => tag === tag.toLowerCase() && tag !== tag.toUpperCase(),
  )
  const sparseIndex = sparseIndexPaths(git(['ls-files', '--sparse', '--stage', '-z'], binaryOptions))
  const config = parseConfig(git(['config', '--null', '--list'], binaryOptions))
  const fsmonitorConfig = enabledConfigValues(config, 'core.fsmonitor')
  const sparseConfig = [
    'core.sparsecheckout',
    'core.sparsecheckoutcone',
    'index.sparse',
    'extensions.sparseindex',
  ].flatMap(key => enabledConfigValues(config, key).map(value => ({ key, value })))

  const indexPathValue = String(git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
  const indexPath = isAbsolute(indexPathValue) ? indexPathValue : resolve(absoluteRoot, indexPathValue)
  const objectFormat = String(git(['rev-parse', '--show-object-format'])).trim()
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error(`unsupported Git object format: ${objectFormat}`)
  const fsmonitorExtension = hasIndexExtension(readFileSync(indexPath), 'FSMN', objectFormat)

  const sparsePathValue = String(git([
    'rev-parse', '--path-format=absolute', '--git-path', 'info/sparse-checkout',
  ])).trim()
  const sparseCheckoutPath = isAbsolute(sparsePathValue)
    ? sparsePathValue
    : resolve(absoluteRoot, sparsePathValue)

  return {
    assumeUnchanged,
    skipWorktree,
    fsmonitor: {
      configValues: fsmonitorConfig,
      indexExtension: fsmonitorExtension,
      validPaths: fsmonitorValid,
    },
    sparse: {
      configValues: sparseConfig,
      indexPaths: sparseIndex,
      checkoutFile: existsSync(sparseCheckoutPath) ? sparseCheckoutPath : null,
    },
  }
}

function addRecord(records, record) {
  const prior = records.get(record.path)
  if (prior && (prior.mode !== record.mode || !prior.bytes.equals(record.bytes))) {
    throw new Error(`overlapping V28 driver source paths disagree for ${record.path}`)
  }
  records.set(record.path, record)
}

function walkWorktree(records, absolutePath, relativePath) {
  const metadata = lstatSync(absolutePath)
  if (metadata.isDirectory()) {
    const entries = readdirSync(absolutePath).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    for (const name of entries) {
      const childRelative = relativePath ? `${relativePath}/${name}` : name
      walkWorktree(records, join(absolutePath, name), childRelative)
    }
    return
  }
  if (metadata.isFile()) {
    addRecord(records, {
      path: relativePath,
      mode: metadata.mode & 0o100 ? '100755' : '100644',
      bytes: readFileSync(absolutePath),
    })
    return
  }
  if (metadata.isSymbolicLink()) {
    addRecord(records, {
      path: relativePath,
      mode: '120000',
      bytes: asBuffer(readlinkSync(absolutePath, { encoding: 'buffer' })),
    })
    return
  }
  throw new Error(`V28 driver source closure contains an unsupported filesystem entry: ${relativePath}`)
}

export function readV28DriverClosureWorktreeRecords({
  root = repositoryRoot,
  sourcePaths = V28_DRIVER_OBJECT_PATHS,
} = {}) {
  const absoluteRoot = realpathSync(resolve(root))
  const records = new Map()
  for (const path of normalizeSourcePaths(sourcePaths)) {
    walkWorktree(records, join(absoluteRoot, ...path.split('/')), path)
  }
  return [...records.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

export function materializeV28FrozenCommitRecords({
  root = repositoryRoot,
  commit,
  sourcePaths = V28_DRIVER_OBJECT_PATHS,
  git = defaultGit(resolve(root)),
} = {}) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new Error('V28 driver commit must be an exact Git commit')
  const paths = normalizeSourcePaths(sourcePaths)
  git(['cat-file', '-e', `${commit}^{commit}`])
  const tree = git([
    'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...literalPathspecs(paths),
  ], { encoding: null })
  const records = []
  for (const row of nulRecords(tree)) {
    const tab = row.indexOf(0x09)
    if (tab === -1) throw new Error('Git emitted an invalid frozen tree record')
    const header = row.subarray(0, tab).toString('ascii').split(' ')
    const [mode, type, object] = header
    const path = decodeGitPath(row.subarray(tab + 1))
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)
      || !/^[0-9a-f]{40,64}$/u.test(object ?? '')) {
      throw new Error(`V28 frozen driver closure contains an unsupported Git entry: ${path}`)
    }
    records.push({
      path,
      mode,
      bytes: asBuffer(git(['cat-file', 'blob', object], { encoding: null })),
    })
  }
  return records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function recordIdentity(records) {
  return records.map(record => ({
    path: record.path,
    mode: record.mode,
    bytes: record.bytes.length,
    sha256: sha256(record.bytes),
  }))
}

function assertNoSpecialStates(states) {
  if (states.assumeUnchanged.length > 0) {
    throw new Error(`V28 checkout contains assume-unchanged index entries: ${states.assumeUnchanged.join(', ')}`)
  }
  if (states.skipWorktree.length > 0) {
    throw new Error(`V28 checkout contains skip-worktree index entries: ${states.skipWorktree.join(', ')}`)
  }
  if (states.fsmonitor.configValues.length > 0
    || states.fsmonitor.indexExtension
    || states.fsmonitor.validPaths.length > 0) {
    throw new Error('V28 checkout has fsmonitor state enabled')
  }
  if (states.sparse.configValues.length > 0
    || states.sparse.indexPaths.length > 0
    || states.sparse.checkoutFile !== null) {
    throw new Error('V28 checkout has sparse checkout or sparse-index state enabled')
  }
}

export function assertV28CheckoutIntegrity({
  root = repositoryRoot,
  commit,
  sourcePaths = V28_DRIVER_OBJECT_PATHS,
  git = defaultGit(resolve(root)),
} = {}) {
  const states = inspectV28CheckoutSpecialStates({ root, git })
  assertNoSpecialStates(states)
  const worktreeRecords = readV28DriverClosureWorktreeRecords({ root, sourcePaths })
  const frozenRecords = materializeV28FrozenCommitRecords({ root, commit, sourcePaths, git })
  if (worktreeRecords.length !== frozenRecords.length) {
    throw new Error('V28 driver source closure paths differ from the frozen commit')
  }
  for (let index = 0; index < frozenRecords.length; index += 1) {
    const observed = worktreeRecords[index]
    const expected = frozenRecords[index]
    if (observed.path !== expected.path) {
      throw new Error('V28 driver source closure paths differ from the frozen commit')
    }
    if (observed.mode !== expected.mode) {
      throw new Error(`V28 driver source closure mode differs from the frozen commit: ${observed.path}`)
    }
    if (!observed.bytes.equals(expected.bytes)) {
      throw new Error(`V28 driver source closure bytes differ from the frozen commit: ${observed.path}`)
    }
  }
  const records = recordIdentity(frozenRecords)
  return {
    commit,
    sourcePaths: normalizeSourcePaths(sourcePaths),
    fileCount: records.length,
    records,
    recordsSha256: sha256(records),
  }
}
