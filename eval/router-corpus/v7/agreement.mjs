#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAnnotationSet } from './annotation-schema.mjs'
import { factDomains } from './derive-label.mjs'
import {
  assertArtifactsAbsent,
  here,
  parseJsonLines,
  reliabilityGates,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

export const routeCategories = ['non-executable', ...routes]
export const outcomeCategories = [false, true]
const pairDefinitions = [
  { key: '1-2', left: 0, right: 1 },
  { key: '1-3', left: 0, right: 2 },
  { key: '2-3', left: 1, right: 2 },
]

function categoryIndexes(categories) {
  if (!Array.isArray(categories) || categories.length < 2 || new Set(categories).size !== categories.length) {
    throw new Error('categories must contain at least two unique values')
  }
  return new Map(categories.map((category, index) => [category, index]))
}

function normalized(value) {
  if (Math.abs(value) < Number.EPSILON * 8) return 0
  if (Math.abs(value - 1) < Number.EPSILON * 8) return 1
  if (Math.abs(value + 1) < Number.EPSILON * 8) return -1
  return value
}

function ratingStats(ratings, categories) {
  const indexes = categoryIndexes(categories)
  if (!Array.isArray(ratings) || ratings.length === 0) throw new Error('ratings must not be empty')
  const raters = ratings[0]?.length
  if (!Number.isInteger(raters) || raters < 2) throw new Error('each subject requires at least two ratings')
  const totals = Array(categories.length).fill(0)
  let observedAgreement = 0
  let unanimous = 0
  for (const [subjectIndex, subjectRatings] of ratings.entries()) {
    if (!Array.isArray(subjectRatings) || subjectRatings.length !== raters) {
      throw new Error(`ratings[${subjectIndex}] must contain exactly ${raters} values`)
    }
    const counts = Array(categories.length).fill(0)
    for (const rating of subjectRatings) {
      const index = indexes.get(rating)
      if (index === undefined) throw new Error(`ratings[${subjectIndex}] contains an unknown category`)
      counts[index] += 1
      totals[index] += 1
    }
    if (Math.max(...counts) === raters) unanimous += 1
    observedAgreement += counts.reduce((sum, count) => sum + count * (count - 1), 0) / (raters * (raters - 1))
  }
  observedAgreement /= ratings.length
  const proportions = totals.map(total => total / (ratings.length * raters))
  return {
    observedAgreement,
    proportions,
    subjects: ratings.length,
    raters,
    unanimous: { count: unanimous, rate: unanimous / ratings.length },
  }
}

export function fleissKappaStats(ratings, categories) {
  const base = ratingStats(ratings, categories)
  const expectedAgreement = base.proportions.reduce((sum, proportion) => sum + proportion ** 2, 0)
  const denominator = 1 - expectedAgreement
  const kappa = Math.abs(denominator) < Number.EPSILON
    ? (base.observedAgreement === 1 ? 1 : 0)
    : normalized((base.observedAgreement - expectedAgreement) / denominator)
  return { method: 'fleiss-kappa', kappa, expectedAgreement, ...base }
}

export function gwetAc1Stats(ratings, categories) {
  const base = ratingStats(ratings, categories)
  const chanceAgreement = base.proportions.reduce(
    (sum, proportion) => sum + proportion * (1 - proportion),
    0,
  ) / (categories.length - 1)
  const denominator = 1 - chanceAgreement
  const ac1 = Math.abs(denominator) < Number.EPSILON
    ? (base.observedAgreement === 1 ? 1 : 0)
    : normalized((base.observedAgreement - chanceAgreement) / denominator)
  return { method: 'gwet-ac1', ac1, chanceAgreement, ...base }
}

function pairwiseConfusions(ratings, categories) {
  const indexes = categoryIndexes(categories)
  return pairDefinitions.map(pair => {
    const matrix = Object.fromEntries(categories.map(left => [String(left), Object.fromEntries(
      categories.map(right => [String(right), 0]),
    )]))
    let exact = 0
    for (const row of ratings) {
      const left = row[pair.left]
      const right = row[pair.right]
      if (!indexes.has(left) || !indexes.has(right)) throw new Error('pairwise ratings contain an unknown category')
      matrix[String(left)][String(right)] += 1
      if (left === right) exact += 1
    }
    return { pair: pair.key, exact: { count: exact, rate: exact / ratings.length }, matrix }
  })
}

function metric(ratings, categories) {
  const kappa = fleissKappaStats(ratings, categories)
  const ac1 = gwetAc1Stats(ratings, categories)
  return {
    categories,
    fleissKappa: kappa,
    gwetAc1: ac1,
    unanimous: kappa.unanimous,
    pairwiseConfusions: pairwiseConfusions(ratings, categories),
  }
}

function routeValue(annotation) {
  return annotation.derived.eligible ? annotation.derived.route : 'non-executable'
}

export function computeAgreement(candidateRows, annotationSets) {
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) throw new Error('candidateRows must not be empty')
  if (!Array.isArray(annotationSets) || annotationSets.length !== 3
    || annotationSets.some(set => !(set instanceof Map))) {
    throw new Error('annotationSets must contain exactly three validated maps')
  }
  const ratingsFor = value => candidateRows.map(candidate => annotationSets.map(set => value(set.get(candidate.id))))
  const primitives = Object.fromEntries(Object.entries(factDomains).map(([field, categories]) => [
    field,
    metric(ratingsFor(annotation => annotation.facts[field]), categories),
  ]))
  return {
    route: metric(ratingsFor(routeValue), routeCategories),
    outcomeCritical: metric(ratingsFor(annotation => annotation.derived.outcomeCritical), outcomeCategories),
    primitives,
  }
}

