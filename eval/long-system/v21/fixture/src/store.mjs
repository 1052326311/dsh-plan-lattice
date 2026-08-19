import { readFile, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { InputError } from './errors.mjs'
import { isPlainObject, isNonEmptyString, isUtcIsoTimestamp, TYPES, ROLES } from './validate.mjs'

const STATUSES = ['planned', 'active', 'completed']

// Structural validation of one stored event record. Every event is a full
// snapshot: command envelope fields plus the resulting revision/status and the
// duty state (worker/start/end/note) carried through replay.
function isValidEvent(event) {
  if (!isPlainObject(event)) return false
  if (!isNonEmptyString(event.commandId)) return false
  if (!isNonEmptyString(event.dutyId)) return false
  if (typeof event.type !== 'string' || !(event.type in TYPES)) return false
  if (!isPlainObject(event.actor)) return false
  if (!isNonEmptyString(event.actor.id)) return false
  if (!ROLES.includes(event.actor.role)) return false
  if (!isUtcIsoTimestamp(event.at)) return false
  if (!Number.isInteger(event.expectedRevision) || event.expectedRevision < 0) return false
  if (!Number.isInteger(event.revision) || event.revision < 1) return false
  if (!STATUSES.includes(event.status)) return false
  if (!isNonEmptyString(event.worker)) return false
  if (!isUtcIsoTimestamp(event.start)) return false
  if (!isUtcIsoTimestamp(event.end)) return false
  if (event.note !== null && !isNonEmptyString(event.note)) return false
  return true
}

// Reads the append-only event log. A missing store is an empty log. Malformed
// durable state (bad JSON, invalid records, duplicate commandIds, non-monotonic
// per-duty revisions) is an input failure (exit 2).
export async function readEvents(storePath) {
  let text
  try {
    text = await readFile(storePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw new InputError(`cannot read store: ${err.message}`)
  }

  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const events = []
  const seenCommandIds = new Set()
  const lastRevisionByDuty = new Map()
  for (const line of lines) {
    if (line.trim() === '') throw new InputError('malformed store: empty line')
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw new InputError('malformed store: invalid JSON event')
    }
    if (!isValidEvent(event)) throw new InputError('malformed store: invalid event record')
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
// file that is fsynced and renamed over the store. Only ever called after a
// command is accepted, so rejected commands never touch the store.
export async function appendEvents(storePath, existing, additions) {
  const dir = path.dirname(storePath)
  const base = path.basename(storePath)
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`)
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
