import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

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

function nonnegative(value, field, path) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${path} contains invalid ${field}`)
  return value
}

function usageOf(record, path) {
  const usage = record?.data?.usage
  if (usage === undefined) return undefined
  if (!usage || typeof usage !== 'object') throw new Error(`${path} contains malformed model usage`)
  return {
    inputTokens: nonnegative(usage.inputTokens ?? 0, 'inputTokens', path)
      + nonnegative(usage.cacheReadTokens ?? 0, 'cacheReadTokens', path)
      + nonnegative(usage.cacheWriteTokens ?? 0, 'cacheWriteTokens', path),
    outputTokens: nonnegative(usage.outputTokens ?? 0, 'outputTokens', path),
  }
}

function parseLine(line, path, index) {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`${path} contains invalid JSON on line ${index + 1}`)
  }
}

function parseSession(text, path) {
  if (!text.endsWith('\n')) throw new Error(`${path} is not a complete durable JSONL artifact`)
  const lines = text.split(/\r?\n/)
  lines.pop()
  if (lines.length === 0 || lines.some(line => line.trim() === '')) throw new Error(`${path} contains an empty JSONL record`)
  const header = parseLine(lines[0], path, 0)
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0) {
    throw new Error(`${path} has no valid session header`)
  }
  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    const event = parseLine(lines[index], path, index)
    if (!event || typeof event !== 'object'
      || typeof event.type !== 'string'
      || !Number.isSafeInteger(event.seq)
      || event.seq !== index - 1
      || !Number.isFinite(event.time)
      || !Object.hasOwn(event, 'data')) {
      throw new Error(`${path} contains a malformed or non-contiguous event on line ${index + 1}`)
    }
    events.push(event)
  }
  return { header, events }
}

function ownEvents(session) {
  const seedLength = session.header.seedLength ?? 0
  if (!Number.isSafeInteger(seedLength)
    || seedLength < 0
    || seedLength > session.events.length) {
    throw new Error(`${session.path} contains invalid seedLength`)
  }
  return session.events.slice(seedLength)
}

function messageText(value) {
  const message = value?.message ?? value
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return undefined
  const parts = message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
  return parts.length === 0 ? undefined : parts.join('')
}

function messageSource(value) {
  const message = value?.message ?? value
  return message && typeof message === 'object' && message.source && typeof message.source === 'object'
    ? message.source
    : undefined
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex')
}

const MAX_TOKEN_CONTINUATION_TEXT = '[plan-lattice/max-token-continuation] Continue the same accepted task from the durable session state. Preserve human authority and boundaries; execute the next incomplete acceptance item.'
const FORBIDDEN_AUTOMATIC_CONTROL_TOOLS = new Set(['lattice_route', 'lattice_intake', 'lattice_open'])

function isNativeMaxTokenContinuation(record) {
  return record.type === 'user/message'
    && messageSource(record.data)?.kind === 'plugin'
    && messageSource(record.data)?.plugin === 'plan-lattice'
    && messageText(record.data) === MAX_TOKEN_CONTINUATION_TEXT
}

export async function parseSessionMetrics(root, options = {}) {
  const files = await walk(root)
  if (files.length === 0) throw new Error('Harness produced no persistent session.jsonl artifact')
  const sessions = []
  for (const path of files) sessions.push({ path, ...parseSession(await readFile(path, 'utf8'), path) })
  if (options.expectedSessionId !== undefined && options.expectedSessionIds !== undefined) {
    throw new Error('expectedSessionId and expectedSessionIds cannot be combined')
  }
  const expectedIds = options.expectedSessionId === undefined
    ? options.expectedSessionIds
    : [options.expectedSessionId]
  if (expectedIds !== undefined && (!Array.isArray(expectedIds)
    || expectedIds.length === 0
    || expectedIds.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(expectedIds).size !== expectedIds.length)) {
    throw new Error('expectedSessionIds must contain unique non-empty session ids')
  }
  const selected = expectedIds === undefined
    ? sessions
    : sessions.filter(session => expectedIds.includes(session.header.id))
  if (expectedIds !== undefined) {
    for (const expectedId of expectedIds) {
      const matches = selected.filter(session => session.header.id === expectedId)
      if (matches.length === 0) {
        throw new Error(`persistent sessions do not contain expected session ${expectedId}`)
      }
      if (matches.length !== 1) {
        throw new Error(`persistent sessions contain duplicate expected session ${expectedId}`)
      }
    }
  }
  let modelTurns = 0
  let inputTokens = 0
  let outputTokens = 0
  let missingUsageEvents = 0
  let compactionSummaries = 0
  let surfaceReplacements = 0
  let nativeMaxTokenContinuations = 0
  let todoWrites = 0
  let completedTodoWrites = 0
  const invalidTodoWrites = []
  const controlToolCalls = []
  let firstTime
  let lastTime
  for (const session of selected) {
    const { path } = session
    for (const record of ownEvents(session)) {
      firstTime = firstTime === undefined ? record.time : Math.min(firstTime, record.time)
      lastTime = lastTime === undefined ? record.time : Math.max(lastTime, record.time)
      if (isNativeMaxTokenContinuation(record)) nativeMaxTokenContinuations += 1
      if (record?.surfaceOp?.op === 'replace') surfaceReplacements += 1
      if (record.type === 'todo/write') {
        todoWrites += 1
        const todos = record.data?.todos
        const statuses = Array.isArray(todos) ? todos.map(todo => todo?.status) : []
        const allCompleted = statuses.length >= 2 && statuses.every(status => status === 'completed')
        const active = statuses.flatMap((status, index) => status === 'in_progress' ? [index] : [])
        const ordered = allCompleted || (statuses.length >= 2
          && active.length === 1
          && statuses.slice(0, active[0]).every(status => status === 'completed')
          && statuses.slice(active[0] + 1).every(status => status === 'pending'))
        if (!ordered) invalidTodoWrites.push({ sessionId: session.header.id, seq: record.seq, statuses })
        if (allCompleted) completedTodoWrites += 1
      }
      if (record.type === 'tool/call' && typeof record.data?.name === 'string'
        && record.data.name.startsWith('lattice_')) {
        controlToolCalls.push({ sessionId: session.header.id, seq: record.seq, name: record.data.name })
      }
      if (record.type !== 'assistant/message' && record.type !== 'compaction/summary') continue
      if (record.type === 'compaction/summary') compactionSummaries += 1
      modelTurns += 1
      const usage = usageOf(record, path)
      if (!usage) {
        missingUsageEvents += 1
        continue
      }
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
    }
  }
  const terminalSessionId = options.terminalSessionId
    ?? (selected.length === 1 ? selected[0].header.id : undefined)
  if (terminalSessionId !== undefined
    && !selected.some(session => session.header.id === terminalSessionId)) {
    throw new Error(`terminal session ${terminalSessionId} is not in the selected persistent sessions`)
  }
  const terminal = terminalSessionId === undefined
    ? undefined
    : selected.find(session => session.header.id === terminalSessionId)
      ? ownEvents(selected.find(session => session.header.id === terminalSessionId))
        .filter(event => event.type === 'turn/end').at(-1)
      : undefined
  return {
    files: selected.map(session => session.path),
    sessions: selected.map(session => ({
      id: session.header.id,
      parentSession: session.header.parentSession ?? null,
      origin: session.header.origin ?? null,
      delegationDepth: session.header.delegationDepth ?? 0,
      seedLength: session.header.seedLength ?? 0,
      ownEventCount: ownEvents(session).length,
      subagentDescriptor: ownEvents(session).some(event => event.type === 'subagent/descriptor'),
      initialUserTextSha256: (() => {
        const message = ownEvents(session)
          .find(event => event.type === 'user/message')
        const text = message === undefined ? undefined : messageText(message.data)
        return text === undefined ? null : digestText(text)
      })(),
      initialUserSourceKind: (() => {
        const message = ownEvents(session)
          .find(event => event.type === 'user/message')
        const source = message === undefined ? undefined : messageSource(message.data)
        return typeof source?.kind === 'string' ? source.kind : null
      })(),
      lastEventTime: ownEvents(session).at(-1)?.time ?? 0,
    })),
    modelTurns,
    inputTokens,
    outputTokens,
    missingUsageEvents,
    compactionSummaries,
    surfaceReplacements,
    todoWrites,
    completedTodoWrites,
    invalidTodoWrites,
    controlToolCalls,
    forbiddenAutomaticControlCalls: controlToolCalls.filter(call => FORBIDDEN_AUTOMATIC_CONTROL_TOOLS.has(call.name)),
    nativeMaxTokenContinuations,
    terminalReason: terminal?.data?.reason,
    transcriptDurationMs: firstTime === undefined || lastTime === undefined ? 0 : Math.max(0, lastTime - firstTime),
  }
}

export async function countClarificationQuestions(path) {
  if (!path) return 0
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  if (text === '') return 0
  if (!text.endsWith('\n')) throw new Error('Oracle question audit is not a complete JSONL artifact')
  const lines = text.split(/\r?\n/).filter(Boolean)
  for (const [index, line] of lines.entries()) {
    const row = parseLine(line, path, index)
    if (!row || typeof row !== 'object' || !/^[0-9a-f]{64}$/.test(row.questionDigest ?? '')) {
      throw new Error(`Oracle question audit contains an invalid record on line ${index + 1}`)
    }
  }
  return lines.length
}
