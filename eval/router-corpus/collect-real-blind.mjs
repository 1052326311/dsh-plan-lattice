#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(here, '..', '..')
const config = JSON.parse(await readFile(join(here, 'real-blind-sources.json'), 'utf8'))

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

const prompts = []
const labels = []
const sources = []
const seenUrls = new Set()

for (const group of config.groups) {
  const candidates = search(group.query)
    .filter(item => !seenUrls.has(item.html_url))
    .filter(item => languageMatches(`${item.title}\n${item.body ?? ''}`, group.language))
    .map(item => ({
      item,
      order: sha256(`${config.seed}:${group.id}:${item.html_url}`),
    }))
    .sort((left, right) => left.order.localeCompare(right.order))
  if (candidates.length < group.count) {
    throw new Error(`${group.id} produced ${candidates.length} language-matching issues; expected ${group.count}`)
  }
  for (const { item } of candidates.slice(0, group.count)) {
    seenUrls.add(item.html_url)
    const id = `real-blind-${String(prompts.length + 1).padStart(3, '0')}`
    const excerpt = cleanBody(item.body, config.excerptCharacters)
    const text = `${item.title.trim()}${excerpt === '' ? '' : `\n\n${excerpt}`}`
    const repository = item.repository_url.split('/').slice(-2).join('/')
    prompts.push({ id, split: 'blind', sourceGroup: group.id, language: group.language, text })
    labels.push({
      id,
      expected: group.expected,
      outcomeCritical: group.outcomeCritical,
      rubric: group.expected === 'bypass'
        ? 'Focused existing-behavior bug from a bug-only source query.'
        : group.expected === 'contract'
          ? 'Product-definition request whose outcome, boundary, truth source, authority, or acceptance requires a contract.'
          : 'Tracking, refactor, migration, or upgrade task with broad or evolving execution scope.',
    })
    sources.push({
      id,
      repository,
      issueNumber: item.number,
      url: item.html_url,
      titleDigest: sha256(item.title.trim()),
      sourceContentDigest: sha256(`${item.title.trim()}\n${String(item.body ?? '').trim()}`),
      queryGroup: group.id,
    })
  }
}

if (prompts.length !== 120 || labels.length !== 120 || sources.length !== 120) {
  throw new Error(`real blind corpus must contain 120 rows, got ${prompts.length}`)
}
const lines = value => `${value.map(row => JSON.stringify(row)).join('\n')}\n`
const promptText = lines(prompts)
const labelText = lines(labels)
const sourceText = lines(sources)
const routerSourceDigest = sha256(await readFile(join(repositoryRoot, 'src', 'router.ts')))
const manifest = {
  schemaVersion: 1,
  seed: config.seed,
  cutoff: config.cutoff,
  generatedAt: new Date().toISOString(),
  routerSourceDigest,
  counts: {
    total: prompts.length,
    english: prompts.filter(row => row.language === 'en').length,
    chinese: prompts.filter(row => row.language === 'zh').length,
    bypass: labels.filter(row => row.expected === 'bypass').length,
    contract: labels.filter(row => row.expected === 'contract').length,
    lattice: labels.filter(row => row.expected === 'lattice').length,
  },
  digests: {
    prompts: sha256(promptText),
    labels: sha256(labelText),
    sources: sha256(sourceText),
    sourceConfig: sha256(await readFile(join(here, 'real-blind-sources.json'))),
  },
}

await Promise.all([
  writeFile(join(here, 'blind-real.prompts.jsonl'), promptText, 'utf8'),
  writeFile(join(here, 'blind-real.labels.jsonl'), labelText, 'utf8'),
  writeFile(join(here, 'blind-real.sources.jsonl'), sourceText, 'utf8'),
  writeFile(join(here, 'blind-real.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
])

console.log(`froze ${prompts.length} real blind prompts (${manifest.counts.english} en, ${manifest.counts.chinese} zh)`)
console.log(`router source digest: ${routerSourceDigest}`)
