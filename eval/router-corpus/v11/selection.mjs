import {
  assertSha256,
  canonical,
  nonEmptyString,
  sha256,
} from './pipeline-common.mjs'

export const requiredExposureProtocol = 'observable-authorization-v10'
export const requiredExposureStatus = 'complete-raw-search-exposure-registry'

function sortedUniqueStrings(values, context) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${context} must be a non-empty array`)
  const normalized = values.map((value, index) => nonEmptyString(value, `${context}[${index}]`))
  if (new Set(normalized).size !== normalized.length) throw new Error(`${context} must not contain duplicates`)
  return normalized.sort()
}

function normalizedFamily(value, context) {
  return nonEmptyString(value, context).toLowerCase()
}

export function bindV10ExposureRegistry(registryText, binding) {
  const expectedDigest = assertSha256(binding?.sha256, 'V10 exposure registry binding')
  const actualDigest = sha256(registryText)
  if (actualDigest !== expectedDigest) throw new Error('V10 exposure registry digest mismatch')

  let registry
  try {
    registry = JSON.parse(registryText)
  } catch (error) {
    throw new Error('V10 exposure registry is not valid JSON', { cause: error })
  }
  if (registry?.schemaVersion !== 1
    || registry.protocol !== requiredExposureProtocol
    || registry.evidenceStatus !== requiredExposureStatus) {
    throw new Error('V10 exposure registry identity or completeness status is invalid')
  }
  const searchIds = sortedUniqueStrings(registry.coverage?.searchIds, 'V10 exposure registry coverage.searchIds')
  const expectedSearchIds = sortedUniqueStrings(binding.searchIds, 'V10 exposure registry binding.searchIds')
  if (canonical(searchIds) !== canonical(expectedSearchIds)) {
    throw new Error('V10 exposure registry search coverage differs from the frozen binding')
  }
  if (registry.coverage.complete !== true) throw new Error('V10 exposure registry is not complete')
  if (!Number.isInteger(registry.coverage.rawSearchCandidateCount)
    || registry.coverage.rawSearchCandidateCount <= 0) {
    throw new Error('V10 exposure registry raw candidate count is invalid')
  }

  const families = sortedUniqueStrings(
    registry.rawSearchCandidateFamilies,
    'V10 exposure registry rawSearchCandidateFamilies',
  ).map(value => normalizedFamily(value, 'V10 exposure family'))
  if (new Set(families).size !== families.length) throw new Error('V10 exposure registry has canonical family duplicates')
  if (registry.coverage.uniqueFamilyCount !== families.length
    || registry.coverage.rawSearchCandidateCount < families.length) {
    throw new Error('V10 exposure registry coverage counts do not bind the family inventory')
  }
  return {
    digest: actualDigest,
    familyIds: new Set(families),
    registry,
  }
}

function matches(row, match) {
  return Object.entries(match).every(([field, expected]) => {
    const actual = row[field]
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected
  })
}

function validateStrata(strata) {
  if (!Array.isArray(strata) || strata.length === 0) throw new Error('selection strata must be a non-empty array')
  const ids = new Set()
  return strata.map((stratum, index) => {
    const id = nonEmptyString(stratum?.id, `strata[${index}].id`)
    if (ids.has(id)) throw new Error(`selection strata duplicate ${id}`)
    ids.add(id)
    if (!Number.isInteger(stratum.count) || stratum.count <= 0) throw new Error(`strata[${index}].count must be positive`)
    if (stratum.match === null || typeof stratum.match !== 'object' || Array.isArray(stratum.match)) {
      throw new Error(`strata[${index}].match must be an object`)
    }
    for (const [dimension, cap] of Object.entries(stratum.caps ?? {})) {
      nonEmptyString(dimension, `strata[${index}] cap dimension`)
      if (!Number.isInteger(cap) || cap <= 0) throw new Error(`strata[${index}].caps.${dimension} must be positive`)
    }
    for (const [dimension, minimum] of Object.entries(stratum.minimumDistinct ?? {})) {
      nonEmptyString(dimension, `strata[${index}] diversity dimension`)
      if (!Number.isInteger(minimum) || minimum <= 0) {
        throw new Error(`strata[${index}].minimumDistinct.${dimension} must be positive`)
      }
    }
    return {
      id,
      count: stratum.count,
      match: { ...stratum.match },
      caps: { ...(stratum.caps ?? {}) },
      minimumDistinct: { ...(stratum.minimumDistinct ?? {}) },
    }
  })
}

function validateCaps(caps, context) {
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) throw new Error(`${context} must be an object`)
  for (const [dimension, cap] of Object.entries(caps)) {
    nonEmptyString(dimension, `${context} dimension`)
    if (!Number.isInteger(cap) || cap <= 0) throw new Error(`${context}.${dimension} must be positive`)
  }
  return { ...caps }
}

function rowDimension(row, dimension, context) {
  return nonEmptyString(row[dimension], `${context}.${dimension}`).toLowerCase()
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('source frame must be a non-empty array')
  const sources = new Set()
  return rows.map((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`source frame:${index + 1} must be an object`)
    const stableSourceId = nonEmptyString(row.stableSourceId, `source frame:${index + 1}.stableSourceId`)
    normalizedFamily(row.sourceFamilyId, `source frame:${index + 1}.sourceFamilyId`)
    nonEmptyString(row.language, `source frame:${index + 1}.language`)
    if (typeof row.text !== 'string' || row.text.trim().length < 1) throw new Error(`source frame:${index + 1}.text is empty`)
    if (sources.has(stableSourceId)) throw new Error(`source frame duplicates ${stableSourceId}`)
    sources.add(stableSourceId)
    return row
  })
}

export function prepareSelection({
  rows,
  strata,
  exposureRegistryText,
  exposureRegistryBinding,
}) {
  const validatedRows = validateRows(rows)
  const validatedStrata = validateStrata(strata)
  const exposure = bindV10ExposureRegistry(exposureRegistryText, exposureRegistryBinding)
  const excluded = []
  const eligible = []
  for (const row of validatedRows) {
    if (exposure.familyIds.has(normalizedFamily(row.sourceFamilyId, `${row.stableSourceId}.sourceFamilyId`))) excluded.push(row)
    else eligible.push(row)
  }

  const buckets = new Map(validatedStrata.map(stratum => [stratum.id, []]))
  for (const row of eligible) {
    const matching = validatedStrata.filter(stratum => matches(row, stratum.match))
    if (matching.length > 1) throw new Error(`${row.stableSourceId} matches multiple frozen strata`)
    if (matching.length === 1) buckets.get(matching[0].id).push(row)
  }
  for (const stratum of validatedStrata) {
    const bucket = buckets.get(stratum.id)
    if (bucket.length < stratum.count) {
      throw new Error(`${stratum.id} has ${bucket.length} post-exposure rows; requires ${stratum.count}`)
    }
    for (const [dimension, minimum] of Object.entries(stratum.minimumDistinct)) {
      const count = new Set(bucket.map(row => rowDimension(row, dimension, `${stratum.id}/${row.stableSourceId}`))).size
      if (count < minimum) throw new Error(`${stratum.id} has ${count} distinct ${dimension}; requires ${minimum}`)
    }
  }
  return {
    exposureRegistryDigest: exposure.digest,
    exposureFamilyCount: exposure.familyIds.size,
    excluded,
    eligible,
    strata: validatedStrata,
    buckets,
  }
}

function deterministicKey(seed, stratum, sourceId) {
  return sha256(`${seed}\n${stratum}\n${sourceId}`)
}

function withinCaps(row, caps, counters, context) {
  return Object.entries(caps).every(([dimension, cap]) => {
    const value = rowDimension(row, dimension, context)
    return (counters.get(dimension)?.get(value) ?? 0) < cap
  })
}

function incrementCaps(row, caps, counters, context) {
  for (const dimension of Object.keys(caps)) {
    const values = counters.get(dimension) ?? new Map()
    const value = rowDimension(row, dimension, context)
    values.set(value, (values.get(value) ?? 0) + 1)
    counters.set(dimension, values)
  }
}

function selectPrepared(prepared, seed, globalCaps) {
  const selected = []
  const selectedSources = new Set()
  const selectedFamilies = new Set()
  const globalCounters = new Map()
  for (const stratum of prepared.strata) {
    const localCounters = new Map()
    const ordered = [...prepared.buckets.get(stratum.id)].sort((left, right) => {
      const comparison = deterministicKey(seed, stratum.id, left.stableSourceId)
        .localeCompare(deterministicKey(seed, stratum.id, right.stableSourceId))
      return comparison || left.stableSourceId.localeCompare(right.stableSourceId)
    })
    let count = 0
    for (const row of ordered) {
      const family = normalizedFamily(row.sourceFamilyId, `${row.stableSourceId}.sourceFamilyId`)
      if (selectedSources.has(row.stableSourceId) || selectedFamilies.has(family)) continue
      if (!withinCaps(row, stratum.caps, localCounters, `${stratum.id}/${row.stableSourceId}`)) continue
      if (!withinCaps(row, globalCaps, globalCounters, `${stratum.id}/${row.stableSourceId}`)) continue
      selected.push({ stratum: stratum.id, row })
      selectedSources.add(row.stableSourceId)
      selectedFamilies.add(family)
      incrementCaps(row, stratum.caps, localCounters, `${stratum.id}/${row.stableSourceId}`)
      incrementCaps(row, globalCaps, globalCounters, `${stratum.id}/${row.stableSourceId}`)
      count += 1
      if (count === stratum.count) break
    }
    if (count !== stratum.count) {
      throw new Error(`${stratum.id} selected ${count} under frozen caps; requires ${stratum.count}`)
    }
  }
  return selected
}

export async function assembleDeterministicSelection({
  rows,
  strata,
  globalCaps = {},
  exposureRegistryText,
  exposureRegistryBinding,
  selectionSeedCommitment,
  loadSelectionSeed,
}) {
  const prepared = prepareSelection({ rows, strata, exposureRegistryText, exposureRegistryBinding })
  const validatedGlobalCaps = validateCaps(globalCaps, 'global caps')
  assertSha256(selectionSeedCommitment, 'selection seed commitment')
  if (typeof loadSelectionSeed !== 'function') throw new Error('loadSelectionSeed must be a function')
  const seed = nonEmptyString(await loadSelectionSeed(), 'selection seed')
  if (sha256(seed) !== selectionSeedCommitment) throw new Error('selection seed does not match its frozen commitment')
  const selected = selectPrepared(prepared, seed, validatedGlobalCaps)
  const selectedIds = new Set(selected.map(value => value.row.stableSourceId))
  const candidates = selected.map(({ row }) => ({
    id: `v11-${sha256(row.stableSourceId).slice(0, 20)}`,
    language: row.language,
    text: row.text,
  })).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(candidates.map(row => row.id)).size !== candidates.length) throw new Error('candidate ID collision')
  const candidateIdBySource = new Map(selected.map(({ row }) => [
    row.stableSourceId,
    `v11-${sha256(row.stableSourceId).slice(0, 20)}`,
  ]))
  const sources = selected.map(({ stratum, row }) => ({
    candidateId: candidateIdBySource.get(row.stableSourceId),
    stratum,
    ...row,
  })).sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  const ledger = rows.map(row => ({
    stableSourceId: row.stableSourceId,
    sourceFamilyId: row.sourceFamilyId,
    excludedByV10Exposure: prepared.excluded.includes(row),
    selected: selectedIds.has(row.stableSourceId),
  })).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  return {
    candidates,
    sources,
    ledger,
    counts: Object.fromEntries(prepared.strata.map(stratum => [
      stratum.id,
      selected.filter(value => value.stratum === stratum.id).length,
    ])),
    exposureRegistryDigest: prepared.exposureRegistryDigest,
    selectionSeedCommitment,
  }
}
