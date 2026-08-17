import { randomUUID } from 'node:crypto'
import { access, link, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export class RevealPersistenceCrash extends Error {
  constructor(boundary) {
    super(`simulated hard crash after ${boundary}`)
    this.name = 'RevealPersistenceCrash'
    this.boundary = boundary
  }
}

export class RecordedRevealFailure extends Error {
  constructor(record) {
    super(`recorded reveal failure: ${record?.message ?? 'unknown failure'}`)
    this.name = 'RecordedRevealFailure'
    this.record = record
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function exists(path) {
  return access(path).then(() => true, () => false)
}

async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function checkpoint(options, boundary) {
  options?.onBoundary?.(boundary)
  if (options?.faultAt === boundary) throw new RevealPersistenceCrash(boundary)
}

function preparationName(path, kind, pid) {
  return `.${basename(path)}.${kind}-${pid}-${randomUUID()}`
}

function preparationPid(name, prefix) {
  const match = name.startsWith(prefix) ? name.slice(prefix.length).match(/^(\d+)-/u) : null
  return match === null ? null : Number(match[1])
}

async function removeDeadPreparations(parent, prefix) {
  let changed = false
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const pid = preparationPid(entry.name, prefix)
    if (pid === null || processAlive(pid)) continue
    await rm(join(parent, entry.name), { recursive: true, force: true })
    changed = true
  }
  if (changed) await syncDirectory(parent)
}

async function preparationEntries(path, kind) {
  const parent = dirname(path)
  const prefix = `.${basename(path)}.${kind}-`
  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isFile() && preparationPid(entry.name, prefix) !== null)
    .map(entry => ({ path: join(parent, entry.name), pid: preparationPid(entry.name, prefix) }))
}

async function recoverDeadArtifactPreparation(path) {
  const dead = (await preparationEntries(path, 'prepare')).filter(entry => !processAlive(entry.pid))
  if (dead.length === 0) return
  const bodies = await Promise.all(dead.map(entry => readFile(entry.path)))
  for (const body of bodies.slice(1)) exactBytes(body, bodies[0], `${path} abandoned staging`)
  const preparedPath = `${path}.prepared`
  const existing = (await readOptional(path)) ?? (await readOptional(preparedPath))
  if (existing === null) {
    try {
      await link(dead[0].path, preparedPath)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      exactBytes(await readFile(preparedPath), bodies[0], preparedPath)
    }
    await syncDirectory(dirname(path))
  } else {
    exactBytes(bodies[0], existing, `${path} abandoned staging`)
  }
  for (const entry of dead) await unlink(entry.path).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
  await syncDirectory(dirname(path))
}

async function writeDurable(path, body) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readOptional(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function exactBytes(actual, expected, context) {
  if (!actual.equals(expected)) throw new Error(`${context} differs from the committed reveal state`)
}

function executionRecord(attemptDigest) {
  return {
    schemaVersion: 1,
    kind: 'single-reveal-execution-started',
    revealAttemptSha256: attemptDigest,
  }
}

export async function readRevealArtifact(path) {
  await recoverDeadArtifactPreparation(path)
  const preparedPath = `${path}.prepared`
  const [committed, prepared] = await Promise.all([readOptional(path), readOptional(preparedPath)])
  if (committed !== null && prepared !== null) exactBytes(prepared, committed, `${path}.prepared`)
  return { path, preparedPath, committed, prepared, bytes: committed ?? prepared }
}

async function prepareArtifact(path, body, label, options) {
  const parent = dirname(path)
  const preparedPath = `${path}.prepared`
  const pid = options?.processId ?? process.pid
  await mkdir(parent, { recursive: true, mode: 0o700 })

  const current = await readRevealArtifact(path)
  if (current.bytes !== null) {
    exactBytes(current.bytes, body, path)
    return current
  }

  const stagingPath = join(parent, preparationName(path, 'prepare', pid))
  const writingPath = join(parent, preparationName(path, 'writing', pid))
  await removeDeadPreparations(parent, `.${basename(path)}.writing-`)
  await writeDurable(writingPath, body)
  await rename(writingPath, stagingPath)
  await syncDirectory(parent)
  checkpoint(options, `${label}:staged`)
  try {
    await link(stagingPath, preparedPath)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    exactBytes(await readFile(preparedPath), body, preparedPath)
  }
  await syncDirectory(parent)
  checkpoint(options, `${label}:prepared`)
  await unlink(stagingPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
  await syncDirectory(parent)
  return readRevealArtifact(path)
}

export async function commitRevealArtifact(path, label, options) {
  const state = await readRevealArtifact(path)
  if (state.committed === null && state.prepared === null) {
    throw new Error(`cannot commit absent reveal artifact ${path}`)
  }
  if (state.committed === null) {
    try {
      await link(state.preparedPath, path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      exactBytes(await readFile(path), state.prepared, path)
    }
    await syncDirectory(dirname(path))
    checkpoint(options, `${label}:committed`)
  }
  await unlink(state.preparedPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
  await syncDirectory(dirname(path))
  checkpoint(options, `${label}:prepared-cleared`)
  return readFile(path)
}

export async function publishRevealArtifact(path, value, label, options) {
  const body = Buffer.from(jsonText(value))
  const state = await prepareArtifact(path, body, label, options)
  exactBytes(state.bytes, body, path)
  return commitRevealArtifact(path, label, options)
}

async function retireDeadLease(lockPath) {
  let owner
  try {
    owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  if (processAlive(owner?.pid)) throw new Error(`reveal is already running in pid ${owner.pid}`)
  const stalePath = `${lockPath}.stale-${randomUUID()}`
  try {
    await rename(lockPath, stalePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await syncDirectory(dirname(lockPath))
  await rm(stalePath, { recursive: true, force: true })
  await syncDirectory(dirname(lockPath))
}

async function acquireLease(attemptPath, options) {
  const parent = dirname(attemptPath)
  const lockPath = `${attemptPath}.lock`
  const pid = options?.processId ?? process.pid
  const prefix = `.${basename(lockPath)}.lease-`
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await removeDeadPreparations(parent, prefix)

  for (let retry = 0; retry < 4; retry += 1) {
    const stagingPath = join(parent, preparationName(lockPath, 'lease', pid))
    await mkdir(stagingPath, { mode: 0o700 })
    const owner = { schemaVersion: 1, kind: 'single-reveal-lease', pid, token: randomUUID() }
    await writeDurable(join(stagingPath, 'owner.json'), Buffer.from(jsonText(owner)))
    await syncDirectory(stagingPath)
    await syncDirectory(parent)
    checkpoint(options, 'lease:prepared')
    try {
      await rename(stagingPath, lockPath)
      await syncDirectory(parent)
      checkpoint(options, 'lease:committed')
      return { lockPath, owner }
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
      await rm(stagingPath, { recursive: true, force: true })
      await retireDeadLease(lockPath)
    }
  }
  throw new Error('unable to acquire the single-reveal lease')
}

async function releaseLease(lease, options) {
  const current = JSON.parse(await readFile(join(lease.lockPath, 'owner.json'), 'utf8'))
  if (current.token !== lease.owner.token) throw new Error('single-reveal lease ownership changed')
  await rm(lease.lockPath, { recursive: true, force: false })
  await syncDirectory(dirname(lease.lockPath))
  checkpoint(options, 'lease:released')
}

async function withRevealLease(attemptPath, options, operation) {
  const lease = await acquireLease(attemptPath, options)
  let thrown
  try {
    return await operation()
  } catch (error) {
    thrown = error
    throw error
  } finally {
    if (!(thrown instanceof RevealPersistenceCrash)) await releaseLease(lease, options)
  }
}

function parseRecord(bytes, context) {
  try {
    return JSON.parse(bytes)
  } catch (error) {
    throw new Error(`${context} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function revealFiles(paths) {
  const [attempt, result, failure] = await Promise.all([
    readRevealArtifact(paths.attemptPath),
    readRevealArtifact(paths.resultPath),
    readRevealArtifact(paths.failurePath),
  ])
  if (result.bytes !== null && failure.bytes !== null) throw new Error('single reveal has both result and failure outcomes')
  if (attempt.bytes === null && result.bytes !== null) throw new Error('single reveal result exists without an attempt')
  return { attempt, result, failure }
}

async function resumeArtifact(state, label, options) {
  if (state.prepared !== null) await commitRevealArtifact(state.path, label, options)
}

export async function runRevealStateMachine({
  paths,
  prepare,
  createAttempt,
  execute,
  createResult,
  createExecutionFailure,
  createPreflightFailure,
  validateResult,
  validateExecutionFailure,
  validatePreflightFailure,
  digest,
  persistence,
}) {
  return withRevealLease(paths.attemptPath, persistence, async () => {
    const executionPath = `${paths.attemptPath}.execution-started.json`
    let files = await revealFiles(paths)
    if (files.attempt.bytes === null && files.failure.bytes !== null) {
      const failure = parseRecord(files.failure.bytes, 'pre-reveal failure')
      validatePreflightFailure(failure)
      await resumeArtifact(files.failure, 'failure', persistence)
      throw new RecordedRevealFailure(failure)
    }

    let context
    try {
      context = await prepare()
    } catch (error) {
      if (files.attempt.bytes !== null || files.result.bytes !== null || files.failure.bytes !== null) throw error
      const failure = createPreflightFailure(error)
      validatePreflightFailure(failure)
      await publishRevealArtifact(paths.failurePath, failure, 'failure', persistence)
      throw error
    }

    const attempt = createAttempt(context)
    const attemptBody = Buffer.from(jsonText(attempt))
    if (files.attempt.bytes === null) {
      if (files.result.bytes !== null || files.failure.bytes !== null) throw new Error('single reveal outcome exists before its attempt')
      await publishRevealArtifact(paths.attemptPath, attempt, 'attempt', persistence)
    } else {
      exactBytes(files.attempt.bytes, attemptBody, paths.attemptPath)
      await resumeArtifact(files.attempt, 'attempt', persistence)
    }
    const attemptDigest = digest(attemptBody)

    files = await revealFiles(paths)
    if (files.result.bytes !== null) {
      const result = parseRecord(files.result.bytes, 'reveal result')
      validateResult(result, context, attemptDigest)
      await resumeArtifact(files.result, 'result', persistence)
      return result
    }
    if (files.failure.bytes !== null) {
      const failure = parseRecord(files.failure.bytes, 'reveal failure')
      validateExecutionFailure(failure, context, attemptDigest)
      await resumeArtifact(files.failure, 'failure', persistence)
      throw new RecordedRevealFailure(failure)
    }

    const expectedExecution = executionRecord(attemptDigest)
    const expectedExecutionBody = Buffer.from(jsonText(expectedExecution))
    const executionState = await readRevealArtifact(executionPath)
    if (executionState.bytes !== null) {
      exactBytes(executionState.bytes, expectedExecutionBody, executionPath)
      await resumeArtifact(executionState, 'execution', persistence)
      const interruption = new Error('reveal process terminated after durable execution start and before immutable outcome')
      const failure = createExecutionFailure(interruption, context, attemptDigest)
      validateExecutionFailure(failure, context, attemptDigest)
      await publishRevealArtifact(paths.failurePath, failure, 'failure', persistence)
      throw new RecordedRevealFailure(failure)
    }
    await publishRevealArtifact(executionPath, expectedExecution, 'execution', persistence)
    checkpoint(persistence, 'execute:before-call')

    let outcome
    try {
      outcome = await execute(context)
    } catch (error) {
      if (error instanceof RevealPersistenceCrash) throw error
      const failure = createExecutionFailure(error, context, attemptDigest)
      validateExecutionFailure(failure, context, attemptDigest)
      await publishRevealArtifact(paths.failurePath, failure, 'failure', persistence)
      throw error
    }
    checkpoint(persistence, 'execute:returned')
    const result = createResult(outcome, context, attemptDigest)
    validateResult(result, context, attemptDigest)
    await publishRevealArtifact(paths.resultPath, result, 'result', persistence)
    return result
  })
}
