#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateAnnotationSet } from './annotation-schema.mjs'
import { factDomains } from './derive-label.mjs'
import {
  assertArtifactsAbsent,
  languages,
  parseJsonLines,
  reliabilityGates,
  routes,
  sha256,
  writeExclusive,
} from './protocol.mjs'

export const routeCategories = ['non-executable', ...routes]
export const outcomeCategories = [false, true]
const pairs = [[0, 1], [0, 2], [1, 2]]

function categoryIndex(categories) {
  if (!Array.isArray(categories) || categories.length < 2 || new Set(categories).size !== categories.length) {
    throw new Error('categories must contain at least two unique values')
  }
  return new Map(categories.map((category, index) => [category, index]))
}

function ratingStats(ratings, categories) {
  if (!Array.isArray(ratings) || ratings.length === 0) throw new Error('ratings must not be empty')
  const index = categoryIndex(categories)
  const raters = ratings[0]?.length
  if (!Number.isInteger(raters) || raters < 2) throw new Error('ratings require at least two raters')
  const totals = Array(categories.length).fill(0)
  let observedAgreement = 0
  let unanimous = 0
  for (const [rowIndex, row] of ratings.entries()) {
    if (!Array.isArray(row) || row.length !== raters) throw new Error(`ratings[${rowIndex}] has invalid rater count`)
    const counts = Array(categories.length).fill(0)
    for (const value of row) {
      const position = index.get(value)
      if (position === undefined) throw new Error(`ratings[${rowIndex}] contains an unknown category`)
      counts[position] += 1
      totals[position] += 1
    }
    if (Math.max(...counts) === raters) unanimous += 1
    observedAgreement += counts.reduce((sum, count) => sum + count * (count - 1), 0) / (raters * (raters - 1))
  }
  observedAgreement /= ratings.length
  return {
    observedAgreement,
    proportions: totals.map(total => total / (ratings.length * raters)),
    subjects: ratings.length,
    raters,
    unanimous: { count: unanimous, rate: unanimous / ratings.length },
  }
}

export function fleissKappaStats(ratings, categories) {
  const base = ratingStats(ratings, categories)
  const expectedAgreement = base.proportions.reduce((sum, value) => sum + value ** 2, 0)
  const denominator = 1 - expectedAgreement
  const kappa = Math.abs(denominator) < Number.EPSILON
    ? (base.observedAgreement === 1 ? 1 : 0)
    : (base.observedAgreement - expectedAgreement) / denominator
  return { kappa, expectedAgreement, ...base }
}

export function gwetAc1Stats(ratings, categories) {
  const base = ratingStats(ratings, categories)
  const chanceAgreement = base.proportions.reduce((sum, value) => sum + value * (1 - value), 0) / (categories.length - 1)
  const denominator = 1 - chanceAgreement
  const ac1 = Math.abs(denominator) < Number.EPSILON
    ? (base.observedAgreement === 1 ? 1 : 0)
    : (base.observedAgreement - chanceAgreement) / denominator
  return { ac1, chanceAgreement, ...base }
}

function pairwiseConfusions(ratings, categories) {
  return pairs.map(([left, right]) => {
    const matrix = Object.fromEntries(categories.map(a => [String(a), Object.fromEntries(categories.map(b => [String(b), 0]))]))
    let exact = 0
    for (const row of ratings) {
      matrix[String(row[left])][String(row[right])] += 1
      if (row[left] === row[right]) exact += 1
    }
    return { pair: `${left + 1}-${right + 1}`, exact: { count: exact, rate: exact / ratings.length }, matrix }
  })
}

function metric(ratings, categories) {
  const fleiss = fleissKappaStats(ratings, categories)
  return {
    categories,
    fleissKappa: fleiss,
    gwetAc1: gwetAc1Stats(ratings, categories),
    unanimous: fleiss.unanimous,
    pairwiseConfusions: pairwiseConfusions(ratings, categories),
  }
}

function routeValue(annotation) {
  return annotation.derived.eligible ? annotation.derived.route : 'non-executable'
}

function scopeAgreement(candidates, sets) {
  if (candidates.length === 0) throw new Error('agreement scope must not be empty')
  const ratingsFor = value => candidates.map(candidate => sets.map(set => value(set.get(candidate.id))))
  return {
    route: metric(ratingsFor(routeValue), routeCategories),
    outcomeCritical: metric(ratingsFor(annotation => annotation.derived.outcomeCritical), outcomeCategories),
    primitives: Object.fromEntries(Object.entries(factDomains).map(([field, categories]) => [
      field,
      metric(ratingsFor(annotation => annotation.facts[field]), categories),
    ])),
  }
}

function setJaccard(left, right) {
  const union = new Set([...left, ...right])
  if (union.size === 0) return 1
  let intersection = 0
  for (const value of left) if (right.has(value)) intersection += 1
  return intersection / union.size
}

