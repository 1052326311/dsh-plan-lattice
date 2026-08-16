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
const sha256 = value => createHash('sha256').update(value).digest('hex')

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
  return JSON.parse(execFileSync('gh', [
    'api', '-X', 'GET', 'search/issues', '-f', `q=${query}`,
    '-f', 'sort=created', '-f', 'order=asc', '-f', 'per_page=100',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).items
}

function rows(text) {
  return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
}

const priorSourceFiles = [
  'eval/router-corpus/blind-real.sources.jsonl',
  'eval/router-corpus/v2/sources.jsonl',
  'eval/router-corpus/v3/sources.jsonl',
  'eval/router-corpus/v3/supplement-source-records.jsonl',
  'eval/router-corpus/v4/sources.jsonl',
]
const priorRepositories = new Set()
const priorUrls = new Set()
for (const path of priorSourceFiles) {
  for (const row of rows(await readFile(join(repositoryRoot, path), 'utf8'))) {
    priorRepositories.add(String(row.repository).toLowerCase())
    priorUrls.add(String(row.url))
  }
}
for (const group of config.groups) {
  const repository = group.query.match(/repo:([^\s]+)/)?.[1]
  if (repository === undefined || priorRepositories.has(repository.toLowerCase())) {
    throw new Error(`supplement source is missing or overlaps a prior repository: ${group.id}`)
  }
}
const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
if (currentCommit !== config.codeFreezeCommit) throw new Error(`code freeze moved to ${currentCommit}`)

const raw = []
const sources = []
const seen = new Set(priorUrls)
for (const group of config.groups) {
  const matches = search(group.query)
    .filter(item => !seen.has(item.html_url))
    .map(item => ({ item, order: sha256(`${config.seed}:${group.id}:${item.html_url}`) }))
    .sort((left, right) => left.order.localeCompare(right.order))
  if (matches.length < group.count) throw new Error(`${group.id} produced ${matches.length}; expected ${group.count}`)
  for (const { item } of matches.slice(0, group.count)) {
    seen.add(item.html_url)
    const id = `v4-program-${String(raw.length + 1).padStart(3, '0')}`
    const body = cleanBody(item.body, config.excerptCharacters)
    const text = `${item.title.trim()}${body === '' ? '' : `\n\n${body}`}`
    raw.push({ id, text })
    sources.push({
      id,
      repository: item.repository_url.split('/').slice(-2).join('/'),
      issueNumber: item.number,
      url: item.html_url,
      queryGroup: group.id,
      createdAt: item.created_at,
      closedAt: item.closed_at,
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
const lines = values => `${values.map(value => JSON.stringify(value)).join('\n')}\n`
const rawText = lines(raw)
const sourceText = lines(sources)
const translationText = lines(translationInput)
const englishText = lines(englishCandidates)
const runtimeFiles = ['src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-model.ts']
const runtimeDigest = sha256((await Promise.all(runtimeFiles.map(path => readFile(join(repositoryRoot, path))))).map(value => sha256(value)).join('\n'))
const manifest = {
  schemaVersion: 1,
  seed: config.seed,
  codeFreezeCommit: config.codeFreezeCommit,
  runtimeDigest,
  counts: { total: 120, english: 60, chineseTranslation: 60 },
  sourceIsolation: { priorRepositoryCount: priorRepositories.size, priorUrlCount: priorUrls.size, overlappingRepositories: [], overlappingUrls: [] },
  digests: {
    raw: sha256(rawText), sources: sha256(sourceText), translationInput: sha256(translationText),
    englishCandidates: sha256(englishText), sourceConfig: sha256(configText),
  },
}
await Promise.all([
  writeFile(join(here, 'supplement-raw.jsonl'), rawText, 'utf8'),
  writeFile(join(here, 'supplement-source-records.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'supplement-translation-input.jsonl'), translationText, 'utf8'),
  writeFile(join(here, 'supplement-english.jsonl'), englishText, 'utf8'),
  writeFile(join(here, 'supplement-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log('froze 120 source-disjoint program candidates: 60 English, 60 awaiting Chinese translation')
