import { readFile, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { InputError } from './errors.mjs'
import { eventError } from './validate.mjs'

// Reads the append-only event log. A missing store is an empty log. Malformed
// durable state (bad JSON, invalid records, blank lines, a missing final LF,
// duplicate commandIds, non-increasing per-duty revisions) is an input
// failure (exit 2) and is never repaired or rewritten here.
export async function readEvents(storePath) {
  let text
  try {
    text = await readFile(storePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw new InputError(`cannot read store: ${err.message}`)
  }

  if (text === '') throw new InputError('malformed store: empty file')
  if (!text.endsWith('\n')) throw new InputError('malformed store: missing final newline')
  const lines = text.slice(0, -1).split('\n')

  const events = []
  const seenCommandIds = new Set()
  const lastRevisionByDuty = new Map()
  for (const line of lines) {
    if (line.trim() === '') throw new InputError('malformed store: blank line')
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new InputError('malformed store: invalid JSON event')
    }
    const err = eventError(event)
    if (err) throw new InputError(`malformed store: ${err}`)
    if (seenCommandIds.has(event.commandId)) {
      throw new InputError('malformed store: duplicate commandId')
    }
    seenCommandIds.add(event.commandId)
    const lastRevision = lastRevisionByDuty.get(event.dutyId)
    if (lastRevision !== undefined && event.revision <= lastRevision) {
      throw new InputError('malformed store: non-monotonic duty revision')
    }
    lastRevisionByDuty.set(event.dutyId, event.revision)
    events.push(event)
  }
  return events
}

let tempCounter = 0

// Appends new events by rewriting the log through a same-directory temporary
// file that is fsynced, closed and renamed over the store. Only ever called
// after a command is accepted, so rejected commands never touch the store.
export async function appendEvents(storePath, existing, additions) {
  const dir = path.dirname(storePath)
  const base = path.basename(storePath)
  const tmp = path.join(dir, `.${base}.${process.pid}.${tempCounter++}.tmp`)
  const data = [...existing, ...additions].map((e) => JSON.stringify(e)).join('\n') + '\n'

  let handle = null
  try {
    handle = await open(tmp, 'wx')
    await handle.writeFile(data, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tmp, storePath)
  } catch (err) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore close failure during error handling
      }
    }
    try {
      await unlink(tmp)
    } catch {
      // ignore: temp file may not exist
    }
    throw new InputError(`cannot write store: ${err.message}`)
  }
}
