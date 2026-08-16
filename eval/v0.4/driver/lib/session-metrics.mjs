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

export async function parseSessionMetrics(root, options = {}) {
  const files = await walk(root)
  if (files.length === 0) throw new Error('Harness produced no persistent session.jsonl artifact')
  const sessions = []
  for (const path of files) sessions.push({ path, ...parseSession(await readFile(path, 'utf8'), path) })
  const selected = options.expectedSessionId === undefined
    ? sessions
    : sessions.filter(session => session.header.id === options.expectedSessionId)
  if (options.expectedSessionId && selected.length === 0) {
    throw new Error(`persistent sessions do not contain expected session ${options.expectedSessionId}`)
  }
  if (options.expectedSessionId && selected.length !== 1) {
    throw new Error(`persistent sessions contain duplicate expected session ${options.expectedSessionId}`)
  }
  let modelTurns = 0
  let inputTokens = 0
  let outputTokens = 0
  let missingUsageEvents = 0
  let firstTime
  let lastTime
  for (const session of selected) {
    const { path } = session
    for (const record of session.events) {
      firstTime = firstTime === undefined ? record.time : Math.min(firstTime, record.time)
      lastTime = lastTime === undefined ? record.time : Math.max(lastTime, record.time)
      if (record.type !== 'assistant/message' && record.type !== 'compaction/summary') continue
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
  const terminal = selected.length === 1
    ? selected[0].events.filter(event => event.type === 'turn/end').at(-1)
    : undefined
  return {
    files: selected.map(session => session.path),
    modelTurns,
    inputTokens,
    outputTokens,
    missingUsageEvents,
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
