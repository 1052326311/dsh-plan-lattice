#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const routes = ['bypass', 'contract', 'lattice']
const axes = ['basisCompleteness', 'expiryExposure', 'staleImpact']
const files = {
  prompts: 'blind-v5.prompts.jsonl',
  labels: 'blind-v5.labels.jsonl',
  sources: 'blind-v5.sources.jsonl',
  results: 'blind-v5-results.json',
  manifest: 'blind-v5.manifest.json',
  candidates: 'candidates.jsonl',
  annotationsA: 'annotations-a.jsonl',
  annotationsB: 'annotations-b.jsonl',
  annotationsC: 'annotations-c.jsonl',
}

function read(name) {
  return readFileSync(join(here, name), 'utf8')
}

function jsonl(name) {
  const text = read(name).trim()
  return text === '' ? [] : text.split(/\r?\n/u).map(line => JSON.parse(line))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function index(rows, name) {
  const result = new Map()
  for (const row of rows) {
    assert(typeof row.id === 'string' && row.id !== '', `${name} row has no id`)
    assert(!result.has(row.id), `${name} duplicates ${row.id}`)
    result.set(row.id, row)
  }
  return result
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6))
}

function compact(text, limit = 280) {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return [...normalized].length <= limit
    ? normalized
    : `${[...normalized].slice(0, limit - 3).join('')}...`
}

function tuple(annotation) {
  const basis = annotation.authoritativeMutationBasis
  return `${basis.basisCompleteness}/${basis.expiryExposure}/${basis.staleImpact}`
}

function agreement(left, right, values) {
  const observed = left.filter((value, position) => value === right[position]).length / left.length
  const leftRates = Object.fromEntries(values.map(value => [value, left.filter(item => item === value).length / left.length]))
  const rightRates = Object.fromEntries(values.map(value => [value, right.filter(item => item === value).length / right.length]))
  const expected = values.reduce((sum, value) => sum + leftRates[value] * rightRates[value], 0)
  return {
    count: left.length,
    exact: left.filter((value, position) => value === right[position]).length,
    observed: Number(observed.toFixed(6)),
    kappa: expected === 1 ? 1 : Number(((observed - expected) / (1 - expected)).toFixed(6)),
  }
}

const raw = Object.fromEntries(Object.entries(files).map(([key, name]) => [key, read(name)]))
const prompts = index(jsonl(files.prompts), 'prompts')
const labels = index(jsonl(files.labels), 'labels')
const sources = index(jsonl(files.sources), 'sources')
const candidates = jsonl(files.candidates)
const annotationRowsA = jsonl(files.annotationsA)
const annotationRowsB = jsonl(files.annotationsB)
const annotationRowsC = jsonl(files.annotationsC)
const annotationsA = index(annotationRowsA, 'annotations A')
const annotationsB = index(annotationRowsB, 'annotations B')
const annotationsC = index(annotationRowsC, 'annotations C')
const manifest = JSON.parse(raw.manifest)
const results = JSON.parse(raw.results)

assert(sha256(raw.prompts) === manifest.digests.prompts, 'prompt digest differs from frozen manifest')
assert(sha256(raw.labels) === manifest.digests.labels, 'label digest differs from frozen manifest')
assert(sha256(raw.sources) === manifest.digests.sources, 'source digest differs from frozen manifest')
assert(sha256(raw.manifest) === results.manifestDigest, 'result is not bound to the frozen manifest')
assert(results.evidenceStatus === 'immutable-first-reveal', 'V5 result is not the immutable first reveal')
assert(results.releaseGatePassed === false, 'V5 analysis expects a failed release gate')
assert(prompts.size === 120 && labels.size === 120 && sources.size === 120, 'V5 blind join is incomplete')
assert(annotationRowsA.length === candidates.length && annotationRowsB.length === candidates.length, 'primary annotation join is incomplete')

