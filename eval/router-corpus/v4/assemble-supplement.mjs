#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const load = async name => {
  const text = await readFile(join(here, name), 'utf8')
  return { text, rows: text.trim().split('\n').map(line => JSON.parse(line)) }
}
const manifest = JSON.parse(await readFile(join(here, 'supplement-manifest.json'), 'utf8'))
const input = await load('supplement-translation-input.jsonl')
const translated = await load('supplement-translations-zh.jsonl')
const english = await load('supplement-english.jsonl')
if (sha256(input.text) !== manifest.digests.translationInput) throw new Error('translation input changed after freeze')
if (translated.rows.length !== input.rows.length) throw new Error('translation row count mismatch')
for (let index = 0; index < input.rows.length; index += 1) {
  const source = input.rows[index]
  const target = translated.rows[index]
  if (target.id !== source.id || typeof target.text !== 'string' || target.text.trim() === '') throw new Error(`invalid translation at ${source.id}`)
  if (target.text === source.text) throw new Error(`untranslated row ${source.id}`)
}
const candidates = [
  ...english.rows,
  ...translated.rows.map(row => ({ id: row.id, language: 'zh', text: row.text })),
].sort((left, right) => left.id.localeCompare(right.id))
const text = `${candidates.map(row => JSON.stringify(row)).join('\n')}\n`
await Promise.all([
  writeFile(join(here, 'supplement-candidates.jsonl'), text, 'utf8'),
  writeFile(join(here, 'supplement-candidates.sha256'), `${sha256(text)}\n`, 'utf8'),
])
console.log('assembled 120 source-bound bilingual program candidates')
