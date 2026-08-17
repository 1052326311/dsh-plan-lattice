import { describe, expect, it } from 'vitest'
import {
  reconcileDriverPayload,
  summarizeProxyAudit,
} from '../prospective/model-rc4-study/controller-accounting.mjs'

function request(attemptId: string, sequence: number, role: 'agent' | 'oracle') {
  return { event: 'request', attemptId, sequence, role, contractValid: role === 'agent' ? true : undefined }
}

function response(attemptId: string, sequence: number, role: 'agent' | 'oracle', promptTokens: number, completionTokens: number) {
  return { event: 'response', attemptId, sequence, role, status: 200, usage: { promptTokens, completionTokens } }
}

describe('RC.4 controller proxy accounting', () => {
  it('uses paired agent and Oracle responses as authoritative metrics', () => {
    const audit = summarizeProxyAudit([
      request('attempt-1', 1, 'agent'),
      response('attempt-1', 1, 'agent', 11, 3),
      request('attempt-1', 2, 'oracle'),
      response('attempt-1', 2, 'oracle', 7, 2),
    ], 'attempt-1')
    expect(audit).toMatchObject({
      requestCount: 2,
      responseCount: 2,
      agentRequestCount: 1,
      oracleRequestCount: 1,
      modelTurns: 1,
      inputTokens: 11,
      outputTokens: 3,
      oracleInputTokens: 7,
      oracleOutputTokens: 2,
      errors: [],
    })
    const payload = reconcileDriverPayload({
      payload: {
        status: 'failed',
        failure: { classification: 'task', code: 'agent_error', message: 'failed' },
        metrics: { score: 4, maxScore: 10, modelTurns: 99, inputTokens: 99, outputTokens: 99, durationMs: 1 },
        provenance: { taskDigest: 'a'.repeat(64) },
      },
      childStatus: 1,
      audit,
      durationMs: 123.5,
      suite: 'icae',
    })
    expect(payload.metrics).toMatchObject({
      score: 4,
      modelTurns: 1,
      inputTokens: 11,
      outputTokens: 3,
      proxyAgentRequests: 1,
      proxyOracleRequests: 1,
      oracleInputTokens: 7,
      oracleOutputTokens: 2,
      durationMs: 123.5,
    })
    expect(payload.provenance).toEqual({ taskDigest: 'a'.repeat(64) })
  })

  it('detects cross-attempt pairing and duplicate audit keys', () => {
    const crossed = summarizeProxyAudit([
      request('attempt-1', 1, 'agent'),
      response('attempt-2', 1, 'agent', 1, 1),
    ], 'attempt-1')
    expect(crossed.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('has no response'),
      expect.stringContaining('has no request'),
    ]))
    expect(() => summarizeProxyAudit([
      request('attempt-1', 1, 'agent'),
      request('attempt-1', 1, 'agent'),
    ], 'attempt-1')).toThrow('duplicate request')
  })

  it('classifies a valid zero-request execution as preregistered infrastructure failure', () => {
    const audit = summarizeProxyAudit([], 'attempt-1')
    const payload = reconcileDriverPayload({
      payload: {
        status: 'failed',
        failure: { classification: 'task', code: 'driver_error', message: 'second preflight failed' },
        metrics: { score: 2, maxScore: 5 },
        provenance: { taskDigest: 'b'.repeat(64) },
      },
      childStatus: 1,
      audit,
      durationMs: 9,
      suite: 'simple',
    })
    expect(payload).toMatchObject({
      status: 'failed',
      failure: { classification: 'infrastructure', code: 'runner_crash_before_model_call' },
      metrics: {
        score: 2,
        modelTurns: 0,
        proxyAgentRequests: 0,
        proxyOracleRequests: 0,
        durationMs: 9,
      },
      provenance: { taskDigest: 'b'.repeat(64) },
    })
  })
})
