#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..', '..')
const configText = await readFile(join(here, 'candidate-sources.json'), 'utf8')
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

function languageMatches(text, language) {
  const letters = [...text].filter(character => /[A-Za-z\u3400-\u9fff]/u.test(character))
  const han = letters.filter(character => /[\u3400-\u9fff]/u.test(character)).length
  const ratio = letters.length === 0 ? 0 : han / letters.length
  return language === 'zh' ? ratio >= 0.08 : ratio <= 0.04
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

function rows(text) {
  return text.trim() === '' ? [] : text.trim().split('\n').map(line => JSON.parse(line))
}

const priorSourceFiles = [
  join(repositoryRoot, 'eval/router-corpus/blind-real.sources.jsonl'),
  join(repositoryRoot, 'eval/router-corpus/v2/sources.jsonl'),
  join(repositoryRoot, 'eval/router-corpus/v3/sources.jsonl'),
  join(repositoryRoot, 'eval/router-corpus/v3/supplement-source-records.jsonl'),
]
const priorRepositories = new Set()
const priorUrls = new Set()
for (const path of priorSourceFiles) {
  for (const row of rows(await readFile(path, 'utf8'))) {
    if (typeof row.repository === 'string') priorRepositories.add(row.repository.toLowerCase())
    if (typeof row.url === 'string') priorUrls.add(row.url)
  }
}
for (const group of config.groups) {
  const repository = group.query.match(/repo:([^\s]+)/)?.[1]
  if (repository === undefined) throw new Error(`query ${group.id} has no repository`)
  if (priorRepositories.has(repository.toLowerCase())) {
    throw new Error(`V4 source repository was used by an earlier router corpus: ${repository}`)
  }
}

const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
if (currentCommit !== config.codeFreezeCommit) {
  throw new Error(`router code must remain frozen at ${config.codeFreezeCommit}; current HEAD is ${currentCommit}`)
}

const candidates = []
const sources = []
const seenUrls = new Set(priorUrls)
for (const group of config.groups) {
  const matches = search(group.query)
    .filter(item => !seenUrls.has(item.html_url))
    .filter(item => languageMatches(`${item.title}\n${item.body ?? ''}`, group.language))
    .map(item => ({ item, order: sha256(`${config.seed}:${group.id}:${item.html_url}`) }))
    .sort((left, right) => left.order.localeCompare(right.order))
  if (matches.length < group.count) {
    throw new Error(`${group.id} produced ${matches.length} language-matching issues; expected ${group.count}`)
  }
  for (const { item } of matches.slice(0, group.count)) {
    seenUrls.add(item.html_url)
    const id = `v4-${String(candidates.length + 1).padStart(3, '0')}`
    const body = cleanBody(item.body, config.excerptCharacters)
    const text = `${item.title.trim()}${body === '' ? '' : `\n\n${body}`}`
    const repository = item.repository_url.split('/').slice(-2).join('/')
    candidates.push({ id, language: group.language, text })
    sources.push({
      id,
      repository,
      issueNumber: item.number,
      url: item.html_url,
      queryGroup: group.id,
      createdAt: item.created_at,
      closedAt: item.closed_at,
      titleDigest: sha256(item.title.trim()),
      sourceContentDigest: sha256(`${item.title.trim()}\n${String(item.body ?? '').trim()}`),
      promptDigest: sha256(text),
    })
  }
}
if (candidates.length !== config.expectedCandidates) {
  throw new Error(`candidate corpus must contain ${config.expectedCandidates} rows, got ${candidates.length}`)
}
const lines = values => `${values.map(value => JSON.stringify(value)).join('\n')}\n`
const candidateText = lines(candidates)
const sourceText = lines(sources)
const runtimeFiles = ['src/router.ts', 'src/task-invariants.ts', 'src/router-classifier.ts', 'src/router-model.ts']
const runtimeDigest = sha256((await Promise.all(runtimeFiles.map(path => readFile(join(repositoryRoot, path))))).map(value => sha256(value)).join('\n'))
const rubric = await readFile(join(here, 'ANNOTATION_RUBRIC.md'))
const manifest = {
  schemaVersion: 1,
  seed: config.seed,
  cutoff: config.cutoff,
  generatedAt: new Date().toISOString(),
  codeFreezeCommit: config.codeFreezeCommit,
  runtimeDigest,
  counts: {
    total: candidates.length,
    english: candidates.filter(row => row.language === 'en').length,
    chinese: candidates.filter(row => row.language === 'zh').length,
  },
  sourceIsolation: {
    priorRepositoryCount: priorRepositories.size,
    priorUrlCount: priorUrls.size,
    overlappingRepositories: [],
    overlappingUrls: [],
  },
  digests: {
    candidates: sha256(candidateText),
    sources: sha256(sourceText),
    sourceConfig: sha256(configText),
    annotationRubric: sha256(rubric),
  },
}
await Promise.all([
  writeFile(join(here, 'candidates.jsonl'), candidateText, 'utf8'),
  writeFile(join(here, 'sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'candidate-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])
console.log(`froze ${candidates.length} source-disjoint V4 candidates (${manifest.counts.english} en, ${manifest.counts.chinese} zh)`)
console.log(`code freeze: ${manifest.codeFreezeCommit}`)
console.log(`runtime digest: ${manifest.runtimeDigest}`)