const primaryIds = candidates.map(row => row.id)
const primaryAgreement = {
  route: agreement(
    primaryIds.map(id => annotationsA.get(id).route),
    primaryIds.map(id => annotationsB.get(id).route),
    routes,
  ),
  outcomeCritical: agreement(
    primaryIds.map(id => String(annotationsA.get(id).outcomeCritical)),
    primaryIds.map(id => String(annotationsB.get(id).outcomeCritical)),
    ['true', 'false'],
  ),
  axes: Object.fromEntries(axes.map(axis => [axis, agreement(
    primaryIds.map(id => annotationsA.get(id).authoritativeMutationBasis[axis]),
    primaryIds.map(id => annotationsB.get(id).authoritativeMutationBasis[axis]),
    axis === 'basisCompleteness' ? ['complete', 'partial', 'incomplete'] : ['low', 'medium', 'high'],
  )])),
}
primaryAgreement.allAxesExact = {
  count: primaryIds.length,
  exact: primaryIds.filter(id => axes.every(axis => (
    annotationsA.get(id).authoritativeMutationBasis[axis]
      === annotationsB.get(id).authoritativeMutationBasis[axis]
  ))).length,
}
primaryAgreement.allAxesExact.rate = ratio(primaryAgreement.allAxesExact.exact, primaryAgreement.allAxesExact.count)

const failureById = new Map(results.failures.map(row => [row.id, row]))
const blindRows = [...prompts.keys()].sort().map(id => {
  const prompt = prompts.get(id)
  const label = labels.get(id)
  const source = sources.get(id)
  const a = annotationsA.get(id)
  const b = annotationsB.get(id)
  const c = annotationsC.get(id)
  const failure = failureById.get(id)
  const axisDisagreements = axes.filter(axis => (
    a.authoritativeMutationBasis[axis] !== b.authoritativeMutationBasis[axis]
  ))
  const placeholderOnly = /a clear and concise description of what|loading react element tree.*loading react element tree/is.test(prompt.text)
  return {
    id,
    language: prompt.language,
    expected: label.expected,
    actual: failure?.actual ?? label.expected,
    outcomeCritical: label.outcomeCritical,
    correct: failure === undefined,
    source: {
      repository: source.repository,
      issueNumber: source.issueNumber,
      url: source.url,
    },
    annotationHealth: {
      primaryRouteAgreement: a.route === b.route,
      primaryOutcomeAgreement: a.outcomeCritical === b.outcomeCritical,
      primaryAxisDisagreements: axisDisagreements,
      distinctSupportingAxisTuples: new Set(label.authoritativeMutationBasis.map(value => (
        `${value.basisCompleteness}/${value.expiryExposure}/${value.staleImpact}`
      ))).size,
      placeholderOnly,
    },
    votes: [a, b, ...(c === undefined ? [] : [c])].map((annotation, position) => ({
      annotator: position === 0 ? 'A' : position === 1 ? 'B' : 'C',
      route: annotation.route,
      outcomeCritical: annotation.outcomeCritical,
      basis: tuple(annotation),
      confidence: annotation.confidence,
      rationale: annotation.rationale,
    })),
    routerReasons: failure?.reasons ?? [],
    summary: compact(prompt.text),
  }
})

const finalByRoute = Object.fromEntries(routes.map(route => {
  const rows = blindRows.filter(row => row.expected === route)
  const allAxesExact = rows.filter(row => row.annotationHealth.primaryAxisDisagreements.length === 0).length
  const routeExact = rows.filter(row => row.annotationHealth.primaryRouteAgreement).length
  return [route, {
    count: rows.length,
    failures: rows.filter(row => !row.correct).length,
    primaryRouteAgreement: routeExact,
    primaryRouteAgreementRate: ratio(routeExact, rows.length),
    primaryAllAxesAgreement: allAxesExact,
    primaryAllAxesAgreementRate: ratio(allAxesExact, rows.length),
    multipleSupportingAxisTuples: rows.filter(row => row.annotationHealth.distinctSupportingAxisTuples > 1).length,
  }]
}))

const confusionFailures = Object.fromEntries(routes.flatMap(expected => routes.map(actual => {
  const count = blindRows.filter(row => !row.correct && row.expected === expected && row.actual === actual).length
  return [`${expected}->${actual}`, count]
})).filter(([, count]) => count > 0))

