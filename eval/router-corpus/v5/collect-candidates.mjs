#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertFrozenRuntime,
  codeFreezeCommit,
  here,
  lines,
  sha256,
} from './protocol.mjs'
import { assertSourceDisjoint, priorSourceInventory } from './source-isolation.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const configPath = option('--config')
if (configPath === undefined) {
  throw new Error('usage: collect-candidates.mjs --config <unrevealed-source-config.json>')
}
const absoluteConfigPath = resolve(process.cwd(), configPath)
const configText = await readFile(absoluteConfigPath, 'utf8')
const config = JSON.parse(configText)
if (config.codeFreezeCommit !== codeFreezeCommit) throw new Error(`source config must bind codeFreezeCommit ${codeFreezeCommit}`)
if (!Array.isArray(config.groups) || config.groups.length === 0) throw new Error('source config requires non-empty groups')
const runtimeDigest = await assertFrozenRuntime()
const prior = await priorSourceInventory()

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

const priorRepositories = new Set(prior.repositories)
const priorUrls = new Set(prior.urls)
for (const group of config.groups) {
  if (!['en', 'zh'].includes(group.language)) throw new Error(`${group.id} has invalid language`)
  if (!Number.isInteger(group.count) || group.count <= 0) throw new Error(`${group.id} has invalid count`)
  const repositories = [...String(group.query).matchAll(/(?:^|\s)repo:([^\s]+)/gi)].map(match => match[1].toLowerCase())
  if (repositories.length === 0) throw new Error(`${group.id} query must identify a repository`)
  for (const repository of repositories) {
    if (priorRepositories.has(repository)) throw new Error(`V5 query reuses a V1-V4 repository: ${repository}`)
  }
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
  if (matches.length < group.count) throw new Error(`${group.id} produced ${matches.length} eligible issues; expected ${group.count}`)
  for (const { item } of matches.slice(0, group.count)) {
    seenUrls.add(item.html_url)
    const id = `v5-${String(candidates.length + 1).padStart(3, '0')}`
    const body = cleanBody(item.body, config.excerptCharacters ?? 1800)
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
assertSourceDisjoint(sources, prior)
if (candidates.length !== config.expectedCandidates) {
  throw new Error(`candidate corpus must contain ${config.expectedCandidates} rows, got ${candidates.length}`)
}
const candidateText = lines(candidates)
const sourceText = lines(sources)
const rubric = await readFile(join(here, 'ANNOTATION_RUBRIC.md'))
const manifest = {
  schemaVersion: 1,
  seed: config.seed,
  cutoff: config.cutoff,
  generatedAt: new Date().toISOString(),
  codeFreezeCommit,
  runtimeDigest,
  counts: {
    total: candidates.length,
    english: candidates.filter(row => row.language === 'en').length,
    chinese: candidates.filter(row => row.language === 'zh').length,
  },
  sourceIsolation: {
    inventoryFiles: prior.files,
    inventoryVersions: prior.versions,
    priorRepositoryCount: prior.repositories.length,
    priorUrlCount: prior.urls.length,
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
console.log(JSON.stringify({ counts: manifest.counts, codeFreezeCommit, runtimeDigest }, null, 2))
