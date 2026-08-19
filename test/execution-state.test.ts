import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ExecutionStateError,
  PersistentExecutionState,
  executionLeaseClaim,
  type ExecutionCheckoutRequest,
  type PersistentExecutionStateOptions,
} from '../src/execution-state.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

const execution = {
  callId: 'call-1',
  toolName: 'write',
  argumentsDigest: DIGEST_A,
  basisDigest: DIGEST_B,
}

function request(overrides: Partial<ExecutionCheckoutRequest> = {}): ExecutionCheckoutRequest {
  return {
    ownerSessionId: 'owner-session-1',
    rootSessionId: 'root-session-1',
    nodeId: 'node-1',
    graphRevision: 4,
    contractRevision: 2,
    contractDigest: DIGEST_A,
    ...overrides,
  }
}

function runtime(
  processId: number,
  processLiveness: PersistentExecutionStateOptions['processLiveness'] = () => 'alive',
  host = 'test-host',
  overrides: Partial<PersistentExecutionStateOptions> = {},
): PersistentExecutionState {
  return new PersistentExecutionState({
    processId,
    host,
    processLiveness,
    deadOwnerGraceMs: 0,
    lockRetryMs: 1,
    lockTimeoutMs: 1_000,
    ...overrides,
  })
}

async function workspaceTest(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-execution-state-'))
  try {
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

describe('persistent execution state', () => {
  it('atomically checks out one complete ownership basis and persists it', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_001)
      expect(await state.read(workspace)).toEqual({ schemaVersion: 2, generation: 0, lease: null })

      const lease = await state.checkout(workspace, request({ expectedGeneration: 0 }))
      expect(lease).toMatchObject({
        ownerSessionId: 'owner-session-1',
        rootSessionId: 'root-session-1',
        nodeId: 'node-1',
        graphRevision: 4,
        contractRevision: 2,
        contractDigest: DIGEST_A,
        generation: 1,
        dirty: false,
        checkpointRequired: false,
        ownerPid: 10_001,
        ownerHost: 'test-host',
      })
      expect((await state.read(workspace)).lease).toEqual(lease)

      const raw = JSON.parse(await readFile(
        join(workspace, '.dsh', 'plan-lattice', 'execution-state', 'v1', 'state.json'),
        'utf8',
      )) as { generation: number }
      expect(raw.generation).toBe(1)
    })
  })

  it('allows only one of two independent instances to checkout concurrently', async () => {
    await workspaceTest(async workspace => {
      const first = runtime(10_011, pid => pid === 10_011 ? 'alive' : 'unknown')
      const second = runtime(10_012, pid => pid === 10_012 ? 'alive' : 'unknown')
      const attempts = await Promise.allSettled([
        first.checkout(workspace, request({ ownerSessionId: 'first' })),
        second.checkout(workspace, request({ ownerSessionId: 'second' })),
      ])

      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = attempts.find(result => result.status === 'rejected')
      expect(rejected).toMatchObject({ reason: { code: 'LEASE_CONFLICT' } })
      expect((await first.read(workspace)).generation).toBe(1)
    })
  })

  it('uses generation and lease identity as compare-and-swap ownership', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_021)
      const lease = await state.checkout(workspace, request())

      await expect(state.checkout(workspace, request({ expectedGeneration: 0 })))
        .rejects.toMatchObject({ code: 'GENERATION_MISMATCH' })
      await expect(state.beginExecution(workspace, { ...executionLeaseClaim(lease), leaseId: 'not-the-lease' }, execution))
        .rejects.toMatchObject({ code: 'LEASE_OWNERSHIP' })

      const dirty = await state.beginExecution(workspace, executionLeaseClaim(lease), execution)
      expect(dirty.generation).toBe(2)
      await expect(state.release(workspace, executionLeaseClaim(lease)))
        .rejects.toMatchObject({ code: 'LEASE_OWNERSHIP' })
    })
  })

  it('offers synchronous recovery discovery and current-owner verification without granting write authority', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_025)
      expect(state.readSync(workspace)).toEqual({ schemaVersion: 2, generation: 0, lease: null })
      const lease = await state.checkout(workspace, request())

      expect(state.readSync(workspace).lease).toEqual(lease)
      expect(state.verifyOwnershipSync(workspace, executionLeaseClaim(lease))).toEqual(lease)
      expect(() => state.verifyOwnershipSync(workspace, {
        ...executionLeaseClaim(lease),
        generation: lease.generation + 1,
      })).toThrowError(expect.objectContaining({ code: 'LEASE_OWNERSHIP' }))
    })
  })

  it('migrates v1 state in memory and keeps a legacy dirty action indeterminate', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_026)
      const lease = await state.checkout(workspace, request())
      const statePath = join(workspace, '.dsh', 'plan-lattice', 'execution-state', 'v1', 'state.json')
      await writeFile(statePath, `${JSON.stringify({
        schemaVersion: 1,
        generation: lease.generation,
        lease: { ...lease, dirty: true, checkpointRequired: true },
      }, null, 2)}\n`, 'utf8')

      const migrated = await state.read(workspace)
      expect(migrated).toMatchObject({
        schemaVersion: 2,
        lease: { dirty: true, checkpointRequired: true, legacyIndeterminate: true },
      })
      await expect(state.checkpoint(workspace, executionLeaseClaim(migrated.lease!), { graphRevision: 5 }))
        .rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
      await expect(state.beginExecution(workspace, executionLeaseClaim(migrated.lease!), execution))
        .rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
    })
  })

  it('lets a replacement module in the same process release a clean lease during normal disposal', async () => {
    await workspaceTest(async workspace => {
      const active = runtime(10_027)
      await active.checkout(workspace, request())

      const disposing = runtime(10_027)
      const persisted = disposing.readSync(workspace).lease
      expect(persisted).not.toBeNull()
      const released = await disposing.release(workspace, executionLeaseClaim(persisted!))
      expect(released).toEqual({ schemaVersion: 2, generation: 2, lease: null })
    })
  })

  it('persists an exact pending attempt across restart and settles only its matching receipt', async () => {
    await workspaceTest(async workspace => {
      const first = runtime(10_031)
      const checkedOut = await first.checkout(workspace, request())
      const dirty = await first.beginExecution(workspace, executionLeaseClaim(checkedOut), execution)

      const restarted = runtime(10_031)
      expect((await restarted.read(workspace)).lease).toMatchObject({
        generation: 2,
        dirty: true,
        checkpointRequired: true,
        pendingExecution: expect.objectContaining(execution),
      })
      await expect(restarted.release(workspace, executionLeaseClaim(dirty)))
        .rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })

      await expect(restarted.checkpoint(workspace, executionLeaseClaim(dirty), { graphRevision: 5 }))
        .rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
      await expect(restarted.settleExecution(workspace, executionLeaseClaim(dirty), 'wrong-attempt', { graphRevision: 5 }))
        .rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
      const checkpointed = await restarted.settleExecution(
        workspace,
        executionLeaseClaim(dirty),
        dirty.pendingExecution!.attemptId,
        { graphRevision: 5 },
      )
      expect(checkpointed.lease).toMatchObject({
        generation: 3,
        graphRevision: 5,
        dirty: false,
        checkpointRequired: false,
      })
      const released = await restarted.release(workspace, executionLeaseClaim(checkpointed.lease!))
      expect(released).toEqual({ schemaVersion: 2, generation: 4, lease: null })
    })
  })

  it('persists release intent across restart and applies it when the exact pending receipt settles', async () => {
    await workspaceTest(async workspace => {
      const first = runtime(10_032)
      const checkedOut = await first.checkout(workspace, request())
      const dirty = await first.beginExecution(workspace, executionLeaseClaim(checkedOut), execution)
      const marked = await first.requestReleaseWhenClean(workspace, executionLeaseClaim(dirty))

      expect(marked).toMatchObject({ dirty: true, releaseWhenClean: true })
      const restarted = runtime(10_032)
      const recovered = (await restarted.read(workspace)).lease
      expect(recovered).toMatchObject({ dirty: true, releaseWhenClean: true })
      const settled = await restarted.settleExecution(
        workspace,
        executionLeaseClaim(recovered!),
        recovered!.pendingExecution!.attemptId,
        { graphRevision: 5 },
      )
      expect(settled).toEqual({ schemaVersion: 2, generation: 4, lease: null })
    })
  })

  it('durably marks checkpointRequired before a protected tool body may start', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_035)
      const lease = await state.checkout(workspace, request())
      const dirty = await state.beginExecution(workspace, executionLeaseClaim(lease), execution)

      const observedAtToolBodyEntry = runtime(10_035).readSync(workspace).lease
      expect(observedAtToolBodyEntry).toEqual(dirty)
      expect(observedAtToolBodyEntry).toMatchObject({ dirty: true, checkpointRequired: true })
    })
  })

  it('can settle an exact execution receipt and release ownership in one durable transition', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_041)
      const lease = await state.checkout(workspace, request())
      const dirty = await state.beginExecution(workspace, executionLeaseClaim(lease), execution)
      const released = await state.settleExecution(
        workspace,
        executionLeaseClaim(dirty),
        dirty.pendingExecution!.attemptId,
        { release: true, graphRevision: 5 },
      )

      expect(released).toEqual({ schemaVersion: 2, generation: 3, lease: null })
      expect(await new PersistentExecutionState().read(workspace)).toEqual(released)
    })
  })

  it('takes over only a definitely dead local owner and advances generation', async () => {
    await workspaceTest(async workspace => {
      const original = runtime(10_051)
      await original.checkout(workspace, request())

      const successor = runtime(10_052, pid => pid === 10_051 ? 'dead' : 'alive')
      const replacement = await successor.checkout(workspace, request({ ownerSessionId: 'successor' }))
      expect(replacement).toMatchObject({
        ownerSessionId: 'successor',
        ownerPid: 10_052,
        generation: 2,
        dirty: false,
      })
    })
  })

  it('does not let a dead release-pending lease become authority for a different task', async () => {
    await workspaceTest(async workspace => {
      const original = runtime(10_053)
      const lease = await original.checkout(workspace, request())
      const marked = await original.requestReleaseWhenClean(workspace, executionLeaseClaim(lease))

      const successor = runtime(10_054, pid => pid === 10_053 ? 'dead' : 'alive')
      await expect(successor.checkout(workspace, request({
        ownerSessionId: 'different-task',
        rootSessionId: 'different-root',
      }))).rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
      const recovered = await successor.checkout(workspace, request({ ownerSessionId: 'release-recovery' }))
      expect(recovered).toMatchObject({ releaseWhenClean: true, generation: marked.generation + 1 })
      expect(await successor.checkpoint(workspace, executionLeaseClaim(recovered)))
        .toEqual({ schemaVersion: 2, generation: recovered.generation + 1, lease: null })
    })
  })

  it('preserves a dead dirty lease basis until its successor checkpoints it', async () => {
    await workspaceTest(async workspace => {
      const original = runtime(10_061)
      const lease = await original.checkout(workspace, request())
      const dirty = await original.beginExecution(workspace, executionLeaseClaim(lease), execution)
      expect(dirty.generation).toBe(2)

      const successor = runtime(10_062, pid => pid === 10_061 ? 'dead' : 'alive')
      await expect(successor.checkout(workspace, request({
        ownerSessionId: 'successor',
        nodeId: 'different-node',
      }))).rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })
      await expect(successor.checkout(workspace, request({
        ownerSessionId: 'successor',
        contractRevision: 3,
        contractDigest: DIGEST_B,
      }))).rejects.toMatchObject({ code: 'CHECKPOINT_REQUIRED' })

      const recovered = await successor.checkout(workspace, request({ ownerSessionId: 'successor' }))
      expect(recovered).toMatchObject({
        generation: 3,
        dirty: true,
        checkpointRequired: true,
        nodeId: 'node-1',
        contractRevision: 2,
      })
      expect(recovered.pendingExecution).toEqual(dirty.pendingExecution)
      const settled = await successor.settleExecution(
        workspace,
        executionLeaseClaim(recovered),
        recovered.pendingExecution!.attemptId,
        { release: true, graphRevision: 5 },
      )
      expect(settled).toEqual({ schemaVersion: 2, generation: 4, lease: null })
    })
  })

  it('fails closed for a foreign-host or unverifiable owner PID', async () => {
    await workspaceTest(async workspace => {
      await runtime(10_071, () => 'alive', 'host-a').checkout(workspace, request())

      await expect(runtime(10_072, () => 'dead', 'host-b').checkout(workspace, request({ ownerSessionId: 'foreign' })))
        .rejects.toMatchObject({ code: 'LEASE_CONFLICT' })
      await expect(runtime(10_073, () => 'unknown', 'host-a').checkout(workspace, request({ ownerSessionId: 'unknown' })))
        .rejects.toMatchObject({ code: 'LEASE_CONFLICT' })
    })
  })

  it('surfaces typed state errors without weakening the persisted owner', async () => {
    await workspaceTest(async workspace => {
      const state = runtime(10_081)
      const lease = await state.checkout(workspace, request())
      try {
        await state.release(workspace, { ...executionLeaseClaim(lease), generation: 99 })
        throw new Error('expected release to fail')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ExecutionStateError)
        expect((error as ExecutionStateError).code).toBe('LEASE_OWNERSHIP')
      }
      expect((await state.read(workspace)).lease?.leaseId).toBe(lease.leaseId)
    })
  })

  it('returns the checkout claim after retrying the first post-rename directory fsync failure', async () => {
    await workspaceTest(async workspace => {
      let syncAttempts = 0
      const state = runtime(10_091, undefined, 'test-host', {
        directorySync: async () => {
          syncAttempts += 1
          if (syncAttempts === 1) throw new Error('injected first checkout directory fsync failure')
        },
      })

      const lease = await state.checkout(workspace, request())
      expect(syncAttempts).toBe(2)
      expect(lease).toMatchObject({ generation: 1, ownerPid: 10_091, dirty: false })
      expect((await state.read(workspace)).lease).toEqual(lease)
    })
  })

  it('returns the advanced transition claim after retrying a post-rename directory fsync failure', async () => {
    await workspaceTest(async workspace => {
      let injectFailure = false
      let transitionSyncAttempts = 0
      const state = runtime(10_092, undefined, 'test-host', {
        directorySync: async () => {
          if (!injectFailure) return
          transitionSyncAttempts += 1
          if (transitionSyncAttempts === 1) throw new Error('injected first transition directory fsync failure')
        },
      })
      const lease = await state.checkout(workspace, request())
      injectFailure = true

      const dirty = await state.beginExecution(workspace, executionLeaseClaim(lease), execution)
      expect(transitionSyncAttempts).toBe(2)
      expect(dirty).toMatchObject({ generation: 2, dirty: true, checkpointRequired: true })
      expect((await state.read(workspace)).lease).toEqual(dirty)
    })
  })

  it('retains an unconfirmed checkout lock and lets a dead-owner successor recover its claim', async () => {
    await workspaceTest(async workspace => {
      const originalPid = 10_093
      const original = runtime(originalPid, undefined, 'test-host', {
        directorySyncAttempts: 2,
        directorySync: async () => {
          throw new Error('injected persistent execution-state directory fsync failure')
        },
      })

      await expect(original.checkout(workspace, request()))
        .rejects.toThrow(/visible but directory durability could not be confirmed/i)
      const visible = await original.read(workspace)
      expect(visible.lease).toMatchObject({ generation: 1, ownerPid: originalPid, nodeId: 'node-1' })
      expect(JSON.parse(await readFile(
        join(workspace, '.dsh', 'plan-lattice', 'execution-state', 'v1', '.lock'),
        'utf8',
      ))).toMatchObject({ ownerPid: originalPid })

      const blockedSuccessor = runtime(10_094, pid => pid === originalPid ? 'dead' : 'alive', 'test-host', {
        directorySyncAttempts: 1,
        directorySync: async () => {
          throw new Error('injected dead-owner recovery directory fsync failure')
        },
      })
      await expect(blockedSuccessor.checkout(workspace, request({ ownerSessionId: 'blocked-successor' })))
        .rejects.toThrow(/visible but directory durability could not be confirmed/i)
      expect(JSON.parse(await readFile(
        join(workspace, '.dsh', 'plan-lattice', 'execution-state', 'v1', '.lock'),
        'utf8',
      ))).toMatchObject({ ownerPid: originalPid })

      const successor = runtime(10_095, pid => pid === originalPid ? 'dead' : 'alive')
      const recovered = await successor.checkout(workspace, request({ ownerSessionId: 'recovered-owner' }))
      expect(recovered).toMatchObject({
        generation: 2,
        ownerPid: 10_095,
        ownerSessionId: 'recovered-owner',
        nodeId: 'node-1',
      })
      expect((await successor.read(workspace)).lease).toEqual(recovered)
    })
  })
})
