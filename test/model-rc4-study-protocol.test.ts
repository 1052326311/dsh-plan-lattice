import { describe, expect, it } from 'vitest'
import {
  assertCandidateFreeze,
  assertEvaluationBase,
  assertRouterProtocolFreeze,
  assertRuntimeWorkflowFreeze,
  assertStudyProtocolFreeze,
  loadStudySpec,
  validateStudySpec,
} from '../prospective/model-rc4-study/protocol.mjs'

describe('RC.4 external-model study freeze', () => {
  it('binds the released candidate and unchanged strict evaluation assets', async () => {
    const { spec } = await loadStudySpec()
    expect(assertCandidateFreeze(spec)).toEqual({
      commit: spec.candidate.commit,
      tree: spec.candidate.tree,
    })
    expect(assertEvaluationBase(spec)).toEqual({
      commit: spec.evaluationBase.commit,
      tree: spec.evaluationBase.tree,
      fileCount: 37,
      assetDigest: spec.evaluationBase.assetDigest,
      matrixDigest: spec.evaluationBase.matrixDigest,
    })
    expect(assertRuntimeWorkflowFreeze(spec)).toEqual({
      commit: spec.runtimeBuild.workflowCommit,
      sha256: spec.runtimeBuild.workflowSha256,
      runId: 31982987064,
    })
    expect(assertRouterProtocolFreeze(spec)).toEqual({ commit: spec.routerGate.protocolFreezeCommit })
  })

  it('rejects outcome-dependent changes to candidate, build, model, or gates', async () => {
    const { spec } = await loadStudySpec()
    for (const mutate of [
      (copy: any) => { copy.candidate.commit = '0'.repeat(40) },
      (copy: any) => { copy.runtimeBuild.githubRunId += 1 },
      (copy: any) => { copy.model.temperature = 0.1 },
      (copy: any) => { copy.releaseGates.icae.minimumAbsoluteHiddenFeaturePointGain = 1 },
      (copy: any) => { copy.reportingPolicy.publishFailureWhenAnyGateFails = false },
    ]) {
      const copy = structuredClone(spec)
      mutate(copy)
      expect(() => validateStudySpec(copy)).toThrow()
    }
  })

  it('matches the immutable public study-protocol tag', async () => {
    const { spec } = await loadStudySpec()
    expect(assertStudyProtocolFreeze(spec)).toEqual({
      commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
      ref: spec.studyProtocolFreeze.publicRef,
    })
  })
})