function positiveAgreement(candidates, sets, predicate) {
  const positives = sets.map(set => new Set(candidates
    .filter(candidate => predicate(set.get(candidate.id)))
    .map(candidate => candidate.id)))
  const jaccards = pairs.map(([left, right]) => ({
    pair: `${left + 1}-${right + 1}`,
    value: setJaccard(positives[left], positives[right]),
  }))
  return {
    counts: positives.map(value => value.size),
    minimumCount: Math.min(...positives.map(value => value.size)),
    pairwiseJaccard: jaccards,
    minimumPairwiseJaccard: Math.min(...jaccards.map(value => value.value)),
  }
}

export function computeAgreement(candidates, sets) {
  if (!Array.isArray(sets) || sets.length !== 3 || sets.some(set => !(set instanceof Map))) {
    throw new Error('annotation sets must contain exactly three validated maps')
  }
  const byLanguage = Object.fromEntries(languages.map(language => {
    const scoped = candidates.filter(candidate => candidate.language === language)
    return [language, scopeAgreement(scoped, sets)]
  }))
  const rarePositive = Object.fromEntries(languages.map(language => {
    const scoped = candidates.filter(candidate => candidate.language === language)
    return [language, {
      ...Object.fromEntries(['contract', 'lattice', 'probe'].map(route => [
        route,
        positiveAgreement(scoped, sets, annotation => annotation.derived.eligible && annotation.derived.route === route),
      ])),
      outcomeCritical: positiveAgreement(scoped, sets, annotation => annotation.derived.outcomeCritical),
    }]
  }))
  return { overall: scopeAgreement(candidates, sets), byLanguage, rarePositive }
}

function metricGate(value, gates) {
  return {
    kappa: value.fleissKappa.kappa >= gates.kappaMin,
    ac1: value.gwetAc1.ac1 >= gates.ac1Min,
    unanimous: value.unanimous.rate >= gates.unanimousMin,
  }
}

function scopeGates(scope, gates) {
  return {
    route: metricGate(scope.route, gates),
    outcomeCritical: metricGate(scope.outcomeCritical, gates),
    primitives: Object.fromEntries(Object.entries(scope.primitives).map(([field, value]) => [field, metricGate(value, gates)])),
  }
}

function allFlags(value) {
  if (typeof value === 'boolean') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(allFlags)
}

export function evaluateReliabilityGates(agreement, gates = reliabilityGates) {
  const metricGates = {
    overall: scopeGates(agreement.overall, gates),
    byLanguage: Object.fromEntries(languages.map(language => [language, scopeGates(agreement.byLanguage[language], gates)])),
  }
  const positiveGates = Object.fromEntries(languages.map(language => [language, Object.fromEntries(
    Object.entries(agreement.rarePositive[language]).map(([name, value]) => [name, {
      support: value.minimumCount >= gates.rarePositivePerLanguageMin,
      jaccard: value.minimumPairwiseJaccard >= gates.rarePositiveJaccardMin,
    }]),
  )]))
  const combined = { metrics: metricGates, rarePositive: positiveGates }
  return { ...combined, allPassed: allFlags(combined).every(Boolean) }
}

export function buildAgreementReport(candidates, sets, digests) {
  const agreement = computeAgreement(candidates, sets)
  return {
    schemaVersion: 1,
    counts: {
      candidates: candidates.length,
      annotators: sets.length,
      languages: Object.fromEntries(languages.map(language => [language, candidates.filter(row => row.language === language).length])),
    },
    thresholds: reliabilityGates,
    agreement,
    gates: evaluateReliabilityGates(agreement),
    digests,
  }
}

export async function runAgreement(candidatePath, annotationPaths, outputPath) {
  if (!Array.isArray(annotationPaths) || annotationPaths.length !== 3) throw new Error('agreement requires three annotation files')
  await assertArtifactsAbsent([outputPath], 'V10 agreement')
  const [candidateText, ...annotationTexts] = await Promise.all([
    readFile(candidatePath, 'utf8'),
    ...annotationPaths.map(path => readFile(path, 'utf8')),
  ])
  const candidates = parseJsonLines(candidateText, candidatePath)
  const sets = annotationTexts.map((text, index) => validateAnnotationSet(
    candidates,
    parseJsonLines(text, annotationPaths[index]),
    `annotations ${index + 1}`,
  ))
  const report = buildAgreementReport(candidates, sets, {
    candidates: sha256(candidateText),
    annotations: annotationTexts.map((text, index) => ({ annotator: index + 1, sha256: sha256(text) })),
  })
  await writeExclusive(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

async function main() {
  if (process.argv.length !== 7) throw new Error('usage: agreement.mjs <candidates> <annotations-a> <annotations-b> <annotations-c> <output>')
  const paths = process.argv.slice(2).map(resolve)
  const output = paths.pop()
  const report = await runAgreement(paths.shift(), paths, output)
  console.log(JSON.stringify(report, null, 2))
  if (!report.gates.allPassed) process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
