#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAnnotationSet } from './annotation-schema.mjs'
import {
  annotationGates,
  assertArtifactsAbsent,
  here,
  parseJsonLines,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

export const routeCategories = ['non-executable', ...routes]
export const outcomeCriticalCategories = [false, true]
export const ordinalDomains = {
  authorizationEpochs: ['one', 'few', 'many'],
  verificationHorizon: ['immediate', 'staged', 'delayed'],
  staleActionLoss: ['low', 'material', 'irreversible'],
  recovery: ['direct', 'planned', 'unavailable'],
}

const pairDefinitions = [
  { key: '1-2', left: 0, right: 1 },
  { key: '1-3', left: 0, right: 2 },
  { key: '2-3', left: 1, right: 2 },
]

function assertCategories(categories) {
  if (!Array.isArray(categories) || categories.length < 2) {
    throw new Error('categories must contain at least two values')
  }
  if (new Set(categories).size !== categories.length) throw new Error('categories must be unique')
}

function categoryIndexes(categories) {
  assertCategories(categories)
  return new Map(categories.map((category, index) => [category, index]))
}

function normalizeKappa(value) {
  if (Math.abs(value) < Number.EPSILON * 8) return 0
  if (Math.abs(value - 1) < Number.EPSILON * 8) return 1
  if (Math.abs(value + 1) < Number.EPSILON * 8) return -1
  return value
}

function kappaFromAgreement(observedAgreement, expectedAgreement) {
  const denominator = 1 - expectedAgreement
  if (Math.abs(denominator) < Number.EPSILON) return observedAgreement === 1 ? 1 : 0
  return normalizeKappa((observedAgreement - expectedAgreement) / denominator)
}

export function fleissKappaStats(ratings, categories) {
  const indexes = categoryIndexes(categories)
  if (!Array.isArray(ratings) || ratings.length === 0) throw new Error('ratings must contain at least one subject')
  const raters = ratings[0]?.length
  if (!Number.isInteger(raters) || raters < 2) throw new Error('each subject must have at least two ratings')

  const totals = Array(categories.length).fill(0)
  let observedAgreement = 0
  for (const [subjectIndex, subjectRatings] of ratings.entries()) {
    if (!Array.isArray(subjectRatings) || subjectRatings.length !== raters) {
      throw new Error(`ratings[${subjectIndex}] must contain exactly ${raters} ratings`)
    }
    const counts = Array(categories.length).fill(0)
    for (const rating of subjectRatings) {
      const index = indexes.get(rating)
      if (index === undefined) throw new Error(`ratings[${subjectIndex}] contains an unknown category`)
      counts[index] += 1
      totals[index] += 1
    }
    observedAgreement += counts.reduce((sum, count) => sum + count * (count - 1), 0) / (raters * (raters - 1))
  }

  observedAgreement /= ratings.length
  const totalRatings = ratings.length * raters
  const proportions = totals.map(total => total / totalRatings)
  const expectedAgreement = proportions.reduce((sum, proportion) => sum + proportion ** 2, 0)
  return {
    kappa: kappaFromAgreement(observedAgreement, expectedAgreement),
    observedAgreement,
    expectedAgreement,
    subjects: ratings.length,
    raters,
  }
}

export function fleissKappa(ratings, categories) {
  return fleissKappaStats(ratings, categories).kappa
}

export function quadraticWeightedCohenKappaStats(left, right, categories) {
  const indexes = categoryIndexes(categories)
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    throw new Error('paired ratings must be non-empty arrays of equal length')
  }

  const leftCounts = Array(categories.length).fill(0)
  const rightCounts = Array(categories.length).fill(0)
  let observedDisagreement = 0
  const scale = (categories.length - 1) ** 2

  for (let index = 0; index < left.length; index += 1) {
    const leftIndex = indexes.get(left[index])
    const rightIndex = indexes.get(right[index])
    if (leftIndex === undefined || rightIndex === undefined) {
      throw new Error(`paired ratings contain an unknown category at index ${index}`)
    }
    leftCounts[leftIndex] += 1
    rightCounts[rightIndex] += 1
    observedDisagreement += ((leftIndex - rightIndex) ** 2) / scale
  }
  observedDisagreement /= left.length

  let expectedDisagreement = 0
  for (let leftIndex = 0; leftIndex < categories.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < categories.length; rightIndex += 1) {
      const weight = ((leftIndex - rightIndex) ** 2) / scale
      expectedDisagreement += weight
        * (leftCounts[leftIndex] / left.length)
        * (rightCounts[rightIndex] / right.length)
    }
  }

  const kappa = Math.abs(expectedDisagreement) < Number.EPSILON
    ? (observedDisagreement === 0 ? 1 : 0)
    : normalizeKappa(1 - observedDisagreement / expectedDisagreement)
  return { kappa, observedDisagreement, expectedDisagreement, subjects: left.length }
}

