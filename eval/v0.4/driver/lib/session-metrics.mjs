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
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.name === 'session.jsonl') files.push(path)
  }
  return files
}

function usageOf(record) {
  const usage = record?.data?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const number = (key) => Number.isFinite(usage[key]) ? usage[key] : 0
  return {
    inputTokens: number('inputTokens') + number('cacheReadTokens') + number('cacheWriteTokens'),
    outputTokens: number('outputTokens'),
  }
}

export async function parseSessionMetrics(root) {
  const files = await walk(root)
  let modelTurns = 0
  let inputTokens = 0
  let outputTokens = 0
  let firstTime
  let lastTime
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (Number.isFinite(record.time)) {
        firstTime = firstTime === undefined ? record.time : Math.min(firstTime, record.time)
        lastTime = lastTime === undefined ? record.time : Math.max(lastTime, record.time)
      }
      if (record.type !== 'assistant/message' && record.type !== 'compaction/summary') continue
      modelTurns += 1
      const usage = usageOf(record)
      if (usage) {
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
      }
    }
  }
  return {
    files,
    modelTurns,
    inputTokens,
    outputTokens,
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
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}
