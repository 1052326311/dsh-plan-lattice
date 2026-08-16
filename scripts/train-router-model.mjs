#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const classes = ['bypass', 'contract', 'lattice']
const dimensions = 8192
const epochs = 70
const folds = 5

const lines = async path => {
  const text = await readFile(join(root, path), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const { extractRouterFeatures } = await import(pathToFileURL(join(root, 'lib', 'router-features.js')))

function sourceMap(rows) {
  return new Map(rows.map(row => [row.id, row]))
}

function sourceGroup(row, source, prefix) {
  if (source?.repository) return `${prefix}:repository:${source.repository}`
  if (source?.queryGroup) return `${prefix}:query:${source.queryGroup}`
  return `${prefix}:id:${row.id}`
}

function consensusRows(candidates, left, right, sources, prefix) {
  const output = []
  for (let index = 0; index < candidates.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.id !== candidates[index].id || b.id !== candidates[index].id) throw new Error('annotation order mismatch')
    if (a.route !== b.route || a.outcomeCritical !== b.outcomeCritical) continue
    if (!classes.includes(a.route) || a.confidence === 'low' || b.confidence === 'low') continue
    if (a.route === 'bypass' && a.outcomeCritical) continue
    const row = candidates[index]
    output.push({
      id: `${prefix}:${row.id}`,
      originalId: row.id,
      text: row.text,
      label: a.route,
      group: sourceGroup(row, sources.get(row.id), prefix),
      origin: `${prefix}-consensus`,
    })
  }
  return output
}

const v2Candidates = await lines('eval/router-corpus/v2/candidates.jsonl')
const v2A = await lines('eval/router-corpus/v2/annotations-a.jsonl')
const v2B = await lines('eval/router-corpus/v2/annotations-b.jsonl')
const v2Sources = sourceMap(await lines('eval/router-corpus/v2/sources.jsonl'))
const v2Prompts = await lines('eval/router-corpus/v2/blind-v2.prompts.jsonl')
const v2Labels = new Map((await lines('eval/router-corpus/v2/blind-v2.labels.jsonl')).map(row => [row.id, row]))
const baseCandidates = await lines('eval/router-corpus/v3/candidates.jsonl')
const baseA = await lines('eval/router-corpus/v3/annotations-a.jsonl')
const baseB = await lines('eval/router-corpus/v3/annotations-b.jsonl')
const baseSources = sourceMap(await lines('eval/router-corpus/v3/sources.jsonl'))
const supplementCandidates = await lines('eval/router-corpus/v3/supplement-candidates.jsonl')
const supplementA = await lines('eval/router-corpus/v3/supplement-annotations-a.jsonl')
const supplementB = await lines('eval/router-corpus/v3/supplement-annotations-b.jsonl')
const supplementSources = sourceMap(await lines('eval/router-corpus/v3/supplement-source-records.jsonl'))
const blindPrompts = await lines('eval/router-corpus/v3/blind-v3.prompts.jsonl')
const blindLabels = new Map((await lines('eval/router-corpus/v3/blind-v3.labels.jsonl')).map(row => [row.id, row]))
const v1Prompts = await lines('eval/router-corpus/blind-real.prompts.jsonl')
const v1Labels = new Map((await lines('eval/router-corpus/blind-real.labels.jsonl')).map(row => [row.id, row]))
const v1Sources = sourceMap(await lines('eval/router-corpus/blind-real.sources.jsonl'))
const authored = await lines('eval/router-corpus/development.jsonl')

const byId = new Map()
for (const row of [
  ...consensusRows(v2Candidates, v2A, v2B, v2Sources, 'v2'),
  ...consensusRows(baseCandidates, baseA, baseB, baseSources, 'v3-base'),
  ...consensusRows(supplementCandidates, supplementA, supplementB, supplementSources, 'v3-supplement'),
]) byId.set(row.id, row)
for (const prompt of v1Prompts) {
  const label = v1Labels.get(prompt.id)
  if (label === undefined) throw new Error(`missing V1 label ${prompt.id}`)
  byId.set(`v1:${prompt.id}`, {
    id: `v1:${prompt.id}`,
    originalId: prompt.id,
    text: prompt.text,
    label: label.expected,
    group: sourceGroup(prompt, v1Sources.get(prompt.id), 'v1'),
    origin: 'v1-revealed-final',
  })
}
for (const prompt of v2Prompts) {
  const label = v2Labels.get(prompt.id)
  if (label === undefined) throw new Error(`missing V2 label ${prompt.id}`)
  if (label.expected === 'bypass' && label.outcomeCritical === true) continue
  const id = `v2:${prompt.id}`
  const existing = byId.get(id)
  byId.set(id, {
    id,
    originalId: prompt.id,
    text: prompt.text,
    label: label.expected,
    group: existing?.group ?? sourceGroup(prompt, v2Sources.get(prompt.id), 'v2'),
    origin: 'v2-revealed-final',
  })
}
for (const prompt of blindPrompts) {
  const label = blindLabels.get(prompt.id)
  if (label === undefined) throw new Error(`missing blind label ${prompt.id}`)
  const baseId = `v3-base:${prompt.id}`
  const supplementId = `v3-supplement:${prompt.id}`
  const existing = byId.get(baseId) ?? byId.get(supplementId)
  const prefix = prompt.id.startsWith('program-') ? 'v3-supplement' : 'v3-base'
  const sources = prompt.id.startsWith('program-') ? supplementSources : baseSources
  byId.set(existing?.id ?? `${prefix}:${prompt.id}`, {
    id: existing?.id ?? `${prefix}:${prompt.id}`,
    originalId: prompt.id,
    text: prompt.text,
    label: label.expected,
    group: existing?.group ?? sourceGroup(prompt, sources.get(prompt.id), prefix),
    origin: 'v3-revealed-final',
  })
}
for (const row of authored) byId.set(`authored:${row.id}`, {
  id: `authored:${row.id}`,
  originalId: row.id,
  text: row.text,
  label: row.expected,
  group: `authored:template:${sha256(row.text.normalize('NFKC').toLowerCase().replace(/\d+/g, '#')).slice(0, 16)}`,
  origin: 'authored-development',
})
const conflicts = new Set()
const textLabels = new Map()
for (const row of byId.values()) {
  const digest = sha256(row.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
  const previous = textLabels.get(digest)
  if (previous !== undefined && previous !== row.label) conflicts.add(digest)
  else textLabels.set(digest, row.label)
}
const dataset = [...byId.values()].filter(row => {
  const digest = sha256(row.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim())
  return classes.includes(row.label) && !conflicts.has(digest)
}).map(row => ({
  ...row,
  classIndex: classes.indexOf(row.label),
  features: extractRouterFeatures(row.text, dimensions),
}))

function assignGroupFolds(rows) {
  const groups = new Map()
  for (const row of rows) {
    const group = groups.get(row.group) ?? { id: row.group, counts: classes.map(() => 0), size: 0 }
    group.counts[row.classIndex] += 1
    group.size += 1
    groups.set(row.group, group)
  }
  const targets = classes.map((_, classIndex) => (
    rows.filter(row => row.classIndex === classIndex).length / folds
  ))
  const sizeTarget = rows.length / folds
  const assignments = new Map()
  const foldCounts = Array.from({ length: folds }, () => classes.map(() => 0))
  const foldSizes = Array.from({ length: folds }, () => 0)
  const ordered = [...groups.values()].sort((left, right) => (
    Math.max(...right.counts) - Math.max(...left.counts)
      || right.size - left.size
      || sha256(left.id).localeCompare(sha256(right.id))
  ))
  for (const group of ordered) {
    let bestFold = 0
    let bestScore = Number.POSITIVE_INFINITY
    for (let fold = 0; fold < folds; fold += 1) {
      let classError = 0
      let sizeError = 0
      for (let candidateFold = 0; candidateFold < folds; candidateFold += 1) {
        for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
          const projected = foldCounts[candidateFold][classIndex]
            + (candidateFold === fold ? group.counts[classIndex] : 0)
          classError += ((projected - targets[classIndex]) / Math.max(1, targets[classIndex])) ** 2
        }
        const projectedSize = foldSizes[candidateFold] + (candidateFold === fold ? group.size : 0)
        sizeError += ((projectedSize - sizeTarget) / sizeTarget) ** 2
      }
      const score = classError * 2 + sizeError
      if (score < bestScore || score === bestScore && foldSizes[fold] < foldSizes[bestFold]) {
        bestScore = score
        bestFold = fold
      }
    }
    assignments.set(group.id, bestFold)
    foldSizes[bestFold] += group.size
    for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
      foldCounts[bestFold][classIndex] += group.counts[classIndex]
    }
  }
  return { assignments, foldCounts, foldSizes, groups: groups.size }
}

