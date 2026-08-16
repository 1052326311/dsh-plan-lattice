#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const supplement = process.argv.includes('--supplement')
const candidateFile = supplement ? 'supplement-candidates.jsonl' : 'candidates.jsonl'
const prefix = supplement ? 'supplement-' : ''

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function load(name) {
  const text = await readFile(join(here, name), 'utf8')
  const rows = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { text, rows }
}

function indexed(rows, name) {
  const result = new Map()
  for (const row of rows) {
    if (result.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    result.set(row.id, row)
  }
  return result
}

function validateAnnotation(row, id, name) {
  if (row === undefined) throw new Error(`${name} is missing ${id}`)
  if (!['bypass', 'contract', 'lattice'].includes(row.route)) throw new Error(`${name} has invalid route for ${id}`)
  if (typeof row.outcomeCritical !== 'boolean') throw new Error(`${name} has invalid outcomeCritical for ${id}`)
  if (!['high', 'medium', 'low'].includes(row.confidence)) throw new Error(`${name} has invalid confidence for ${id}`)
  if (!Array.isArray(row.invariants) || row.invariants.length === 0) throw new Error(`${name} has no invariants for ${id}`)
  if (typeof row.rationale !== 'string' || row.rationale.trim() === '') throw new Error(`${name} has no rationale for ${id}`)
  if (row.route === 'bypass' && row.outcomeCritical) throw new Error(`${name} labels outcome-critical ${id} as bypass`)
}

const candidates = await load(candidateFile)
const annotationsA = await load(`${prefix}annotations-a.jsonl`)
const annotationsB = await load(`${prefix}annotations-b.jsonl`)
const a = indexed(annotationsA.rows, 'annotations A')
const b = indexed(annotationsB.rows, 'annotations B')
if (a.size !== candidates.rows.length || b.size !== candidates.rows.length) {
  throw new Error(`both annotators must label all ${candidates.rows.length} candidates`)
}

const disagreements = []
let exactAgreement = 0
for (const candidate of candidates.rows) {
  const left = a.get(candidate.id)
  const right = b.get(candidate.id)
  validateAnnotation(left, candidate.id, 'annotations A')
  validateAnnotation(right, candidate.id, 'annotations B')
  if (left.route === right.route && left.outcomeCritical === right.outcomeCritical) {
    exactAgreement += 1
  } else {
    disagreements.push(candidate)
  }
}
const packet = `${disagreements.map(row => JSON.stringify(row)).join('\n')}${disagreements.length === 0 ? '' : '\n'}`
const report = {
  schemaVersion: 1,
  candidates: candidates.rows.length,
  exactAgreement,
  exactAgreementRate: exactAgreement / candidates.rows.length,
  disagreements: disagreements.length,
  digests: {
    candidates: sha256(candidates.text),
    annotationsA: sha256(annotationsA.text),
    annotationsB: sha256(annotationsB.text),
    adjudicationPacket: sha256(packet),
  },
}
await Promise.all([
  writeFile(join(here, `${prefix}adjudication-packet.jsonl`), packet, 'utf8'),
  writeFile(join(here, `${prefix}agreement-report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
])
console.log(JSON.stringify(report, null, 2))
