import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ContractRecord } from './contract.js'

const ANCHOR_SCHEMA_VERSION = 1

interface ContractAnchor {
  schemaVersion: typeof ANCHOR_SCHEMA_VERSION
  record: ContractRecord
}

function anchorName(sessionId: string): string {
  return `${createHash('sha256').update(sessionId).digest('hex')}.json`
}

export function defaultContractAnchorRoot(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(dshHome, 'plan-lattice', 'contract-anchors', 'v1')
}

function anchorPath(root: string, sessionId: string): string {
  return join(root, anchorName(sessionId))
}

function assertAnchor(value: unknown, sessionId: string): asserts value is ContractAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('contract anchor is not an object')
  const anchor = value as Partial<ContractAnchor>
  const record = anchor.record as Partial<ContractRecord> | undefined
  if (anchor.schemaVersion !== ANCHOR_SCHEMA_VERSION
    || typeof record !== 'object'
    || record === null
    || record.sessionId !== sessionId
    || typeof record.id !== 'string'
    || !Number.isSafeInteger(record.revision)
    || typeof record.documentDigest !== 'string') {
    throw new Error('contract anchor has an unsupported or malformed schema')
  }
}

export function readContractAnchorSync(root: string, sessionId: string): ContractRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(anchorPath(root, sessionId), 'utf8'))
    assertAnchor(value, sessionId)
    return value.record
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function contractMatchesAnchor(contract: ContractRecord, anchor: ContractRecord): boolean {
  return contract.sessionId === anchor.sessionId
    && contract.id === anchor.id
    && contract.revision === anchor.revision
    && contract.documentDigest === anchor.documentDigest
}

export async function persistContractAnchor(root: string, record: ContractRecord): Promise<void> {
  const path = anchorPath(root, record.sessionId)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const anchor: ContractAnchor = { schemaVersion: ANCHOR_SCHEMA_VERSION, record }
  try {
    await writeFile(temporary, `${JSON.stringify(anchor, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