function train(rows) {
  const weights = classes.map(() => new Float64Array(dimensions))
  const biases = new Float64Array(classes.length)
  const buckets = classes.map((_, classIndex) => rows.filter(row => row.classIndex === classIndex))
  const maximum = Math.max(...buckets.map(bucket => bucket.length))
  let step = 0
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let offset = 0; offset < maximum; offset += 1) {
      for (let classIndex = 0; classIndex < classes.length; classIndex += 1) {
        const bucket = buckets[classIndex]
        if (bucket.length === 0) continue
        const row = bucket[(offset * 31 + epoch * 17) % bucket.length]
        const scores = classes.map((_, candidateClass) => {
          let score = biases[candidateClass]
          for (let index = 0; index < row.features.indices.length; index += 1) {
            score += weights[candidateClass][row.features.indices[index]] * row.features.values[index]
          }
          return score
        })
        const maximumScore = Math.max(...scores)
        const exponentials = scores.map(score => Math.exp(score - maximumScore))
        const total = exponentials.reduce((sum, value) => sum + value, 0)
        const rate = 0.16 / Math.sqrt(1 + step / 800)
        for (let candidateClass = 0; candidateClass < classes.length; candidateClass += 1) {
          const error = exponentials[candidateClass] / total - (candidateClass === row.classIndex ? 1 : 0)
          biases[candidateClass] -= rate * error
          for (let index = 0; index < row.features.indices.length; index += 1) {
            const featureIndex = row.features.indices[index]
            const previous = weights[candidateClass][featureIndex]
            weights[candidateClass][featureIndex] -= rate * (
              error * row.features.values[index] + 0.00002 * previous
            )
          }
        }
        step += 1
      }
    }
  }
  return { weights, biases }
}

