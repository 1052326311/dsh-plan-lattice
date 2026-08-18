import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { digestAssetPath } from '../../pilots/driver/provenance.mjs'

test('ICAE asset digests bind content, paths, executable modes, and links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plan-lattice-provenance-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'test.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await symlink('nested/test.sh', join(root, 'test-link'))
    const first = await digestAssetPath(root)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(await digestAssetPath(root), first)

    await writeFile(join(root, 'nested', 'test.sh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    assert.notEqual(await digestAssetPath(root), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
