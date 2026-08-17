import { Worker } from 'node:worker_threads'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LATTICE_SCHEMA_VERSION, type LatticeState } from '../src/domain.js'
import { LatticeStore, readLatticeStateSync } from '../src/store.js'

function initial(revision = 1): LatticeState {
  return {
    schemaVersion: LATTICE_SCHEMA_VERSION,
    revision,
    project: {
      title: 'Consistency test',
      objective: 'Authorize only a stable durable graph.',
      contextPaths: ['PRODUCT.md'],
      createdAt: 1,
      updatedAt: revision,
    },
    nodes: {},
  }
}

function storePaths(workspace: string) {
  const directory = join(workspace, '.dsh', 'plan-lattice', 'v1')
  return {
    snapshot: join(directory, 'snapshot.json'),
    ledger: join(directory, 'ledger.jsonl'),
    version: join(directory, 'version'),
    lock: join(directory, '.lock'),
  }
}

describe('synchronous lattice consistency reads', () => {
  it('uses version as the commit marker and never exposes an uncommitted ledger tail', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-consistency-'))
    try {
      await new LatticeStore().create(workspace, initial(), undefined)
      const paths = storePaths(workspace)
      const delta = { revision: 2, upserts: [], action: 'uncommitted', at: 2 }

      await writeFile(paths.ledger, `${JSON.stringify(delta)}\n{"revision":`, 'utf8')
      expect(readLatticeStateSync(workspace)?.revision).toBe(1)
      expect((await new LatticeStore().read(workspace))?.revision).toBe(1)

      await writeFile(paths.ledger, '', 'utf8')
      await writeFile(paths.version, '2\n', 'utf8')
      expect(() => readLatticeStateSync(workspace)).toThrow(/materialized revision 1 does not match committed version 2/i)

      await writeFile(paths.snapshot, `${JSON.stringify(initial(2), null, 2)}\n`, 'utf8')
      await writeFile(paths.version, '1\n', 'utf8')
      expect(() => readLatticeStateSync(workspace)).toThrow(/snapshot revision 2 exceeds committed version 1/i)

      await writeFile(paths.version, '2\n', 'utf8')
      expect(readLatticeStateSync(workspace)?.revision).toBe(2)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a persistent writer lock and retries a lock released by another thread', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-lock-'))
    let worker: Worker | undefined
    try {
      await new LatticeStore().create(workspace, initial(), undefined)
      const paths = storePaths(workspace)
      await writeFile(paths.lock, `${JSON.stringify({
        pid: process.pid,
        ownerToken: 'live-sync-owner-token-0001',
        acquiredAt: Date.now(),
      })}\n`, 'utf8')
      expect(() => readLatticeStateSync(workspace)).toThrow(/failed to read a consistent lattice state.*writer lock/i)

      await rm(paths.lock, { force: true })
      expect(readLatticeStateSync(workspace)?.revision).toBe(1)

      await writeFile(paths.lock, `${JSON.stringify({
        pid: process.pid,
        ownerToken: 'live-sync-owner-token-0002',
        acquiredAt: Date.now(),
      })}\n`, 'utf8')
      worker = new Worker(`
        const { parentPort } = require('node:worker_threads')
        const { rmSync } = require('node:fs')
        const delay = new Int32Array(new SharedArrayBuffer(4))
        parentPort.once('message', path => {
          parentPort.postMessage('armed')
          Atomics.wait(delay, 0, 0, 20)
          rmSync(path, { force: true })
          parentPort.postMessage('released')
        })
      `, { eval: true })
      const armed = new Promise<void>(resolve => worker!.on('message', message => {
        if (message === 'armed') resolve()
      }))
      const released = new Promise<void>(resolve => worker!.on('message', message => {
        if (message === 'released') resolve()
      }))
      worker.postMessage(paths.lock)
      await armed

      expect(readLatticeStateSync(workspace)?.revision).toBe(1)
      await released
      expect(await readFile(paths.version, 'utf8')).toBe('1\n')
    } finally {
      await worker?.terminate()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('checks create authority after staging and before the first durable rename', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-create-commit-'))
    try {
      const paths = storePaths(workspace)
      let sawStagedSnapshot = false
      await expect(new LatticeStore().create(workspace, initial(), undefined, () => {
        const entries = readdirSync(join(workspace, '.dsh', 'plan-lattice', 'v1'))
        sawStagedSnapshot = entries.some(entry => entry.startsWith('snapshot.json.') && entry.endsWith('.tmp'))
        throw new Error('authorization epoch changed before commit')
      })).rejects.toThrow(/authorization epoch changed/i)

      expect(sawStagedSnapshot).toBe(true)
      const entries = await readdir(join(workspace, '.dsh', 'plan-lattice', 'v1'))
      expect(entries).not.toContain('snapshot.json')
      expect(entries.some(entry => entry.endsWith('.tmp'))).toBe(false)
      expect(() => readLatticeStateSync(workspace)).not.toThrow()
      expect(readLatticeStateSync(workspace)).toBeUndefined()
      await expect(readFile(paths.version, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('never exposes and safely replaces a graph left in pending creation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-pending-create-'))
    try {
      const paths = storePaths(workspace)
      await mkdir(join(workspace, '.dsh', 'plan-lattice', 'v1'), { recursive: true })
      await writeFile(paths.version, '0\n', 'utf8')
      await writeFile(paths.snapshot, `${JSON.stringify(initial(), null, 2)}\n`, 'utf8')
      await writeFile(paths.ledger, '', 'utf8')

      expect(() => readLatticeStateSync(workspace)).toThrow(/invalid lattice version/i)
      await expect(new LatticeStore().read(workspace)).rejects.toThrow(/invalid lattice version/i)

      const replacement = initial()
      replacement.project.title = 'Recovered creation'
      await new LatticeStore().create(workspace, replacement, undefined)
      expect(readLatticeStateSync(workspace)?.project.title).toBe('Recovered creation')
      expect(await readFile(paths.version, 'utf8')).toBe('1\n')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
