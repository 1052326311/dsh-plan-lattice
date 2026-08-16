#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const routes = new Set(['bypass', 'contract', 'lattice', 'exclude'])

async function jsonLines(name) {
  const text = await readFile(join(here, name), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line))
}

function validateAnnotations(rows, candidates, name) {
  if (rows.length !== candidates.length) {
    throw new Error(`${name} has ${rows.length} rows; expected ${candidates.length}`)
  }
  const seen = new Set()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.id !== candidates[index].id) throw new Error(`${name} id/order mismatch at ${index}`)
    if (seen.has(row.id)) throw new Error(`${name} duplicates ${row.id}`)
    seen.add(row.id)
    if (!routes.has(row.route)) throw new Error(`${name} has invalid route for ${row.id}`)
    if (typeof row.outcomeCritical !== 'boolean') throw new Error(`${name} has invalid outcomeCritical for ${row.id}`)
    if (row.route === 'bypass' && row.outcomeCritical) {
      throw new Error(`${name} has contradictory bypass + outcomeCritical for ${row.id}`)
    }
    if (!['high', 'medium', 'low'].includes(row.confidence)) throw new Error(`${name} has invalid confidence for ${row.id}`)
    if (typeof row.rationale !== 'string' || row.rationale.trim() === '') throw new Error(`${name} lacks rationale for ${row.id}`)
    if (row.route === 'exclude' && typeof row.exclusionReason !== 'string') {
      throw new Error(`${name} lacks exclusionReason for ${row.id}`)
    }
    if (row.route !== 'exclude' && row.exclusionReason !== null) {
      throw new Error(`${name} has exclusionReason on retained row ${row.id}`)
    }
  }
}

const candidates = await jsonLines('candidates.jsonl')
const annotationsA = await jsonLines('annotations-a.jsonl')
const annotationsB = await jsonLines('annotations-b.jsonl')
validateAnnotations(annotationsA, candidates, 'annotations-a.jsonl')
validateAnnotations(annotationsB, candidates, 'annotations-b.jsonl')

const disagreements = []
for (let index = 0; index < candidates.length; index += 1) {
  const left = annotationsA[index]
  const right = annotationsB[index]
  if (left.route !== right.route || left.outcomeCritical !== right.outcomeCritical) {
    disagreements.push(candidates[index])
  }
}

const text = disagreements.length === 0
  ? ''
  : `${disagreements.map(row => JSON.stringify(row)).join('\n')}\n`
await writeFile(join(here, 'adjudication-packet.jsonl'), text, 'utf8')
console.log(`annotation disagreements: ${disagreements.length}/${candidates.length}`)
