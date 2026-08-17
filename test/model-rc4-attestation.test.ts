import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../eval/v0.4/lib/canonical.mjs'
import {
  buildPublicFreezeAnchor,
  RC4_PUBLIC_ATTESTATION,
  verifyPublicFreezeAnchor,
  verifyPublicFreezeAttestation,
} from '../prospective/model-rc4-study/attestation.mjs'
import { loadStudySpec } from '../prospective/model-rc4-study/protocol.mjs'

const roots: string[] = []
const hex = (character: string, length = 40) => character.repeat(length)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function github(kind: 'study' | 'execution', sha: string) {
  const record = RC4_PUBLIC_ATTESTATION[kind]
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: RC4_PUBLIC_ATTESTATION.repository,
    GITHUB_REF: record.ref,
    GITHUB_REF_NAME: record.tag,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '31990000000',
    GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: `${RC4_PUBLIC_ATTESTATION.repository}/${RC4_PUBLIC_ATTESTATION.workflowPath}@${record.ref}`,
    RUNNER_ENVIRONMENT: 'github-hosted',
  }
}

async function fixture() {
  const { spec } = await loadStudySpec()
  const studyCommit = hex('1')
  const studyTree = hex('2')
  const executionCommit = hex('3')
  const executionTree = hex('4')
  const workflow = Buffer.from('name: frozen-attestation-workflow\n')
  const envelope = {
    candidateCommit: spec.candidate.commit,
    envelopeDigest: hex('6', 64),
    signingLedgerId: 'plan-lattice-rc4-public-ledger',
    runManifest: { manifestDigest: hex('7', 64) },
    routerEvidence: {
      v13OutcomeSha256: hex('8', 64),
      v14AttemptSha256: hex('9', 64),
      v14ResultSha256: hex('a', 64),
      recomputedRowsSha256: hex('b', 64),
    },
  }
  const git = (args: string[], options: { binary?: boolean } = {}) => {
    const key = args.join(' ')
    const text = (() => {
      if (key === `rev-parse ${spec.studyProtocolFreeze.publicRef}`) return studyCommit
      if (key === `rev-parse ${spec.studyProtocolFreeze.publicRef}^{commit}`) return studyCommit
      if (key === `rev-parse ${studyCommit}^{tree}`) return studyTree
      if (key === `rev-parse ${spec.executionFreeze.futurePublicRef}`) return executionCommit
      if (key === `rev-parse ${spec.executionFreeze.futurePublicRef}^{commit}`) return executionCommit
      if (key === `rev-parse ${executionCommit}^{tree}`) return executionTree
      if (key === `show ${studyCommit}:${RC4_PUBLIC_ATTESTATION.workflowPath}`) return workflow
      if (key === `show ${executionCommit}:${RC4_PUBLIC_ATTESTATION.workflowPath}`) return workflow
      if (key === `show ${executionCommit}:${spec.executionFreeze.evidencePath}`) return Buffer.from(canonicalJson(envelope))
      if (key === `merge-base --is-ancestor ${studyCommit} ${executionCommit}`) return ''
      throw new Error(`unexpected git call: ${key}`)
    })()
    if (options.binary) return Buffer.isBuffer(text) ? text : Buffer.from(text)
    return Buffer.isBuffer(text) ? text.toString('utf8') : `${text}\n`
  }
  const dependencies = {
    loadStudySpec: async () => ({ spec }),
    git,
    studySourceDigest: () => ({ commit: studyCommit, files: ['a', 'b'], digest: hex('5', 64) }),
    verifyExecutionEnvelope: () => envelope,
    assertExecutionFreeze: () => ({ studyCommit, executionCommit }),
  }
  return { dependencies, envelope, executionCommit, spec, studyCommit }
}

