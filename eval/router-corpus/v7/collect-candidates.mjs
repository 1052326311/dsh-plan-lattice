#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  assertArtifactsAbsent,
  assertFrozenRuntime,
  here,
  lines,
  sha256,
  writeExclusive,
} from './protocol.mjs'
import { assertSourceDisjoint, priorSourceInventory } from './source-isolation.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const configPath = option('--config')
if (configPath === undefined) throw new Error('usage: collect-candidates.mjs --config <unrevealed-source-config.json>')
const absoluteConfigPath = resolve(process.cwd(), configPath)
const outputPaths = {
  candidates: join(here, 'candidates.jsonl'),
  sources: join(here, 'sources.jsonl'),
  manifest: join(here, 'candidate-manifest.json'),
  sourceConfig: join(here, 'source-config.archive.json'),
}
await assertArtifactsAbsent(Object.values(outputPaths), 'V7 collection')
const configText = await readFile(absoluteConfigPath, 'utf8')
const config = JSON.parse(configText)
if (config.schemaVersion !== 1 || !Array.isArray(config.groups) || config.groups.length === 0) {
  throw new Error('V7 source config requires schemaVersion 1 and non-empty groups')
}
if (config.expectedCandidates !== 360) throw new Error('V7 candidate pool must contain exactly 360 rows')
if (config.maxPromptCharacters !== 20000) throw new Error('V7 maxPromptCharacters must be frozen at 20000')
if (config.maxReporterUpdates !== 4) throw new Error('V7 maxReporterUpdates must be frozen at 4')
const frozen = await assertFrozenRuntime()
const prior = await priorSourceInventory()

