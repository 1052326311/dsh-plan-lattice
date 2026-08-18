#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readJson, sha256 } from '../../v0.4/lib/canonical.mjs'
import { runHarnessTask } from './lib/runtime.mjs'

const requestPath = process.argv[2]
if (!requestPath) throw new Error('bridge requires an absolute request JSON path')
const request = await readJson(requestPath)
const spec = await readJson(request.specPath)
const pluginCommit = request.arm.plugin === 'none'
  ? undefined
  : request.arm.plugin === 'v0.3.0'
    ? spec.pluginCommits['v0.3.0']
    : spec.pluginCommits['v0.4.0Candidate']
const result = await runHarnessTask({
  runtimeArtifacts: spec.runtimeArtifacts,
  harnessCommit: spec.sourceCommits.harness,
  attemptDir: request.attemptDir ?? dirname(requestPath),
  workspace: request.workspace,
  prompt: request.prompt,
  arm: request.arm,
  pluginCommit,
  sessionId: request.sessionId,
  attemptId: request.attemptId,
  oracle: request.oracle,
  forbiddenReadRoots: request.forbiddenReadRoots ?? [],
  forbiddenNetworkPorts: request.forbiddenNetworkPorts ?? [],
  permissionMode: request.permissionMode,
  timeoutMs: request.timeoutMs ?? spec.model.timeoutMs,
  maxRecoveryEpochs: request.maxRecoveryEpochs ?? 1,
})
process.stdout.write(`${JSON.stringify({
  status: result.status,
  timedOut: result.timedOut,
  stdout: result.stdout,
  stderr: result.stderr,
  metrics: {
    modelTurns: result.modelTurns,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.transcriptDurationMs,
    clarificationQuestions: result.clarificationQuestions,
    pluginIdentity: result.pluginIdentity,
    terminalReason: result.terminalReason,
    sessionEvidenceError: result.sessionEvidenceError,
    recoveryEpochs: result.recoveryEpochs,
    recoveryLedger: result.recoveryLedger === undefined ? undefined : {
      path: result.recoveryLedger,
      sha256: sha256(await readFile(result.recoveryLedger)),
    },
  },
})}\n`)

// Keep an explicit read so checksum provenance covers this executable's bytes.
await readFile(new URL(import.meta.url))