function gateMetric(metricValue, { kappaMin, ac1Min, unanimousMin }) {
  return {
    kappa: metricValue.fleissKappa.kappa >= kappaMin,
    ac1: metricValue.gwetAc1.ac1 >= ac1Min,
    unanimous: metricValue.unanimous.rate >= unanimousMin,
  }
}

export function evaluateReliabilityGates(agreement, gates = reliabilityGates) {
  const route = gateMetric(agreement.route, {
    kappaMin: gates.routeKappaMin,
    ac1Min: gates.routeAc1Min,
    unanimousMin: gates.routeUnanimousMin,
  })
  const primitives = Object.fromEntries(Object.entries(agreement.primitives).map(([field, value]) => [
    field,
    gateMetric(value, {
      kappaMin: gates.primitiveKappaMin,
      ac1Min: gates.primitiveAc1Min,
      unanimousMin: gates.primitiveUnanimousMin,
    }),
  ]))
  const allFlags = [route, ...Object.values(primitives)].flatMap(value => Object.values(value))
  return { route, primitives, allPassed: allFlags.every(Boolean) }
}

export function buildAgreementReport(candidateRows, annotationSets, digests) {
  const agreement = computeAgreement(candidateRows, annotationSets)
  return {
    schemaVersion: 1,
    counts: { candidates: candidateRows.length, annotators: annotationSets.length },
    thresholds: reliabilityGates,
    agreement,
    gates: evaluateReliabilityGates(agreement),
    digests,
  }
}

export async function runAgreement(candidatePath, annotationPaths, outputPath) {
  if (!Array.isArray(annotationPaths) || annotationPaths.length !== 3) {
    throw new Error('agreement requires exactly three annotation files')
  }
  await assertArtifactsAbsent([outputPath], 'V7 agreement')
  const [candidateText, ...annotationTexts] = await Promise.all([
    readFile(candidatePath, 'utf8'),
    ...annotationPaths.map(path => readFile(path, 'utf8')),
  ])
  const candidateRows = parseJsonLines(candidateText, candidatePath)
  const annotationSets = annotationTexts.map((text, index) => validateAnnotationSet(
    candidateRows,
    parseJsonLines(text, annotationPaths[index]),
    `annotations ${index + 1}`,
  ))
  const report = buildAgreementReport(candidateRows, annotationSets, {
    candidates: sha256(candidateText),
    annotations: annotationTexts.map((text, index) => ({ annotator: index + 1, sha256: sha256(text) })),
  })
  await writeExclusive(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main() {
  if (process.argv.length !== 7) {
    throw new Error('usage: agreement.mjs <candidates> <annotations-1> <annotations-2> <annotations-3> <output>')
  }
  const [candidate, ...rest] = process.argv.slice(2).map(path => resolve(path))
  const output = rest.pop()
  const report = await runAgreement(candidate, rest, output)
  console.log(JSON.stringify(report, null, 2))
  if (!report.gates.allPassed) process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
