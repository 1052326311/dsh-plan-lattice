import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  loadRuntimeAcquisitionLock,
  RUNTIME_ACQUISITION_LOCK_SHA256,
  validateRuntimeAcquisitionLock,
  verifyRuntimeAcquisition,
} from '../prospective/model-rc4-study/runtime-acquisition.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = process.env.PLAN_LATTICE_RC4_RUNTIME_ACQUISITION_ROOT ?? resolve(
  repositoryRoot,
  '..',
  'dsh-plan-lattice-eval-artifacts',
  'model-rc4-study',
  'runtime-build-31982987064',
)
const rc3Commit = 'dc55716525987fcb7cb46579a9c957877cbd23c2'

async function cloneTree(source: string, destination: string) {
  const clone = spawnSync('cp', ['-cR', source, destination], { encoding: 'utf8' })
  if (clone.status === 0) return
  await cp(source, destination, { recursive: true })
}

async function restoreFile(relative: string, fixtureRoot: string) {
  const source = join(sourceRoot, relative)
  const destination = join(fixtureRoot, relative)
  const clone = spawnSync('cp', ['-c', source, destination], { encoding: 'utf8' })
  if (clone.status !== 0) await copyFile(source, destination)
}

describe('RC.4 runtime acquisition lock', () => {
  it('pins the one accepted workflow run and all GitHub artifact identities', async () => {
    const { lock, sha256 } = await loadRuntimeAcquisitionLock()
    expect(sha256).toBe(RUNTIME_ACQUISITION_LOCK_SHA256)
    expect(lock).toMatchObject({
      workflow: {
        runId: 31982987064,
        headCommit: 'e4d6af700de7ddf870bbba96f76e8f3b5d73fe8e',
        acceptOnlyThisRun: true,
      },
      candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
      harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
      artifacts: {
        native: { github: { id: 9272949306, archiveDigest: `sha256:${'c34d98f67e13b371cd2666245d44ce418e94ed25186a92b4c2d8115e75a57a48'}` } },
        'v0.4-contract': { github: { id: 9272954825, archiveDigest: `sha256:${'c1e4aa5031b524446095fd380b7d51a5857c2685e5c7dcafd4aa8443acb87c8e'}` } },
        'v0.4-lattice': { github: { id: 9272955682, archiveDigest: `sha256:${'95665562ebeb6b60152045c67f9f21258b722f0355d8edf83de5cf0618dde599'}` } },
      },
    })
  })

  it('rejects artifact provenance drift, an arm swap, and the RC.3 candidate', async () => {
    const { lock } = await loadRuntimeAcquisitionLock()
    const mutations = [
      (copy: any) => { copy.workflow.runId += 1 },
      (copy: any) => { copy.artifacts.native.github.id += 1 },
      (copy: any) => { copy.artifacts.native.github.archiveDigest = `sha256:${'0'.repeat(64)}` },
      (copy: any) => { copy.artifacts['v0.4-contract'].arm = structuredClone(copy.artifacts['v0.4-lattice'].arm) },
      (copy: any) => { copy.candidateCommit = rc3Commit },
      (copy: any) => { copy.artifacts['v0.4-contract'].pluginPackageDigest = '0'.repeat(64) },
    ]
    for (const mutate of mutations) {
      const copy = structuredClone(lock)
      mutate(copy)
      expect(() => validateRuntimeAcquisitionLock(copy)).toThrow()
    }
  })

  it('rejects a self-consistent-looking edited lock file before reading artifacts', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'plan-lattice-rc4-lock-'))
    const path = join(temp, 'runtime-acquisition.lock.json')
    try {
      const { lock } = await loadRuntimeAcquisitionLock()
      lock.artifacts.native.files['runtime.json'] = '0'.repeat(64)
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
      await expect(loadRuntimeAcquisitionLock(path)).rejects.toThrow('lock digest mismatch')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})

