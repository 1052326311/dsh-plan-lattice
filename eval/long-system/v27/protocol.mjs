import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256 } from '../../v0.4/lib/canonical.mjs'

export const TASK_ID = 'theme_d1_w1_code_build_greenfield_implementation'
export const PRODUCT_ROUNDS = 9

function revisionFor(rounds) {
  const digest = sha256(rounds.map(item => ({ round: item.round, instructionSha256: item.instructionSha256 })))
  return `evocode-jobforge-r${rounds.at(-1).round}-${digest.slice(0, 16)}`
}

export async function readOfficialRounds(taskRoot) {
  const root = resolve(taskRoot)
  const rounds = []
  for (let round = 1; round <= PRODUCT_ROUNDS; round += 1) {
    const instructionPath = join(root, 'steps', `round-${round}`, 'instruction.md')
    const bytes = await readFile(instructionPath)
    const message = bytes.toString('utf8')
    if (message.trim() === '') throw new Error(`round-${round} instruction is empty`)
    rounds.push({ round, message, instructionSha256: sha256(bytes) })
  }
  return rounds
}

export async function buildV27Protocol(taskRoot, rootSessionId) {
  if (typeof rootSessionId !== 'string' || rootSessionId.length < 8) {
    throw new Error('rootSessionId must be a durable non-empty identity')
  }
  const rounds = await readOfficialRounds(taskRoot)
  const stages = []
  for (const item of rounds) {
    const cumulative = rounds.slice(0, item.round)
    const revision = revisionFor(cumulative)
    stages.push({
      index: stages.length,
      id: `round-${item.round}`,
      kind: 'product',
      productRound: item.round,
      message: item.message,
      instructionSha256: item.instructionSha256,
      revision,
      compactAfter: item.round === 3,
    })
    if (item.round === 7) {
      stages.push({
        index: stages.length,
        id: 'audit-after-round-7',
        kind: 'audit',
        revision,
        compactAfter: true,
        message: `Continuity audit only; this message adds no product authority. Use the native subagent_fork tool exactly once in foreground mode. The child prompt must include the exact current revision marker ${revision} and must ask for a read-only audit of the current jobforge implementation against all completed rounds through round 7. The child may inspect already visible session context and source through read-only tools, but it must not call Bash or mutate files. Ask it to identify the most likely historical-regression risk and return concise evidence. Wait for the child result, report it without changing the workspace in this audit stage, and stop.`,
      })
    }
  }
  const epochOne = stages.filter(stage => stage.kind === 'product' && stage.productRound <= 5)
  const epochTwo = stages.filter(stage => stage.kind === 'audit' || stage.productRound >= 6)
  return {
    schemaVersion: 1,
    protocolId: 'plan-lattice-rc7-evocode-jobforge-v27',
    taskId: TASK_ID,
    rootSessionId,
    stages,
    epochs: [
      { schemaVersion: 1, epoch: 1, rootSessionId, stages: epochOne },
      { schemaVersion: 1, epoch: 2, rootSessionId, stages: epochTwo },
    ],
    lifecycle: {
      compactionAfter: ['round-3', 'audit-after-round-7'],
      coldRestartAfter: 'round-5',
      foregroundAudit: 'audit-after-round-7',
    },
  }
}

export function buildV27TraceProtocol(protocol, hiddenAssetsSha256) {
  const auditStages = protocol?.stages?.filter(stage => stage.kind === 'audit') ?? []
  if (auditStages.length !== 1 || protocol?.epochs?.length !== 2
    || typeof hiddenAssetsSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(hiddenAssetsSha256)) {
    throw new Error('V27 trace protocol requires one audit stage, two epochs, and frozen hidden assets')
  }
  const auditStage = auditStages[0]
  const stageIds = protocol.stages.map(stage => stage.id)
  const epochStageIds = protocol.epochs.map(epoch => epoch.stages.map(stage => stage.id))
  if (new Set(stageIds).size !== stageIds.length
    || protocol.stages.some((stage, index) => stage.index !== index)
    || epochStageIds.flat().join('\0') !== stageIds.join('\0')
    || protocol.lifecycle?.coldRestartAfter !== epochStageIds[0].at(-1)
    || protocol.lifecycle?.foregroundAudit !== auditStage.id
    || protocol.lifecycle?.compactionAfter?.join('\0')
      !== protocol.stages.filter(stage => stage.compactAfter === true).map(stage => stage.id).join('\0')) {
    throw new Error('V27 trace protocol requires one exact ordered lifecycle topology')
  }
  const epochByStage = new Map(epochStageIds.flatMap((ids, index) => ids.map(id => [id, index + 1])))
  return {
    schemaVersion: 2,
    protocolId: protocol.protocolId,
    expectedProcessEpochs: protocol.epochs.length,
    expectedCompactions: protocol.lifecycle.compactionAfter.length,
    expectedColdResumes: protocol.epochs.length - 1,
    guardedTools: [],
    hiddenAssetsSha256,
    stages: protocol.stages.map(stage => ({
      id: stage.id,
      index: stage.index,
      kind: stage.kind,
      epoch: epochByStage.get(stage.id),
      messageSha256: sha256(stage.message),
      source: stage.kind === 'product'
        ? { kind: 'user' }
        : { kind: 'plugin', plugin: 'plan-lattice-v27-eval-support' },
    })),
    epochs: protocol.epochs.map((epoch, index) => ({
      epochId: `epoch-${index + 1}`,
      stageIds: epoch.stages.map(stage => stage.id),
      coldStart: index > 0,
      ...(index > 0 ? { resumedAfterStageId: protocol.epochs[index - 1].stages.at(-1).id } : {}),
    })),
    lifecycle: {
      compactionAfterStageIds: [...protocol.lifecycle.compactionAfter],
      coldRestartAfterStageId: protocol.lifecycle.coldRestartAfter,
      foregroundAuditStageId: protocol.lifecycle.foregroundAudit,
    },
    foregroundFork: {
      stageId: auditStage.id,
      stageMessageSha256: sha256(auditStage.message),
      stageSource: { kind: 'plugin', plugin: 'plan-lattice-v27-eval-support' },
      revisionId: auditStage.revision,
      toolName: 'subagent_fork',
      requiredFragments: [],
      requiredAuthorityMessages: protocol.stages
        .filter(stage => stage.kind === 'product' && stage.productRound <= 7)
        .map(stage => stage.message),
    },
  }
}
