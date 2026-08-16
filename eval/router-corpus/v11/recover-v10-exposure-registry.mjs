#!/usr/bin/env node

import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildExposureRows } from './exposure-registry.mjs'
import { createRestSearchClient, githubToken } from './github-api.mjs'
import {
  assertArtifactsAbsent,
  loadFrozenInputs,
  option,
  sanitizedFailure,
  sha256,
  stableLines,
  writeExclusive,
} from './protocol.mjs'

export async function recoverExposureRegistry({ frozen, search }) {
  const rows = []
  const querySnapshots = []
  for (const definition of [...frozen.v10Spec.searches].sort((left, right) => left.id.localeCompare(right.id))) {
    const response = await search(
      definition.query,
      frozen.spec.v10.exposureSearchPage,
      frozen.spec.searchFrame.resultsPerPage,
    )
    const entries = buildExposureRows(definition, response.data, frozen.spec)
    rows.push(...entries)
    querySnapshots.push({
      queryId: definition.id,
      query: definition.query,
      page: frozen.spec.v10.exposureSearchPage,
      totalCount: response.data.total_count,
      itemCount: entries.length,
      incompleteResults: response.data.incomplete_results,
      truncatedByGitHubCap: response.data.total_count > frozen.spec.searchFrame.githubAccessibleResultLimit,
      rateLimit: response.rateLimit,
    })
  }
  rows.sort((left, right) => left.queryId.localeCompare(right.queryId) || left.rank - right.rank)
  return { rows, querySnapshots }
}

async function main() {
  const registryPath = option('--registry')
  const manifestPath = option('--manifest')
  const failurePath = option('--failure-manifest')
  if ([registryPath, manifestPath, failurePath].some(value => value === undefined)) {
    throw new Error('usage: recover-v10-exposure-registry.mjs --registry <jsonl> --manifest <json> --failure-manifest <json>')
  }
  const outputs = [registryPath, manifestPath, failurePath].map(path => resolve(path))
  await assertArtifactsAbsent(outputs, 'V11 exposure recovery')
  let frozen
  try {
    frozen = await loadFrozenInputs()
    const search = createRestSearchClient({
      token: githubToken(),
      apiVersion: frozen.spec.githubApiVersion,
      minimumRemaining: frozen.spec.limits.searchMinimumRemaining,
    })
    const recovered = await recoverExposureRegistry({ frozen, search })
    const registryText = stableLines(recovered.rows)
    const recoveryBytes = await import('node:fs/promises').then(module => module.readFile(fileURLToPath(import.meta.url)))
    const manifest = {
      schemaVersion: 1,
      protocol: frozen.spec.protocol,
      stage: 'v10-exposure-recovery',
      evidenceStatus: 'v10-exposure-registry-frozen',
      seedAccessed: false,
      queryCount: recovered.querySnapshots.length,
      exposureCount: recovered.rows.length,
      querySnapshots: recovered.querySnapshots,
      digests: {
        v10Spec: sha256(frozen.v10SpecBytes),
        v11Spec: sha256(frozen.specBytes),
        recovery: sha256(recoveryBytes),
        registry: sha256(registryText),
      },
    }
    await writeExclusive(resolve(registryPath), registryText)
    await writeExclusive(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    const failure = sanitizedFailure(error, {
      stage: error?.stage ?? 'exposure-recovery',
      digests: frozen === undefined ? undefined : {
        v10Spec: sha256(frozen.v10SpecBytes),
        v11Spec: sha256(frozen.specBytes),
      },
    })
    await writeExclusive(resolve(failurePath), `${JSON.stringify(failure, null, 2)}\n`)
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`)
    process.exitCode = 2
  }
}

if (basename(process.argv[1] ?? '') === basename(fileURLToPath(import.meta.url))) await main()