function github(args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function waitForSearchBudget() {
  const rate = JSON.parse(github(['rate_limit'])).resources.search
  if (rate.remaining > 0) return
  const milliseconds = Math.max(1000, (rate.reset * 1000) - Date.now() + 1000)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function searchPage(query, page) {
  waitForSearchBudget()
  return JSON.parse(github([
    '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=created', '-f', 'order=asc', '-f', 'per_page=100', '-f', `page=${page}`,
  ]))
}

function repositoryHead(repository) {
  return JSON.parse(github([`repos/${repository}`])).default_branch
}

function branchHead(repository, branch) {
  return JSON.parse(github([`repos/${repository}/commits/${encodeURIComponent(branch)}`])).sha
}

function searchAll(query) {
  const first = searchPage(query, 1)
  if (first.total_count > 1000) throw new Error(`query exceeds GitHub's 1000-result search ceiling: ${query}`)
  const items = [...first.items]
  const pages = Math.ceil(first.total_count / 100)
  for (let page = 2; page <= pages; page += 1) {
    const response = searchPage(query, page)
    items.push(...response.items)
  }
  if (items.length !== first.total_count) throw new Error(`full pagination mismatch for ${query}`)
  return items
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/g, '[secret]')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function usefulIssue(item, body, maxCharacters) {
  if (body.length < 80 || body.length > maxCharacters) return false
  const text = `${item.title}\n${body}`
  if (/(?:spam|test issue|template test)|automatically closed because (?:the )?(?:issue|pr) template/i.test(item.title)) return false
  if (/a clear and concise description of what the bug is/i.test(text)) return false
  if ((text.match(/_No response_/gi) ?? []).length >= 4 && body.replace(/_No response_/gi, '').trim().length < 160) return false
  return true
}

function languageMatches(text, language) {
  const letters = [...text].filter(character => /[A-Za-z\u3400-\u9fff]/u.test(character))
  const han = letters.filter(character => /[\u3400-\u9fff]/u.test(character)).length
  const ratio = letters.length === 0 ? 0 : han / letters.length
  return language === 'zh' ? ratio >= 0.08 : ratio <= 0.04
}

function canonicalPrompt(text) {
  return text.toLowerCase()
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b\d+\b/g, '#')
    .replace(/[^a-z\u3400-\u9fff#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function reporterUpdates(repository, item) {
  if (item.comments === 0) return []
  const pages = JSON.parse(github([
    '--paginate', '--slurp', '-X', 'GET', `repos/${repository}/issues/${item.number}/comments`, '-f', 'per_page=100',
  ]))
  const comments = pages.flat()
  return comments
    .filter(comment => comment.user?.login === item.user?.login)
    .map(comment => ({ createdAt: comment.created_at, body: cleanText(comment.body) }))
    .filter(comment => comment.body.length >= 20)
    .slice(0, config.maxReporterUpdates)
}

const forbiddenQueryHint = /\b(?:bug|feature|tracking|proposal|question|enhancement|refactor)\b|(?:缺陷|功能|跟踪|提案|问题|重构)/i
const priorRepositories = new Set(prior.repositories)
for (const group of config.groups) {
  if (!['en', 'zh'].includes(group.language)) throw new Error(`${group.id} has invalid language`)
  if (!Number.isInteger(group.count) || group.count !== 15) throw new Error(`${group.id} count must be exactly 15`)
  if (forbiddenQueryHint.test(group.query)) throw new Error(`${group.id} query leaks a route-shaped search hint`)
  const repositories = [...String(group.query).matchAll(/(?:^|\s)repo:([^\s]+)/gi)].map(match => match[1].toLowerCase())
  if (repositories.length !== 1) throw new Error(`${group.id} must identify exactly one repository`)
  if (priorRepositories.has(repositories[0])) throw new Error(`${group.id} reuses a V1-V6 repository`)
}

const candidates = []
const sources = []
const seenUrls = new Set(prior.urls)
const seenPromptDigests = new Set(prior.promptDigests)
const seenCanonicalDigests = new Set()
for (const group of config.groups) {
  const repository = String(group.query).match(/(?:^|\s)repo:([^\s]+)/i)[1]
  const branch = repositoryHead(repository)
  const baseSha = branchHead(repository, branch)
  const matches = searchAll(group.query)
    .map(item => {
      const body = cleanText(item.body)
      const seedOrder = sha256(`${config.seed}:${group.id}:${item.html_url}`)
      return { item, body, seedOrder }
    })
    .filter(({ item, body }) => !seenUrls.has(item.html_url)
      && usefulIssue(item, body, config.maxPromptCharacters)
      && languageMatches(`${item.title}\n${body}`, group.language))
    .sort((left, right) => left.seedOrder.localeCompare(right.seedOrder))

  const eligible = []
  for (const match of matches) {
    const updates = reporterUpdates(repository, match.item)
    const updateText = updates.length === 0
      ? ''
      : `\n\nReporter updates:\n${updates.map(update => `[${update.createdAt}]\n${update.body}`).join('\n\n')}`
    const text = `${match.item.title.trim()}\n\n${match.body}${updateText}`.trim()
    if (text.length > config.maxPromptCharacters || !languageMatches(text, group.language)) continue
    const promptDigest = sha256(text)
    const canonicalDigest = sha256(canonicalPrompt(text))
    if (seenPromptDigests.has(promptDigest) || seenCanonicalDigests.has(canonicalDigest)) continue
    eligible.push({ ...match, updates, text, promptDigest, canonicalDigest })
    if (eligible.length === group.count) break
  }
  if (eligible.length !== group.count) {
    throw new Error(`${group.id} produced ${eligible.length} eligible full-source issues; expected ${group.count}`)
  }
  for (const { item, body, updates, text, promptDigest, canonicalDigest } of eligible) {
    const id = `v7-${String(candidates.length + 1).padStart(3, '0')}`
    seenUrls.add(item.html_url)
    seenPromptDigests.add(promptDigest)
    seenCanonicalDigests.add(canonicalDigest)
    candidates.push({ id, language: group.language, text })
    sources.push({
      id,
      repository,
      issueNumber: item.number,
      url: item.html_url,
      queryGroup: group.id,
      createdAt: item.created_at,
      closedAt: item.closed_at,
      defaultBranch: branch,
      collectionBaseSha: baseSha,
      titleDigest: sha256(item.title.trim()),
      bodyDigest: sha256(body),
      reporterUpdateCount: updates.length,
      reporterUpdatesDigest: sha256(JSON.stringify(updates)),
      sourceContentDigest: sha256(`${item.title.trim()}\n${String(item.body ?? '').trim()}`),
      promptDigest,
      canonicalPromptDigest: canonicalDigest,
    })
  }
}

assertSourceDisjoint(sources, prior)
if (candidates.length !== config.expectedCandidates) throw new Error(`expected 360 candidates, got ${candidates.length}`)
if (candidates.filter(row => row.language === 'en').length !== 180
  || candidates.filter(row => row.language === 'zh').length !== 180) {
  throw new Error('V7 candidates must be balanced at 180 rows per language')
}
if (new Set(sources.map(row => row.repository.toLowerCase())).size < 24) {
  throw new Error('V7 candidates must cover at least 24 source-disjoint repositories')
}

const candidateText = lines(candidates)
const sourceText = lines(sources)
const evidenceFiles = [
  'ANNOTATION_RUBRIC.md', 'annotation-schema.mjs', 'derive-label.mjs', 'agreement.mjs',
  'protocol.mjs', 'collect-candidates.mjs', 'source-isolation.mjs',
]
const evidence = Object.fromEntries(await Promise.all(evidenceFiles.map(async name => [name, await readFile(join(here, name), 'utf8')])))
const manifest = {
  schemaVersion: 1,
  purpose: 'unrevealed-source-disjoint-v7-candidate-pool',
  seed: config.seed,
  cutoff: config.cutoff,
  generatedAt: new Date().toISOString(),
  runtimeFreezeCommit: frozen.exactCommit,
  runtimeDigest: frozen.runtimeDigest,
  calibrationEvidence: {
    report: 'calibration-round2-agreement-report.json',
    sha256: sha256(await readFile(join(here, 'calibration-round2-agreement-report.json'))),
  },
  counts: {
    total: candidates.length,
    english: candidates.filter(row => row.language === 'en').length,
    chinese: candidates.filter(row => row.language === 'zh').length,
    repositories: new Set(sources.map(row => row.repository.toLowerCase())).size,
    reporterUpdates: sources.reduce((sum, row) => sum + row.reporterUpdateCount, 0),
  },
  sourceIsolation: {
    inventoryFiles: prior.files,
    inventoryVersions: prior.versions,
    priorRepositoryCount: prior.repositories.length,
    priorUrlCount: prior.urls.length,
    priorPromptDigestCount: prior.promptDigests.length,
    overlappingRepositories: [],
    overlappingUrls: [],
    overlappingPromptDigests: [],
  },
  digests: {
    candidates: sha256(candidateText),
    sources: sha256(sourceText),
    sourceConfig: sha256(configText),
    ...Object.fromEntries(Object.entries(evidence).map(([name, body]) => [name, sha256(body)])),
  },
}
await Promise.all([
  writeExclusive(outputPaths.candidates, candidateText),
  writeExclusive(outputPaths.sources, sourceText),
  writeExclusive(outputPaths.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
  writeExclusive(outputPaths.sourceConfig, configText),
])
console.log(JSON.stringify({ counts: manifest.counts, runtimeFreezeCommit: frozen.exactCommit, runtimeDigest: frozen.runtimeDigest }, null, 2))
