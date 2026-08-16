#!/usr/bin/env node
import { countClarificationQuestions, parseSessionMetrics } from './lib/session-metrics.mjs'

const sessionsRoot = process.argv[2]
const questionAudit = process.argv[3]
const expectedSessionId = process.argv[4]
if (!sessionsRoot || !questionAudit || !expectedSessionId) {
  throw new Error('usage: session-metrics.mjs <sessions-root> <question-audit> <expected-session-id>')
}

const metrics = await parseSessionMetrics(sessionsRoot, { expectedSessionId })
if (metrics.modelTurns < 1) throw new Error('Harness produced no durable model turn')
if (metrics.missingUsageEvents !== 0) throw new Error('Harness model events omitted durable token usage')
const clarificationQuestions = await countClarificationQuestions(questionAudit)
process.stdout.write(`${JSON.stringify({
  modelTurns: metrics.modelTurns,
  inputTokens: metrics.inputTokens,
  outputTokens: metrics.outputTokens,
  clarificationQuestions,
  transcriptDurationMs: metrics.transcriptDurationMs,
})}\n`)