function predict(model, row) {
  const scores = classes.map((_, classIndex) => {
    let score = model.biases[classIndex]
    for (let index = 0; index < row.features.indices.length; index += 1) {
      score += model.weights[classIndex][row.features.indices[index]] * row.features.values[index]
    }
    return score
  })
  const maximum = Math.max(...scores)
  const exponentials = scores.map(score => Math.exp(score - maximum))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  const probabilities = exponentials.map(value => value / total)
  const classIndex = probabilities.indexOf(Math.max(...probabilities))
  return { classIndex, confidence: probabilities[classIndex] }
}

function metrics(rows, predictions) {
  const confusion = classes.map(() => classes.map(() => 0))
  for (let index = 0; index < rows.length; index += 1) {
    confusion[rows[index].classIndex][predictions[index].classIndex] += 1
  }
  const perClass = Object.fromEntries(classes.map((label, classIndex) => {
    const truePositive = confusion[classIndex][classIndex]
    const actual = confusion[classIndex].reduce((sum, value) => sum + value, 0)
    const predicted = confusion.reduce((sum, row) => sum + row[classIndex], 0)
    const precision = predicted === 0 ? 0 : truePositive / predicted
    const recall = actual === 0 ? 0 : truePositive / actual
    return [label, {
      samples: actual,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    }]
  }))
  return {
    accuracy: rows.length === 0 ? 0 : predictions.filter((prediction, index) => (
      prediction.classIndex === rows[index].classIndex
    )).length / rows.length,
    macroF1: classes.reduce((sum, label) => sum + perClass[label].f1, 0) / classes.length,
    meanConfidence: predictions.length === 0 ? 0 : predictions.reduce((sum, row) => sum + row.confidence, 0) / predictions.length,
    perClass,
    confusion,
  }
}

const split = assignGroupFolds(dataset)
const foldResults = []
const outOfFold = []
for (let fold = 0; fold < folds; fold += 1) {
  const training = dataset.filter(row => split.assignments.get(row.group) !== fold)
  const heldOut = dataset.filter(row => split.assignments.get(row.group) === fold)
  const model = train(training)
  const predictions = heldOut.map(row => predict(model, row))
  for (let index = 0; index < heldOut.length; index += 1) outOfFold.push({ row: heldOut[index], prediction: predictions[index] })
  foldResults.push({ fold, ...metrics(heldOut, predictions) })
}
const model = train(dataset)
const quantizedWeights = model.weights.map(row => [...row].map(value => Math.round(value * 1e6) / 1e6))
const quantizedBiases = [...model.biases].map(value => Math.round(value * 1e6) / 1e6)
const source = `// Generated by scripts/train-router-model.mjs.\nexport const ROUTER_MODEL = ${JSON.stringify({
  schemaVersion: 1,
  classes,
  dimensions,
  weights: quantizedWeights,
  biases: quantizedBiases,
})} as const\n`
await writeFile(join(root, 'src', 'router-model.ts'), source, 'utf8')
const counts = Object.fromEntries(classes.map(label => [label, dataset.filter(row => row.label === label).length]))
const report = {
  schemaVersion: 1,
  samples: dataset.length,
  counts,
  origins: Object.fromEntries([...new Set(dataset.map(row => row.origin))].sort().map(origin => [
    origin, dataset.filter(row => row.origin === origin).length,
  ])),
  conflictingTextsExcluded: conflicts.size,
  sourceGroups: split.groups,
  foldSizes: split.foldSizes,
  foldClassCounts: split.foldCounts,
  dimensions,
  epochs,
  folds: foldResults,
  outOfFold: metrics(outOfFold.map(row => row.row), outOfFold.map(row => row.prediction)),
  trainingDataDigest: sha256(JSON.stringify(dataset.map(({ id, text, label, group, origin }) => ({ id, text, label, group, origin })))),
}
await writeFile(join(root, 'eval', 'router-corpus', 'v3', 'router-model-training-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
