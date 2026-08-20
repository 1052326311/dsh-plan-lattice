import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { analyzeNativeContinuitySessions } from './continuity-metrics.mjs'

async function walk(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.name === 'session.jsonl') files.push(path)
  }
  return files
}

function parseJson(line, path, lineNumber) {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`${path} contains invalid JSON on line ${lineNumber}`)
  }
}

function parseSession(text, path) {
  if (!text.endsWith('\n')) throw new Error(`${path} is not a complete durable JSONL artifact`)
  const lines = text.split(/\r?\n/)
  lines.pop()
  if (lines.length === 0 || lines.some(line => line.trim() === '')) {
    throw new Error(`${path} contains an empty JSONL record`)
  }
  const header = parseJson(lines[0], path, 1)
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error(`${path} has no valid Session header`)
  }
  const events = lines.slice(1).map((line, index) => {
    const event = parseJson(line, path, index + 2)
    if (!event || typeof event !== 'object'
      || typeof event.type !== 'string'
      || !Number.isSafeInteger(event.seq)
      || event.seq !== index
      || !Number.isFinite(event.time)
      || !Object.hasOwn(event, 'data')) {
      throw new Error(`${path} has a malformed event on line ${index + 2}`)
    }
    return event
  })
  return { header, events }
}

export async function auditPersistentNativeContinuity(root, options = {}) {
  const files = await walk(root)
  if (files.length === 0) throw new Error('Harness produced no persistent session.jsonl artifact')
  const sessions = []
  for (const path of files) {
    sessions.push(parseSession(await readFile(path, 'utf8'), path))
  }
  if (options.expectedSessionIds !== undefined) {
    if (!Array.isArray(options.expectedSessionIds)
      || options.expectedSessionIds.length === 0
      || options.expectedSessionIds.some(id => typeof id !== 'string' || id.length === 0)
      || new Set(options.expectedSessionIds).size !== options.expectedSessionIds.length) {
      throw new Error('expectedSessionIds must contain unique non-empty Session ids')
    }
    for (const id of options.expectedSessionIds) {
      if (sessions.filter(session => session.header.id === id).length !== 1) {
        throw new Error(`persistent sessions do not contain exactly one Session ${id}`)
      }
    }
  }
  return {
    files,
    ...analyzeNativeContinuitySessions(sessions, { maxSnapshotBytes: options.maxSnapshotBytes }),
  }
}

