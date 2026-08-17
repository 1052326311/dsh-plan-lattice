function auditKey(entry) {
  if (typeof entry?.attemptId !== 'string'
    || !Number.isSafeInteger(entry.sequence)
    || entry.sequence < 1
    || !['agent', 'oracle'].includes(entry.role)) {
    throw new Error('proxy audit entry has an invalid attemptId, sequence, or role')
  }
  return `${entry.attemptId}\0${entry.sequence}\0${entry.role}`
}

function finiteUsage(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function summarizeProxyAudit(fullAudit, attemptId) {
  if (!Array.isArray(fullAudit)) throw new Error('proxy audit must be an array')
  const pairs = new Map()
  for (const entry of fullAudit) {
    if (!['request', 'response'].includes(entry?.event)) throw new Error(`proxy audit contains unknown event ${entry?.event}`)
    const key = auditKey(entry)
    const pair = pairs.get(key) ?? { request: undefined, response: undefined }
    if (pair[entry.event]) throw new Error(`proxy audit contains duplicate ${entry.event} for ${key}`)
    pair[entry.event] = entry
    pairs.set(key, pair)
  }

  const attemptPairs = [...pairs.entries()]
    .filter(([, pair]) => pair.request?.attemptId === attemptId || pair.response?.attemptId === attemptId)
    .sort(([, left], [, right]) => (left.request ?? left.response).sequence - (right.request ?? right.response).sequence)
  const errors = []
  for (const [key, pair] of pairs) {
    if (!pair.request) errors.push(`proxy response has no request for ${key}`)
    if (!pair.response) errors.push(`proxy request has no response for ${key}`)
  }
  const requests = attemptPairs.flatMap(([, pair]) => pair.request ? [pair.request] : [])
  const responses = attemptPairs.flatMap(([, pair]) => pair.response ? [pair.response] : [])
  const agentResponses = responses.filter(entry => entry.role === 'agent')
  const oracleResponses = responses.filter(entry => entry.role === 'oracle')
  const oracleRequests = requests.filter(entry => entry.role === 'oracle')
  const invalidResponses = responses.filter(entry => entry.status < 200 || entry.status >= 300 || entry.usage === null)
  const invalidRequests = requests.filter(entry => entry.attemptId !== attemptId
    || (entry.role === 'agent' && entry.contractValid !== true))
  if (invalidResponses.length > 0) errors.push('proxy audit contains unsuccessful responses or missing usage')
  if (invalidRequests.length > 0) errors.push('proxy audit contains requests outside the frozen attempt contract')

  return {
    attemptId,
    entries: attemptPairs.flatMap(([, pair]) => [pair.request, pair.response].filter(Boolean)),
    requestCount: requests.length,
    responseCount: responses.length,
    agentRequestCount: requests.filter(entry => entry.role === 'agent').length,
    agentResponseCount: agentResponses.length,
    oracleRequestCount: oracleRequests.length,
    modelTurns: agentResponses.length,
    inputTokens: agentResponses.reduce((sum, entry) => sum + finiteUsage(entry.usage?.promptTokens), 0),
    outputTokens: agentResponses.reduce((sum, entry) => sum + finiteUsage(entry.usage?.completionTokens), 0),
    oracleInputTokens: oracleResponses.reduce((sum, entry) => sum + finiteUsage(entry.usage?.promptTokens), 0),
    oracleOutputTokens: oracleResponses.reduce((sum, entry) => sum + finiteUsage(entry.usage?.completionTokens), 0),
    errors,
  }
}

function retained(value, key) {
  return value && Object.prototype.hasOwnProperty.call(value, key) ? { [key]: value[key] } : {}
}

export function reconcileDriverPayload({
  payload,
  childStatus,
  audit,
  durationMs,
  proxyControlFailure = false,
  suite,
}) {
  const base = payload && typeof payload === 'object'
    ? structuredClone(payload)
    : {
        status: 'failed',
        failure: {
          classification: 'task',
          code: 'driver_output_unusable_after_execution',
          message: 'Driver output was not a JSON object',
        },
      }
  const metrics = {
    ...(base.metrics && typeof base.metrics === 'object' ? base.metrics : {}),
    modelTurns: audit.modelTurns,
    inputTokens: audit.inputTokens,
    outputTokens: audit.outputTokens,
    proxyAgentRequests: audit.agentRequestCount,
    proxyOracleRequests: audit.oracleRequestCount,
    oracleInputTokens: audit.oracleInputTokens,
    oracleOutputTokens: audit.oracleOutputTokens,
    durationMs,
  }
  let normalized = { ...base, metrics }

  if (childStatus !== 0 && normalized.status === 'completed') {
    normalized = {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'driver_exit_after_execution',
        message: `Driver exited with status ${childStatus}`,
      },
      metrics,
      ...retained(base, 'provenance'),
    }
  }

  const invalidOracleUse = suite === 'icae' ? audit.oracleRequestCount > 5 : audit.oracleRequestCount > 0
  if (audit.errors.length > 0 || invalidOracleUse || proxyControlFailure) {
    return {
      status: 'failed',
      failure: {
        classification: 'task',
        code: 'model_request_accounting_mismatch',
        message: 'Complete credential-proxy audit did not match the frozen attempt and response accounting contract',
      },
      metrics,
      ...retained(base, 'provenance'),
    }
  }
  if (audit.requestCount === 0) {
    return {
      status: 'failed',
      failure: {
        classification: 'infrastructure',
        code: 'runner_crash_before_model_call',
        message: 'Driver setup or its second preflight failed before the credential proxy observed a model request',
      },
      metrics,
      ...retained(base, 'provenance'),
    }
  }
  return normalized
}
