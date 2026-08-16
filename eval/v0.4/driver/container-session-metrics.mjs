#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function walk(directory) {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return [] }
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.name === 'session.jsonl') files.push(path)
  }
  return files
}

let modelTurns = 0
let inputTokens = 0
let outputTokens = 0
let firstTime
let lastTime
for (const file of await walk(process.argv[2])) {
  for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (Number.isFinite(row.time)) {
      firstTime = firstTime === undefined ? row.time : Math.min(firstTime, row.time)
      lastTime = lastTime === undefined ? row.time : Math.max(lastTime, row.time)
    }
    if (row.type !== 'assistant/message' && row.type !== 'compaction/summary') continue
    modelTurns += 1
    const usage = row.data?.usage ?? {}
    inputTokens += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    outputTokens += usage.outputTokens ?? 0
  }
}
let clarificationQuestions = 0
try {
  clarificationQuestions = (await readFile(process.argv[3], 'utf8')).split(/\r?\n/).filter(Boolean).length
} catch {}
const transcriptDurationMs = firstTime === undefined || lastTime === undefined ? 0 : Math.max(0, lastTime - firstTime)
process.stdout.write(`${JSON.stringify({ modelTurns, inputTokens, outputTokens, clarificationQuestions, transcriptDurationMs })}\n`)
