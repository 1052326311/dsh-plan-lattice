export function buildRunSpec({
  run,
  envelope,
  studySpec,
  executionFreezeCommit,
  benchmarkLock,
  simpleTasks,
  benchmarkRoots,
  expectedProvenance,
  attemptDir,
}) {
  const simpleTask = run.suite === 'simple'
    ? simpleTasks.tasks.find(task => task.id === run.taskId)
    : undefined
  if (run.suite === 'simple' && !simpleTask) throw new Error(`simple task is missing from the frozen registry: ${run.taskId}`)
  return {
    schemaVersion: 1,
    protocolId: envelope.runManifest.protocolId,
    candidateCommit: studySpec.candidate.commit,
    manifestDigest: envelope.runManifest.manifestDigest,
    run,
    model: envelope.runManifest.model,
    runtimePolicy: envelope.runManifest.runtimePolicy,
    pluginCommits: envelope.runManifest.pluginCommits,
    sourceLockDigest: envelope.runManifest.sourceLockDigest,
    sourceCommits: envelope.runManifest.sourceCommits,
    benchmarkLock,
    runtimeArtifacts: envelope.runtimeArtifacts,
    routerEvidence: envelope.routerEvidence,
    studyProtocolCommit: envelope.studyProtocolCommit,
    executionFreezeCommit,
    controllerSourceDigest: envelope.controllerSourceDigest,
    executionEnvelopeDigest: envelope.envelopeDigest,
    attemptDir,
    expectedProvenance,
    ...(simpleTask ? { simpleTask } : {}),
    benchmarkRoots,
  }
}