const report = {
  schemaVersion: 1,
  evidenceStatus: 'post-reveal-diagnostic-only',
  immutableInputs: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, sha256(value)])),
  firstReveal: {
    codeFreezeCommit: results.codeFreezeCommit,
    runtimeDigest: results.runtimeDigest,
    releaseGatePassed: results.releaseGatePassed,
    metrics: results.metrics,
    confusion: results.confusion,
  },
  annotationReliability: {
    candidateCount: candidates.length,
    thirdAnnotatorCount: annotationRowsC.length,
    primaryAgreement,
    frozenBlindByRoute: finalByRoute,
    placeholderOnlyBlindRows: blindRows.filter(row => row.annotationHealth.placeholderOnly).map(row => row.id),
  },
  failures: {
    count: results.failures.length,
    confusion: confusionFailures,
    rows: blindRows.filter(row => !row.correct),
  },
  protocolFindings: [
    'The V5 route was voted independently from the causal axes; the freeze retained multiple supporter axis tuples instead of adjudicating one authoritative basis assessment.',
    'A direct route majority can therefore hide disagreement about why control is required, so a router miss and a label-construction miss are not identifiable from route accuracy alone.',
    'Issue severity is not stale-mutation impact: V6 must measure damage caused by acting on an obsolete basis, not damage already described by the issue.',
    'Unknown repository ownership or execution span requires a probe lifecycle; forcing a final route from issue prose makes the evaluator reward guesses.',
    'V6 must annotate executable evidence sufficiency and primitive basis facts, then derive outcome-critical status and the final route with a frozen function.',
  ],
}

const markdown = `# V5 Router Failure Analysis

This report is deterministic post-reveal diagnosis. It does not modify or rehabilitate the failed V5 evidence.

## First Reveal

- Accuracy: ${report.firstReveal.metrics.exactAccuracy}
- Simple false activation: ${report.firstReveal.metrics.simpleFalseActivationRate}
- Complex critical recall: ${report.firstReveal.metrics.complexCriticalRecall}
- Outcome-critical bypasses: ${report.firstReveal.metrics.outcomeCriticalBypass}
- Lattice recall: ${report.firstReveal.metrics.latticeRecall}
- Release gate passed: ${report.firstReveal.releaseGatePassed}

## Annotation Reliability

- Primary route agreement: ${primaryAgreement.route.exact}/${primaryAgreement.route.count} (${primaryAgreement.route.observed}); kappa ${primaryAgreement.route.kappa}.
- Primary outcome-critical agreement: ${primaryAgreement.outcomeCritical.exact}/${primaryAgreement.outcomeCritical.count} (${primaryAgreement.outcomeCritical.observed}); kappa ${primaryAgreement.outcomeCritical.kappa}.
- All three causal axes agreed exactly: ${primaryAgreement.allAxesExact.exact}/${primaryAgreement.allAxesExact.count} (${primaryAgreement.allAxesExact.rate}).
- Frozen contract rows with complete A/B axis agreement: ${finalByRoute.contract.primaryAllAxesAgreement}/${finalByRoute.contract.count}.
- Placeholder-only blind rows: ${report.annotationReliability.placeholderOnlyBlindRows.join(', ') || 'none'}.

| Frozen route | Rows | Failures | A/B route agreement | A/B all-axis agreement | Multiple supporter tuples |
| --- | ---: | ---: | ---: | ---: | ---: |
${routes.map(route => {
  const value = finalByRoute[route]
  return `| ${route} | ${value.count} | ${value.failures} | ${value.primaryRouteAgreement} | ${value.primaryAllAxesAgreement} | ${value.multipleSupportingAxisTuples} |`
}).join('\n')}

## Causal Conclusion

${report.protocolFindings.map(value => `- ${value}`).join('\n')}

## Failed Cells

| Expected -> actual | Count |
| --- | ---: |
${Object.entries(confusionFailures).map(([cell, count]) => `| ${cell} | ${count} |`).join('\n')}

The machine-readable report contains every failed row, source URL, A/B/C vote, causal tuple, rationale, and router reason.
`

writeFileSync(join(here, 'failure-analysis.json'), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(here, 'failure-analysis.md'), markdown)
console.log(JSON.stringify({
  failures: report.failures.count,
  primaryRouteAgreement: primaryAgreement.route,
  primaryAllAxesAgreement: primaryAgreement.allAxesExact,
  frozenBlindByRoute: finalByRoute,
}, null, 2))
