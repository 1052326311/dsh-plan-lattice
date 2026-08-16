#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { ProtocolFailure } from './protocol.mjs'

export function githubToken() {
  const token = execFileSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (token === '') throw new Error('gh auth token returned an empty credential')
  return token
}

function restRateLimit(response) {
  const reset = response.headers.get('x-ratelimit-reset')
  return {
    resource: response.headers.get('x-ratelimit-resource') ?? 'unknown',
    limit: Number(response.headers.get('x-ratelimit-limit') ?? 'NaN'),
    remaining: Number(response.headers.get('x-ratelimit-remaining') ?? 'NaN'),
    used: Number(response.headers.get('x-ratelimit-used') ?? 'NaN'),
    resetAt: reset !== null && Number.isFinite(Number(reset))
      ? new Date(Number(reset) * 1000).toISOString()
      : null,
  }
}

function validRateLimit(rateLimit) {
  return Number.isFinite(rateLimit.limit) && Number.isFinite(rateLimit.remaining)
    && Number.isFinite(rateLimit.used) && typeof rateLimit.resetAt === 'string'
}

export function createRestSearchClient({ token, apiVersion, minimumRemaining, fetchImpl = fetch }) {
  return async function search(query, page, perPage) {
    const url = new URL('https://api.github.com/search/issues')
    url.searchParams.set('q', query)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(perPage))
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': apiVersion,
        'user-agent': 'dsh-plan-lattice-v11-source-frame',
      },
    })
    const rateLimit = restRateLimit(response)
    if (!validRateLimit(rateLimit)) {
      throw new ProtocolFailure('search-rate-limit-metadata-missing', 'GitHub Search response omitted precise rate-limit metadata', {
        stage: 'search', operation: `GET /search/issues page=${page}`, rateLimit,
      })
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300).replaceAll(token, '<redacted>')
      throw new ProtocolFailure(response.status === 403 || response.status === 429
        ? 'search-rate-limit-exhausted'
        : 'search-http-error', `GitHub Search returned HTTP ${response.status}: ${body}`, {
        stage: 'search', operation: `GET /search/issues page=${page}`, rateLimit,
      })
    }
    const data = await response.json()
    if (rateLimit.remaining < minimumRemaining) {
      throw new ProtocolFailure('search-rate-limit-reserve-exhausted', `GitHub Search quota fell below reserve ${minimumRemaining}`, {
        stage: 'search', operation: `GET /search/issues page=${page}`, rateLimit,
      })
    }
    return { data, rateLimit }
  }
}

export function createGraphqlClient({ token, minimumRemaining, query, fetchImpl = fetch }) {
  return async function graphql(ids, variables) {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'dsh-plan-lattice-v11-source-frame',
      },
      body: JSON.stringify({ query, variables: { ...variables, ids } }),
    })
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300).replaceAll(token, '<redacted>')
      throw new ProtocolFailure('graphql-http-error', `GitHub GraphQL returned HTTP ${response.status}: ${body}`, {
        stage: 'graphql', operation: `POST /graphql nodes=${ids.length}`,
      })
    }
    const payload = await response.json()
    const rateLimit = payload.data?.rateLimit
    if (payload.errors?.length > 0) {
      throw new ProtocolFailure('graphql-response-errors', payload.errors.map(error => error.message).join('; '), {
        stage: 'graphql', operation: `POST /graphql nodes=${ids.length}`, rateLimit,
      })
    }
    if (!rateLimit || !Number.isFinite(rateLimit.cost) || !Number.isFinite(rateLimit.remaining)
      || typeof rateLimit.resetAt !== 'string') {
      throw new ProtocolFailure('graphql-rate-limit-metadata-missing', 'GraphQL response omitted precise rate-limit metadata', {
        stage: 'graphql', operation: `POST /graphql nodes=${ids.length}`, rateLimit,
      })
    }
    if (rateLimit.remaining < minimumRemaining) {
      throw new ProtocolFailure('graphql-rate-limit-reserve-exhausted', `GraphQL quota fell below reserve ${minimumRemaining}`, {
        stage: 'graphql', operation: `POST /graphql nodes=${ids.length}`, rateLimit,
      })
    }
    return { nodes: payload.data.nodes, rateLimit }
  }
}
