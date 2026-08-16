import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')

for (const name of ['driver-result.schema.json', 'manifest.schema.json', 'run-result.schema.json']) {
  test(`${name} is valid JSON Schema source`, async () => {
    const schema = JSON.parse(await readFile(join(root, name), 'utf8'))
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.equal(schema.type, 'object')
  })
}
