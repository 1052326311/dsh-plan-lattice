import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SCHEMA_VERSION = 1
const DIRECTORY = 'native-delegation/v1'

export interface NativeDelegationAnchor {
  schemaVersion: typeof SCHEMA_VERSION
  childSessionId: string
  parentSessionId: string
  rootSessionId: string
  initialMessage: { id: string; digest: string }
}

function pathFor(root: string, childSessionId: string): string {
  const file = `${createHash('sha256').update(childSessionId).digest('hex')}.json`
  return join(resolve(root), DIRECTORY, file)
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
}

function assertAnchor(value: unknown, childSessionId?: string): asserts value is NativeDelegationAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('native delegation anchor is not an object')
  const anchor = value as Partial<NativeDelegationAnchor>
  if (anchor.schemaVersion !== SCHEMA_VERSION) throw new Error('native delegation anchor has an unsupported schema')
  nonEmpty(anchor.childSessionId, 'childSessionId')
  nonEmpty(anchor.parentSessionId, 'parentSessionId')
  nonEmpty(anchor.rootSessionId, 'rootSessionId')
  if (childSessionId !== undefined && anchor.childSessionId !== childSessionId) {
    throw new Error('native delegation child identity does not match its anchor')
  }
  if (typeof anchor.initialMessage !== 'object' || anchor.initialMessage === null) {
    throw new Error('native delegation initialMessage is not an object')
  }
  nonEmpty(anchor.initialMessage.id, 'initialMessage.id')
  if (!/^[0-9a-f]{64}$/.test(anchor.initialMessage.digest)) {
    throw new Error('native delegation initialMessage.digest must be a SHA-256 digest')
  }
}

export function readNativeDelegationAnchorSync(root: string, childSessionId: string): NativeDelegationAnchor | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(pathFor(root, childSessionId), 'utf8'))
    assertAnchor(value, childSessionId)
    return structuredClone(value)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function persistNativeDelegationAnchorSync(
  root: string,
  input: Omit<NativeDelegationAnchor, 'schemaVersion'>,
): NativeDelegationAnchor {
  const anchor: NativeDelegationAnchor = { schemaVersion: SCHEMA_VERSION, ...structuredClone(input) }
  assertAnchor(anchor, input.childSessionId)
  const existing = readNativeDelegationAnchorSync(root, input.childSessionId)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(anchor)) {
      throw new Error('native delegation anchor already exists with a different DSH identity')
    }
    return existing
  }
  const path = pathFor(root, input.childSessionId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(anchor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
  return structuredClone(anchor)
}