describe('RC.4 public freeze anchors', () => {
  it('binds the study tag, protected source, workflow, and first GitHub-hosted run', async () => {
    const current = await fixture()
    const anchor = await buildPublicFreezeAnchor('study', {
      environment: github('study', current.studyCommit),
    }, current.dependencies)
    expect(anchor).toMatchObject({
      kind: 'study',
      source: { commit: current.studyCommit },
      studyFreeze: { protectedSourceDigest: hex('5', 64), protectedSourceFileCount: 2 },
      rawEvidence: { status: 'not-revealed-at-study-freeze', v13: null, v14: null },
      github: { runAttempt: 1, runnerEnvironment: 'github-hosted' },
    })
    await expect(verifyPublicFreezeAnchor(anchor, current.dependencies)).resolves.toMatchObject({
      kind: 'study',
      sourceCommit: current.studyCommit,
    })
    await expect(buildPublicFreezeAnchor('study', {
      environment: { ...github('study', current.studyCommit), GITHUB_RUN_ATTEMPT: '2' },
    }, current.dependencies)).rejects.toThrow('first workflow attempt')
  })

  it('publishes exact V13/V14 raw commitments and rejects a synchronized summary rewrite', async () => {
    const current = await fixture()
    const anchor = await buildPublicFreezeAnchor('execution', {
      environment: github('execution', current.executionCommit),
    }, current.dependencies)
    expect(anchor.rawEvidence).toMatchObject({
      status: 'immutable-v13-v14-commitments',
      v13: { outcomeSha256: hex('8', 64) },
      v14: {
        attemptSha256: hex('9', 64),
        resultSha256: hex('a', 64),
        recomputedRowsSha256: hex('b', 64),
      },
    })
    const tampered = structuredClone(anchor)
    tampered.rawEvidence.v14.resultSha256 = hex('f', 64)
    await expect(verifyPublicFreezeAnchor(tampered, current.dependencies)).rejects.toThrow('raw V13/V14 evidence commitments')
  })

  it('requires GitHub signer identity, source ref/digest, hosted runner policy, and a transparency witness', async () => {
    const current = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-attestation-'))
    roots.push(root)
    const anchorPath = join(root, 'anchor.json')
    const bundlePath = join(root, 'bundle.jsonl')
    const anchor = await buildPublicFreezeAnchor('study', {
      environment: github('study', current.studyCommit),
    }, current.dependencies)
    await writeFile(anchorPath, canonicalJson(anchor))
    await writeFile(bundlePath, '{"bundle":true}\n')
    let invocation: string[] = []
    const verified = await verifyPublicFreezeAttestation({ kind: 'study', anchorPath, bundlePath }, {
      ...current.dependencies,
      spawnSync: (_command: string, args: string[]) => {
        invocation = args
        return {
          status: 0,
          stdout: JSON.stringify([{
            verificationResult: { verifiedTimestamps: [{ type: 'rekor' }] },
          }]),
        }
      },
    })
    expect(verified).toMatchObject({ attestations: 1, verifiedTimestamps: 1 })
    expect(invocation).toEqual(expect.arrayContaining([
      '--repo', RC4_PUBLIC_ATTESTATION.repository,
      '--signer-workflow', RC4_PUBLIC_ATTESTATION.signerWorkflow,
      '--source-ref', RC4_PUBLIC_ATTESTATION.study.ref,
      '--source-digest', current.studyCommit,
      '--deny-self-hosted-runners',
      '--bundle', await realpath(bundlePath),
    ]))

    await expect(verifyPublicFreezeAttestation({ kind: 'study', anchorPath, bundlePath }, {
      ...current.dependencies,
      spawnSync: () => ({ status: 0, stdout: JSON.stringify([{ verificationResult: { verifiedTimestamps: [] } }]) }),
    })).rejects.toThrow('no transparency-log')
  })

  it('keeps the tag workflow narrowly scoped and free of repository secrets', async () => {
    const workflow = await readFile(resolve('.github/workflows/attest-rc4-freezes.yml'), 'utf8')
    expect(workflow).toContain('model-rc4-study-protocol-freeze-v2')
    expect(workflow).toContain('model-rc4-execution-freeze')
    expect(workflow).toContain('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')
    expect(workflow).toContain('actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661')
    expect(workflow).toContain('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a')
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('attestations: write')
    expect(workflow).toContain('persist-credentials: false')
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).not.toMatch(/secrets\./u)
  })
})
