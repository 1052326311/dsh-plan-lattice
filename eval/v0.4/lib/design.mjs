import { deterministicShuffle, sha256 } from './canonical.mjs'

const ARMS = {
  simple: [
    { id: 'native', plugin: 'none' },
    { id: 'v0.3-always', plugin: 'v0.3.0', activationMode: 'always' },
    { id: 'v0.4-auto', plugin: 'v0.4.0-candidate', activationMode: 'auto' },
  ],
  icae: [
    { id: 'native', plugin: 'none' },
    {
      id: 'v0.4-never',
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'never',
    },
    {
      id: 'v0.4-critical',
      plugin: 'v0.4.0-candidate',
      activationMode: 'auto',
      clarificationPolicy: 'critical',
    },
  ],
  evocode: [
    { id: 'native', plugin: 'none' },
    {
      id: 'v0.4-contract',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'contract',
    },
    {
      id: 'v0.4-lattice',
      plugin: 'v0.4.0-candidate',
      activationMode: 'always',
      clarificationPolicy: 'critical',
      controlCeiling: 'lattice',
    },
  ],
}

function locatorFor(suite, task) {
  if (suite === 'simple') return { registry: 'simple-tasks.json', id: task.id }
  if (suite === 'icae') {
    return {
      repository: task.repoId,
      repositoryKey: task.repositoryKey,
      language: task.language,
      aliasResolution: 'ICAE repo_alias.json at the pinned commit',
    }
  }
  return { harborTaskId: task.id }
}

function makeRun({ phase, suite, task, arm, repetition }) {
  const prefix = phase === 'infrastructure' ? 'infra' : 'stat'
  return {
    runId: `${prefix}-${suite}-${task.id}-${arm.id}-r${repetition}`,
    phase,
    includedInStatistics: phase === 'statistical',
    suite,
    taskId: task.id,
    taskLocator: locatorFor(suite, task),
    arm,
    repetition,
  }
}

export function buildManifest(preregistration, benchmarkLock, simpleTasks, runtimeArtifacts, routerBlindResult, driverDigest) {
  const tasks = {
    simple: simpleTasks.tasks,
    icae: benchmarkLock.sources.icae.selectedTasks,
    evocode: benchmarkLock.sources.evocode.selectedTasks,
  }
  const infrastructureRuns = [
    makeRun({ phase: 'infrastructure', suite: 'simple', task: tasks.simple[0], arm: ARMS.simple[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'simple', task: tasks.simple[0], arm: ARMS.simple[2], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'icae', task: tasks.icae[0], arm: ARMS.icae[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'icae', task: tasks.icae[0], arm: ARMS.icae[2], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'evocode', task: tasks.evocode[0], arm: ARMS.evocode[0], repetition: 0 }),
    makeRun({ phase: 'infrastructure', suite: 'evocode', task: tasks.evocode[0], arm: ARMS.evocode[2], repetition: 0 }),
  ].map((run, index) => ({ ...run, order: index + 1 }))

  const statistical = []
  for (const suite of ['simple', 'icae', 'evocode']) {
    for (const task of tasks[suite]) {
      for (const arm of ARMS[suite]) {
        for (const repetition of [1, 2]) {
          statistical.push(makeRun({ phase: 'statistical', suite, task, arm, repetition }))
        }
      }
    }
  }
  const statisticalRuns = deterministicShuffle(
    statistical,
    preregistration.randomization.seed,
  ).map((run, index) => ({ ...run, order: index + 1 }))

  const manifestCore = {
    schemaVersion: 1,
    protocolId: preregistration.protocolId,
    status: 'frozen-unexecuted',
    model: preregistration.model,
    runtimePolicy: preregistration.runtimePolicy,
    pluginCommits: preregistration.pluginCommits,
    sourceLockDigest: sha256(benchmarkLock),
    runtimeArtifactsDigest: sha256(runtimeArtifacts),
    routerBlindResultDigest: sha256(routerBlindResult),
    driverSourceDigest: driverDigest,
    sourceCommits: Object.fromEntries(
      Object.entries(benchmarkLock.sources).map(([name, source]) => [name, source.commit]),
    ),
    preregistrationDigest: sha256(preregistration),
    randomization: preregistration.randomization,
    infrastructureRuns,
    statisticalRuns,
    counts: {
      infrastructure: infrastructureRuns.length,
      statistical: statisticalRuns.length,
      simple: statisticalRuns.filter((run) => run.suite === 'simple').length,
      icae: statisticalRuns.filter((run) => run.suite === 'icae').length,
      evocode: statisticalRuns.filter((run) => run.suite === 'evocode').length,
    },
  }
  return { ...manifestCore, manifestDigest: sha256(manifestCore) }
}

export { ARMS }
