#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseJsonLines, repositoryRoot, sha256 } from './protocol.mjs'

const corpusRoot = join(repositoryRoot, 'eval/router-corpus')

function sourceVersion(path) {
  const first = relative(corpusRoot, path).split(sep)[0]
  return /^v[1-6]$/.test(first) ? first : 'v1'
}

function isPriorSourceFile(path) {
  const first = relative(corpusRoot, path).split(sep)[0]
  const prior = !first.startsWith('v') || /^v[1-6]$/.test(first)
  return prior && /source/i.test(basename(path)) && /\.jsonl?$/i.test(path)
}

async function walk(path) {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...await walk(child))
    else if (entry.isFile() && isPriorSourceFile(child)) files.push(child)
  }
  return files
}

function normalizeRepository(value) {
  return String(value).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
}

function normalizeUrl(value) {
  try {
    const parsed = new URL(String(value))
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return String(value).trim()
  }
}

function repositoryFromUrl(value) {
  try {
    const parsed = new URL(String(value))
    if (parsed.hostname.toLowerCase() !== 'github.com') return undefined
    const [owner, repository] = parsed.pathname.split('/').filter(Boolean)
    return owner && repository ? normalizeRepository(`${owner}/${repository}`) : undefined
  } catch {
    return undefined
  }
}

function collectValues(value, repositories, urls, promptDigests) {
  if (Array.isArray(value)) {
    for (const child of value) collectValues(child, repositories, urls, promptDigests)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (typeof value.repository === 'string') repositories.add(normalizeRepository(value.repository))
  if (typeof value.promptDigest === 'string') promptDigests.add(value.promptDigest)
  for (const key of ['url', 'html_url']) {
    if (typeof value[key] !== 'string') continue
    const normalized = normalizeUrl(value[key])
    urls.add(normalized)
    const repository = repositoryFromUrl(normalized)
    if (repository !== undefined) repositories.add(repository)
  }
  if (typeof value.query === 'string') {
    for (const match of value.query.matchAll(/(?:^|\s)repo:([^\s]+)/gi)) repositories.add(normalizeRepository(match[1]))
  }
  for (const child of Object.values(value)) collectValues(child, repositories, urls, promptDigests)
}

function parseSourceFile(text, path) {
  if (path.endsWith('.jsonl')) return parseJsonLines(text, relative(repositoryRoot, path))
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${relative(repositoryRoot, path)} is not valid JSON`, { cause: error })
  }
}

export async function priorSourceInventory() {
  const files = (await walk(corpusRoot)).sort()
  const repositories = new Set()
  const urls = new Set()
  const promptDigests = new Set()
  const records = []
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    collectValues(parseSourceFile(text, path), repositories, urls, promptDigests)
    records.push({ path: relative(repositoryRoot, path), version: sourceVersion(path), digest: sha256(text) })
  }
  const versions = Object.fromEntries(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'].map(version => [
    version,
    records.filter(record => record.version === version).length,
  ]))
  for (const [version, count] of Object.entries(versions)) {
    if (count === 0) throw new Error(`no ${version} source files were discovered`)
  }
  return {
    files: records,
    versions,
    repositories: [...repositories].filter(Boolean).sort(),
    urls: [...urls].filter(Boolean).sort(),
    promptDigests: [...promptDigests].filter(Boolean).sort(),
  }
}

export function assertSourceDisjoint(rows, inventory) {
  const priorRepositories = new Set(inventory.repositories)
  const priorUrls = new Set(inventory.urls)
  const priorDigests = new Set(inventory.promptDigests)
  const seenUrls = new Set()
  const seenDigests = new Set()
  const seenRepositories = new Set()
  for (const row of rows) {
    const repository = normalizeRepository(row.repository)
    const url = normalizeUrl(row.url)
    if (priorRepositories.has(repository)) throw new Error(`V7 reuses a V1-V6 repository: ${row.repository}`)
    if (priorUrls.has(url)) throw new Error(`V7 reuses a V1-V6 URL: ${row.url}`)
    if (priorDigests.has(row.promptDigest)) throw new Error(`V7 reuses a V1-V6 prompt digest: ${row.promptDigest}`)
    if (seenUrls.has(url)) throw new Error(`V7 duplicates URL: ${row.url}`)
    if (seenDigests.has(row.promptDigest)) throw new Error(`V7 duplicates prompt digest: ${row.promptDigest}`)
    seenRepositories.add(repository)
    seenUrls.add(url)
    seenDigests.add(row.promptDigest)
  }
  return { repositories: seenRepositories, urls: seenUrls, promptDigests: seenDigests }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await priorSourceInventory(), null, 2))
}