export function quadraticWeightedCohenKappa(left, right, categories) {
  return quadraticWeightedCohenKappaStats(left, right, categories).kappa
}

function lowest(items, value) {
  return items.reduce((minimum, item) => value(item) < value(minimum) ? item : minimum)
}

export function computeAgreement(candidateRows, annotationSets) {
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) {
    throw new Error('candidateRows must not be empty')
  }
  if (!Array.isArray(annotationSets) || annotationSets.length !== 3
    || annotationSets.some(set => !(set instanceof Map))) {
    throw new Error('annotationSets must contain exactly three validated maps')
  }

  const routeRatings = candidateRows.map(candidate => annotationSets.map(set => {
    const derived = set.get(candidate.id)?.derived
    if (derived === undefined) throw new Error(`validated annotations are missing ${candidate.id}`)
    return derived.eligible ? derived.route : 'non-executable'
  }))
  const outcomeRatings = candidateRows.map(candidate => annotationSets.map(set => set.get(candidate.id).derived.outcomeCritical))
  const route = {
    method: 'fleiss-kappa',
    categories: routeCategories,
    ...fleissKappaStats(routeRatings, routeCategories),
  }
  const outcomeCritical = {
    method: 'fleiss-kappa',
    categories: outcomeCriticalCategories,
    ...fleissKappaStats(outcomeRatings, outcomeCriticalCategories),
  }

  const fields = {}
  for (const [field, categories] of Object.entries(ordinalDomains)) {
    const pairs = pairDefinitions.map(pair => ({
      pair: pair.key,
      ...quadraticWeightedCohenKappaStats(
        candidateRows.map(candidate => annotationSets[pair.left].get(candidate.id).facts[field]),
        candidateRows.map(candidate => annotationSets[pair.right].get(candidate.id).facts[field]),
        categories,
      ),
    }))
    const minimumPair = lowest(pairs, pair => pair.kappa)
    fields[field] = {
      categories,
      pairs,
      minimumPair: { pair: minimumPair.pair, kappa: minimumPair.kappa },
    }
  }
  const fieldMinimums = Object.entries(fields).map(([field, result]) => ({
    field,
    pair: result.minimumPair.pair,
    kappa: result.minimumPair.kappa,
  }))
  const minimumField = lowest(fieldMinimums, field => field.kappa)

  return {
    route,
    outcomeCritical,
    ordinal: {
      method: 'quadratic-weighted-pairwise-cohen-kappa',
      fields,
      minimumField,
    },
  }
}

export function evaluateAnnotationGates(agreement, gates = annotationGates) {
  const route = agreement.route.kappa >= gates.routeKappaMin
  const outcomeCritical = agreement.outcomeCritical.kappa >= gates.outcomeCriticalKappaMin
  const ordinal = agreement.ordinal.minimumField.kappa >= gates.ordinalWeightedKappaMin
  return {
    route,
    outcomeCritical,
    ordinal,
    allPassed: route && outcomeCritical && ordinal,
  }
}

export function buildAgreementReport(candidateRows, annotationSets, digests) {
  const agreement = computeAgreement(candidateRows, annotationSets)
  const gates = evaluateAnnotationGates(agreement)
  return {
    schemaVersion: 1,
    counts: {
      candidates: candidateRows.length,
      annotators: annotationSets.length,
    },
    thresholds: annotationGates,
    agreement,
    gates,
    digests,
  }
}

export async function runAgreement(annotationPaths) {
  if (!Array.isArray(annotationPaths) || annotationPaths.length !== 3) {
    throw new Error('usage: agreement.mjs <annotations-1.jsonl> <annotations-2.jsonl> <annotations-3.jsonl>')
  }

  const reportPath = resolve(here, 'agreement-report.json')
  await assertArtifactsAbsent([reportPath], 'V6 agreement')
  const candidatePath = resolve(here, 'candidates.jsonl')
  const [candidateText, ...annotationTexts] = await Promise.all([
    readFile(candidatePath, 'utf8'),
    ...annotationPaths.map(path => readFile(resolve(path), 'utf8')),
  ])
  const candidateRows = parseJsonLines(candidateText, 'candidates.jsonl')
  if (candidateRows.length === 0) throw new Error('candidates.jsonl is empty')
  const annotationSets = annotationTexts.map((text, index) => validateAnnotationSet(
    candidateRows,
    parseJsonLines(text, `annotations ${index + 1}`),
    `annotations ${index + 1}`,
  ))
  const report = buildAgreementReport(candidateRows, annotationSets, {
    candidates: sha256(candidateText),
    annotations: annotationTexts.map((text, index) => ({
      annotator: index + 1,
      sha256: sha256(text),
    })),
  })
  await writeExclusive(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main() {
  const report = await runAgreement(process.argv.slice(2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.gates.allPassed) {
    console.error('V6 annotation reliability gates failed; agreement-report.json was preserved')
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
