import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AuthoritySource } from './contract.js'

const SCHEMA_VERSION = 1
const DIRECTORY = 'native-first-authority/v1'

interface NativeAuthorityAnchor {
  schemaVersion: typeof SCHEMA_VERSION
  rootSessionId: string
  sources: AuthoritySource[]
}

function pathFor(root: string, rootSessionId: string): string {
  const file = `${createHash('sha256').update(rootSessionId).digest('hex')}.json`
  return join(resolve(root), DIRECTORY, file)
}

function assertSource(value: unknown): asserts value is AuthoritySource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('native authority source is not an object')
  const source = value as Partial<AuthoritySource>
  if (typeof source.seq !== 'number' || !Number.isSafeInteger(source.seq) || source.seq < 0
    || typeof source.messageId !== 'string' || source.messageId.length === 0
    || typeof source.digest !== 'string' || !/^[0-9a-f]{64}$/.test(source.digest)) {
    throw new Error('native authority source is malformed')
  }
}

function assertAnchor(value: unknown, rootSessionId: string): asserts value is NativeAuthorityAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('native authority anchor is not an object')
  const anchor = value as Partial<NativeAuthorityAnchor>
  if (anchor.schemaVersion !== SCHEMA_VERSION || anchor.rootSessionId !== rootSessionId || !Array.isArray(anchor.sources)) {
    throw new Error('native authority anchor has an unsupported schema')
  }
  const sources = anchor.sources as unknown[]
  for (const source of sources) assertSource(source)
  const checkedSources = sources as AuthoritySource[]
  if (new Set(checkedSources.map(source => `${source.seq}\0${source.messageId}`)).size !== checkedSources.length) {
    throw new Error('native authority anchor has duplicate sources')
  }
}

export function readNativeAuthorityAnchorSync(root: string, rootSessionId: string): AuthoritySource[] | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(root, rootSessionId), 'utf8'))
    assertAnchor(value, rootSessionId)
    return value.sources.map(source => ({ ...source }))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Persist only immutable Session references. The original human text remains
 * solely in DSH's append-only log and is verified again before re-projection.
 */
export function persistNativeAuthorityAnchorSync(
  root: string,
  rootSessionId: string,
  sources: readonly AuthoritySource[],
): AuthoritySource[] {
  const unique = new Map<string, AuthoritySource>()
  for (const source of sources) {
    assertSource(source)
    const key = `${source.seq}\0${source.messageId}`
    const previous = unique.get(key)
    if (previous !== undefined && previous.digest !== source.digest) {
      throw new Error('native authority source identity has conflicting digests')
    }
    unique.set(key, { ...source })
  }
  const normalized = [...unique.values()].sort((left, right) => left.seq - right.seq || left.messageId.localeCompare(right.messageId))
  const path = pathFor(root, rootSessionId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const anchor: NativeAuthorityAnchor = { schemaVersion: SCHEMA_VERSION, rootSessionId, sources: normalized }
  try {
    writeFileSync(temporary, `${JSON.stringify(anchor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return normalized
}
