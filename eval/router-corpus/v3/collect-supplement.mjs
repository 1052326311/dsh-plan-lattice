#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const configText = await readFile(join(here, 'supplement-sources.json'), 'utf8')
const config = JSON.parse(configText)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function cleanBody(value, limit) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' [code omitted] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/^\s*[-*]\s*\[[ xX]\]\s*/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .trim()
}

function search(query) {
  const output = execFileSync('gh', [
    'api', '-X', 'GET', 'search/issues',
    '-f', `q=${query}`,
    '-f', 'sort=created',
    '-f', 'order=asc',
    '-f', 'per_page=100',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(output).items
}

const raw = []
const sources = []
const seen = new Set()
for (const group of config.groups) {
  const matches = search(group.query)
    .filter(item => !seen.has(item.html_url))
    .map(item => ({ item, order: sha256(`${config.seed}:${group.id}:${item.html_url}`) }))
    .sort((left, right) => left.order.localeCompare(right.order))
  if (matches.length < group.count) throw new Error(`${group.id} produced ${matches.length}; expected ${group.count}`)
  for (const { item } of matches.slice(0, group.count)) {
    seen.add(item.html_url)
    const id = `program-${String(raw.length + 1).padStart(3, '0')}`
    const body = cleanBody(item.body, config.excerptCharacters)
    const text = `${item.title.trim()}${body === '' ? '' : `\n\n${body}`}`
    raw.push({ id, text })
    sources.push({
      id,
      repository: item.repository_url.split('/').slice(-2).join('/'),
      issueNumber: item.number,
      url: item.html_url,
      queryGroup: group.id,
      sourceContentDigest: sha256(`${item.title.trim()}\n${String(item.body ?? '').trim()}`),
      promptDigest: sha256(text),
    })
  }
}
if (raw.length !== config.expectedCandidates) throw new Error(`expected ${config.expectedCandidates}, got ${raw.length}`)
const partitioned = raw
  .map(row => ({ row, order: sha256(`${config.seed}:language:${row.id}`) }))
  .sort((left, right) => left.order.localeCompare(right.order))
const chineseIds = new Set(partitioned.slice(0, 60).map(entry => entry.row.id))
const translationInput = raw.filter(row => chineseIds.has(row.id))
const englishCandidates = raw.filter(row => !chineseIds.has(row.id)).map(row => ({ ...row, language: 'en' }))
const lines = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
const rawText = lines(raw)
const sourceText = lines(sources)
const translationText = lines(translationInput)
const englishText = lines(englishCandidates)
const routerSource = await readFile(join(repositoryRoot, 'src', 'router.ts'))
const manifest = {
  schemaVersion: 1,
  seed: config.seed,
  routerSourceDigest: sha256(routerSource),
  counts: { total: 120, english: 60, chineseTranslation: 60 },
  digests: {
    raw: sha256(rawText),
    sources: sha256(sourceText),
    translationInput: sha256(translationText),
    englishCandidates: sha256(englishText),
    sourceConfig: sha256(configText),
  },
}
await Promise.all([
  writeFile(join(here, 'supplement-raw.jsonl'), rawText, 'utf8'),
  writeFile(join(here, 'supplement-source-records.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'supplement-translation-input.jsonl'), translationText, 'utf8'),
  writeFile(join(here, 'supplement-english.jsonl'), englishText, 'utf8'),
  writeFile(join(here, 'supplement-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log('froze 120 program candidates: 60 English, 60 awaiting source-bound Chinese translation')