describe.runIf(existsSync(sourceRoot))('RC.4 downloaded runtime acquisition', () => {
  let tempRoot: string
  let fixtureRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'plan-lattice-rc4-runtime-'))
    fixtureRoot = join(tempRoot, 'runtime-build-31982987064')
    await cloneTree(sourceRoot, fixtureRoot)
  }, 120_000)

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('verifies the complete temporary copy, including both embedded plugin packages', async () => {
    const result = await verifyRuntimeAcquisition(fixtureRoot)
    expect(result).toMatchObject({
      workflowRunId: 31982987064,
      workflowCommit: 'e4d6af700de7ddf870bbba96f76e8f3b5d73fe8e',
      candidateCommit: '7cb3c77f9dab6ef193eb77318fb87389b877b526',
      artifacts: [
        { id: 'native', pluginPackageDigest: null, arm: { id: 'native', plugin: 'none' } },
        {
          id: 'v0.4-contract',
          pluginPackageDigest: 'adcf51cea9672fe21fc3e832fefec0412c558dfaeaa0d761b4d415d8dd2087d5',
          arm: { id: 'v0.4-contract', controlCeiling: 'contract' },
        },
        {
          id: 'v0.4-lattice',
          pluginPackageDigest: 'adcf51cea9672fe21fc3e832fefec0412c558dfaeaa0d761b4d415d8dd2087d5',
          arm: { id: 'v0.4-lattice', controlCeiling: 'lattice' },
        },
      ],
    })
  }, 120_000)

  it('rejects extra root entries and extra downloaded artifact files', async () => {
    const rootExtra = join(fixtureRoot, 'unexpected.txt')
    await writeFile(rootExtra, 'not part of the acquisition\n', 'utf8')
    await expect(verifyRuntimeAcquisition(fixtureRoot)).rejects.toThrow('runtime acquisition root entry set changed')
    await unlink(rootExtra)

    const artifactExtra = join(
      fixtureRoot,
      'plan-lattice-linux-native-arm64-7cb3c77f9dab6ef193eb77318fb87389b877b526',
      'unexpected.txt',
    )
    await writeFile(artifactExtra, 'not part of the artifact\n', 'utf8')
    await expect(verifyRuntimeAcquisition(fixtureRoot)).rejects.toThrow('downloaded artifact entry set changed')
    await unlink(artifactExtra)
  }, 120_000)

  it('rejects archive checksum, build result, archive bytes, and metadata tampering', async () => {
    const native = 'plan-lattice-linux-native-arm64-7cb3c77f9dab6ef193eb77318fb87389b877b526'
    const cases: Array<{ relative: string; mutate: (path: string) => Promise<void> }> = [
      {
        relative: join(native, 'archive.sha256'),
        mutate: path => writeFile(path, `${'0'.repeat(64)}  /tmp/changed.tgz\n`, 'utf8'),
      },
      {
        relative: join(native, 'build-result.json'),
        mutate: async path => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.harnessCommit = '0'.repeat(40)
          await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
        },
      },
      {
        relative: join(native, 'plan-lattice-linux-native-arm64.tgz'),
        mutate: path => appendFile(path, Buffer.from([0])),
      },
      {
        relative: join(native, 'runtime.json'),
        mutate: async path => {
          const value = JSON.parse(await readFile(path, 'utf8'))
          value.harnessCommit = '0'.repeat(40)
          await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
        },
      },
    ]
    for (const testCase of cases) {
      const path = join(fixtureRoot, testCase.relative)
      try {
        await testCase.mutate(path)
        await expect(verifyRuntimeAcquisition(fixtureRoot)).rejects.toThrow('digest mismatch')
      } finally {
        await restoreFile(testCase.relative, fixtureRoot)
      }
    }
  }, 120_000)

  it('rejects a copied lattice arm in the contract slot and RC.3 plugin metadata', async () => {
    const contract = 'plan-lattice-linux-v0.4-contract-arm64-7cb3c77f9dab6ef193eb77318fb87389b877b526'
    const lattice = 'plan-lattice-linux-v0.4-lattice-arm64-7cb3c77f9dab6ef193eb77318fb87389b877b526'
    const contractRuntime = join(contract, 'runtime.json')
    try {
      await copyFile(join(fixtureRoot, lattice, 'runtime.json'), join(fixtureRoot, contractRuntime))
      await expect(verifyRuntimeAcquisition(fixtureRoot)).rejects.toThrow('runtime.json digest mismatch')
    } finally {
      await restoreFile(contractRuntime, fixtureRoot)
    }

    try {
      const path = join(fixtureRoot, contractRuntime)
      const metadata = JSON.parse(await readFile(path, 'utf8'))
      metadata.pluginCommit = rc3Commit
      await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      await expect(verifyRuntimeAcquisition(fixtureRoot)).rejects.toThrow('runtime.json digest mismatch')
    } finally {
      await restoreFile(contractRuntime, fixtureRoot)
    }
  }, 120_000)
})
