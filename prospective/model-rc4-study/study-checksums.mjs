#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryRoot } from './protocol.mjs'

const studyRoot = resolve(repositoryRoot, 'prospective/model-rc4-study')
const outputPath = join(studyRoot, 'study-checksums.sha256')

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function visit(root) {
  const files = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (path === outputPath) continue
    if (entry.isSymbolicLink()) throw new Error(`study checksum source must not contain symlinks: ${path}`)
    if (entry.isDirectory()) files.push(...await visit(path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`study checksum source contains a non-regular entry: ${path}`)
  }
  return files
}

export async function renderStudyChecksums() {
  const studyFiles = await visit(studyRoot)
  const attestationWorkflow = resolve(repositoryRoot, '.github/workflows/attest-rc4-freezes.yml')
  const tests = (await readdir(resolve(repositoryRoot, 'test'), { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^model-rc4-.*\.test\.ts$/u.test(entry.name))
    .map(entry => resolve(repositoryRoot, 'test', entry.name))
  const files = [attestationWorkflow, ...studyFiles, ...tests].sort((left, right) => left.localeCompare(right))
  const lines = []
  for (const path of files) {
    if (!(await stat(path)).isFile()) throw new Error(`checksum input is not a regular file: ${path}`)
    lines.push(`${digest(await readFile(path))}  ${relative(repositoryRoot, path)}`)
  }
  return `${lines.join('\n')}\n`
}

export async function writeStudyChecksums() {
  const rendered = await renderStudyChecksums()
  await writeFile(outputPath, rendered, 'utf8')
  return { outputPath, sha256: digest(rendered), files: rendered.trim().split('\n').length }
}

export async function verifyStudyChecksums() {
  const expected = await renderStudyChecksums()
  const actual = await readFile(outputPath, 'utf8')
  if (actual !== expected) throw new Error('RC.4 study checksums are stale')
  return { outputPath, sha256: digest(actual), files: actual.trim().split('\n').length }
}

function isMain() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
}

if (isMain()) {
  const result = process.argv.includes('--verify')
    ? await verifyStudyChecksums()
    : await writeStudyChecksums()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
