import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('the CLI entrypoint remains dependency-free ESM', async () => {
  const source = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /require\s*\(/)
})
