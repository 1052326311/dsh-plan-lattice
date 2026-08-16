#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseJsonLines, repositoryRoot, sha256 } from './protocol.mjs'

const corpusRoot = join(repositoryRoot, 'eval/router-corpus')

function sourceVersion(path) {
  const relativePath = relative(corpusRoot, path)
  const first = relativePath.split(sep)[0]
  return /^v[1-4]$/.test(first) ? first : 'v1'
}

function isPriorSourceFile(path) {
  const relativePath = relative(corpusRoot, path)
  const first = relativePath.split(sep)[0]
  const inPriorVersion = !first.startsWith('v') || /^v[1-4]$/.test(first)
  return inPriorVersion && /source/i.test(basename(path)) && /\.jsonl?$/i.test(path)
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
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

function collectValues(value, repositories, urls) {
  if (Array.isArray(value)) {
    for (const child of value) collectValues(child, repositories, urls)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (typeof value.repository === 'string') repositories.add(normalizeRepository(value.repository))
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
  for (const child of Object.values(value)) collectValues(child, repositories, urls)
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
  const records = []
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    collectValues(parseSourceFile(text, path), repositories, urls)
    records.push({
      path: relative(repositoryRoot, path),
      version: sourceVersion(path),
      digest: sha256(text),
    })
  }
  const versions = Object.fromEntries(['v1', 'v2', 'v3', 'v4'].map(version => [
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
  }
}

export function assertSourceDisjoint(rows, inventory) {
  const priorRepositories = new Set(inventory.repositories)
  const priorUrls = new Set(inventory.urls)
  const seenRepositories = new Set()
  const seenUrls = new Set()
  for (const row of rows) {
    const repository = normalizeRepository(row.repository)
    const url = normalizeUrl(row.url)
    if (priorRepositories.has(repository)) throw new Error(`V5 reuses a V1-V4 repository: ${row.repository}`)
    if (priorUrls.has(url)) throw new Error(`V5 reuses a V1-V4 URL: ${row.url}`)
    if (seenUrls.has(url)) throw new Error(`V5 duplicates URL: ${row.url}`)
    seenRepositories.add(repository)
    seenUrls.add(url)
  }
  return { repositories: seenRepositories, urls: seenUrls }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(JSON.stringify(await priorSourceInventory(), null, 2))
}
