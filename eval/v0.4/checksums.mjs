#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderProtocolChecksums } from './lib/integrity.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const checksumPath = join(root, 'checksums.sha256')
const { rendered, files } = await renderProtocolChecksums()
if (process.argv.includes('--write')) {
  await writeFile(checksumPath, rendered, 'utf8')
  console.log(`wrote ${checksumPath}`)
} else {
  const existing = await readFile(checksumPath, 'utf8')
  if (existing !== rendered) throw new Error('protocol checksum mismatch; do not execute statistical runs until the preregistration is intentionally re-frozen')
  console.log(`checksums ok: ${files.length} files`)
}
