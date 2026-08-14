import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { LatticeReceipt, LatticeState } from './domain.js'

export interface ContextDocument {
  path: string
  digest: string
  content: string
}

export interface ReadContextResult {
  workspace: string
  digest: string
  documents: ContextDocument[]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function validateContextPaths(paths: string[]): string[] {
  if (paths.length === 0) throw new Error('contextPaths must list at least one project document')
  const normalized = paths.map(path => {
    if (typeof path !== 'string' || path.trim().length === 0 || isAbsolute(path)) {
      throw new Error('every context path must be a non-empty workspace-relative path')
    }
    const candidate = path.replaceAll('\\', '/')
    if (candidate.split('/').includes('..')) throw new Error(`context path escapes the workspace: ${JSON.stringify(path)}`)
    return candidate
  })
  if (new Set(normalized).size !== normalized.length) throw new Error('contextPaths must not contain duplicates')
  return normalized.sort()
}

async function resolveContained(workspace: string, relativePath: string): Promise<string> {
  const root = await realpath(workspace)
  const candidate = resolve(root, relativePath)
  const resolved = await realpath(candidate)
  const fromRoot = relative(root, resolved)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`context path resolves outside the workspace: ${JSON.stringify(relativePath)}`)
  }
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`context path is not a regular file: ${JSON.stringify(relativePath)}`)
  return resolved
}

function resolveContainedSync(workspace: string, relativePath: string): string {
  const root = realpathSync(workspace)
  const candidate = resolve(root, relativePath)
  const resolved = realpathSync(candidate)
  const fromRoot = relative(root, resolved)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`context path resolves outside the workspace: ${JSON.stringify(relativePath)}`)
  }
  const info = statSync(resolved)
  if (!info.isFile()) throw new Error(`context path is not a regular file: ${JSON.stringify(relativePath)}`)
  return resolved
}

/** Read every required source fully before a receipt can be issued. */
export async function readProjectContext(
  workspace: string,
  contextPaths: string[],
  maxContextBytes: number,
): Promise<ReadContextResult> {
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1) {
    throw new Error('maxContextBytes must be a positive safe integer')
  }
  const normalizedWorkspace = await realpath(workspace)
  const documents: ContextDocument[] = []
  let totalBytes = 0
  for (const path of validateContextPaths(contextPaths)) {
    const target = await resolveContained(normalizedWorkspace, path)
    const content = await readFile(target, 'utf8')
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > maxContextBytes) {
      throw new Error(`project context exceeds ${maxContextBytes} bytes; split the context contract instead of truncating it`)
    }
    documents.push({ path, digest: digest(content), content })
  }
  const contextDigest = digest(JSON.stringify(documents.map(document => ({ path: document.path, digest: document.digest }))))
  return { workspace: normalizedWorkspace, digest: contextDigest, documents }
}

/**
 * Recheck the same bounded contract inside the synchronous Harness tool guard.
 * A guard cannot await filesystem I/O, so this direct bounded digest check can
 * reject a changed document immediately before a guarded side effect starts.
 */
export function readProjectContextSync(
  workspace: string,
  contextPaths: string[],
  maxContextBytes: number,
): ReadContextResult {
  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes < 1) {
    throw new Error('maxContextBytes must be a positive safe integer')
  }
  const normalizedWorkspace = realpathSync(workspace)
  const documents: ContextDocument[] = []
  let totalBytes = 0
  for (const path of validateContextPaths(contextPaths)) {
    const target = resolveContainedSync(normalizedWorkspace, path)
    const content = readFileSync(target, 'utf8')
    totalBytes += Buffer.byteLength(content)
    if (totalBytes > maxContextBytes) {
      throw new Error(`project context exceeds ${maxContextBytes} bytes; split the context contract instead of truncating it`)
    }
    documents.push({ path, digest: digest(content), content })
  }
  const contextDigest = digest(JSON.stringify(documents.map(document => ({ path: document.path, digest: document.digest }))))
  return { workspace: normalizedWorkspace, digest: contextDigest, documents }
}

export function issueReceipt(workspace: string, state: LatticeState, context: ReadContextResult): LatticeReceipt {
  return {
    id: `receipt-${randomUUID()}`,
    workspace,
    revision: state.revision,
    digest: context.digest,
    issuedAt: Date.now(),
  }
}
