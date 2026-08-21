import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_DECODER = '@deepseek-ai/dsh-session'
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const CONTROL_TOOLS = new Set([
  'todo_write', 'exit_plan_mode', 'lattice_refresh_context', 'lattice_status',
  'lattice_open', 'lattice_checkpoint', 'lattice_complete', 'lattice_reframe',
  'ask_user_question', 'request_user_input',
])
const READ_TOOLS = new Set([
  'read', 'grep', 'glob', 'view', 'web_search', 'web_fetch', 'lsp', 'read_image',
  'skill', 'get_goal', 'job_list', 'job_output', 'terminal_list', 'terminal_read',
  'schedule_list', 'list_agents',
])

function input(condition, message) {
  if (!condition) throw new Error(`V26 trace grader: ${message}`)
}

function addViolation(violations, code, message, details = {}) {
  violations.push({ code, message, ...details })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function walkSessions(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkSessions(path))
    else if (entry.name === 'session.jsonl') files.push(path)
  }
  return files
}

async function loadDecoder(decoderModulePath) {
  const requested = decoderModulePath ?? DEFAULT_DECODER
  input(typeof requested === 'string' && requested.length > 0, 'decoderModulePath must be a non-empty string')
  const specifier = isAbsolute(requested) ? pathToFileURL(requested).href : requested
  const module = await import(specifier)
  input(typeof module.decodeStorageRecord === 'function', `${requested} does not export decodeStorageRecord`)
  return module.decodeStorageRecord
}

function parseJson(line, path, lineNumber) {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`V26 trace grader: ${path} contains invalid JSON on line ${lineNumber}`)
  }
}

async function readSession(path, decodeStorageRecord) {
  const text = await readFile(path, 'utf8')
  input(text.endsWith('\n'), `${path} is not a complete durable JSONL artifact`)
  const lines = text.split(/\r?\n/u)
  lines.pop()
  input(lines.length > 0 && lines.every(line => line.trim() !== ''), `${path} contains an empty JSONL record`)

  const header = parseJson(lines[0], path, 1)
  input(header?.type === 'session' && typeof header.id === 'string' && header.id.length > 0,
    `${path} has no valid Session header`)

  const events = []
  let storageRows = 0
  let packedStorageRows = 0
  for (let index = 1; index < lines.length; index += 1) {
    const row = parseJson(lines[index], path, index + 1)
    const packed = row?.type === 'text-chunks'
      || row?.type === 'reasoning-chunks'
      || row?.type === 'tool-call-chunks'
    let decoded
    try {
      decoded = decodeStorageRecord(row)
    } catch (error) {
      throw new Error(`V26 trace grader: ${path} cannot decode storage row ${index + 1}: ${String(error)}`)
    }
    input(Array.isArray(decoded) && decoded.length > 0,
      `${path} decoder returned no events for storage row ${index + 1}`)
    storageRows += 1
    if (packed) packedStorageRows += 1
    events.push(...decoded)
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    input(isRecord(event)
      && typeof event.type === 'string'
      && Number.isSafeInteger(event.seq)
      && event.seq === index
      && Number.isFinite(event.time)
      && Object.hasOwn(event, 'data'),
    `${path} contains a malformed or non-contiguous decoded event at seq ${index}`)
  }
  const seedLength = header.seedLength ?? 0
  input(Number.isSafeInteger(seedLength) && seedLength >= 0 && seedLength <= events.length,
    `${path} has an invalid seedLength`)
  return { path, header, events, storageRows, packedStorageRows }
}

async function readSessions(root, decoderModulePath) {
  input(typeof root === 'string' && root.length > 0, 'sessionsRoot must be a non-empty string')
  const decodeStorageRecord = await loadDecoder(decoderModulePath)
  const files = await walkSessions(root)
  input(files.length > 0, 'Harness produced no persistent session.jsonl artifact')
  const sessions = await Promise.all(files.map(path => readSession(path, decodeStorageRecord)))
  const ids = new Set()
  for (const session of sessions) {
    input(!ids.has(session.header.id), `persistent sessions contain duplicate Session ${session.header.id}`)
    ids.add(session.header.id)
  }
  return sessions
}

function ownEvents(session) {
  return session.events.slice(session.header.seedLength ?? 0)
}

function messageText(value) {
  const message = value?.message ?? value
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  return message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string'
    ? [block.text]
    : []).join('\n')
}

function toolResultBlock(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return undefined
  return content.find(block => block?.type === 'tool-result')
}

function resultCallId(event) {
  return toolResultBlock(event)?.toolCallId ?? event?.data?.callId
}

function successfulToolResult(event) {
  const block = toolResultBlock(event)
  return event?.data?.error === undefined && block?.isError === false
}

function resultText(event) {
  const block = toolResultBlock(event)
  if (!Array.isArray(block?.content)) return ''
  return block.content.flatMap(item => item?.type === 'text' && typeof item.text === 'string'
    ? [item.text]
    : []).join('\n')
}

function parseArguments(value) {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function commandOf(call) {
  const args = parseArguments(call?.data?.arguments)
  const value = args?.command ?? args?.cmd ?? args?.script
  return typeof value === 'string' ? value.trim() : ''
}

function isVerificationCommand(command) {
  return /(?:^|&&|;)\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test|check|lint|build|typecheck)\b|(?:npm|pnpm|yarn|bun)\s+(?:exec\s+)?(?:pytest|vitest|jest|eslint|tsc|mypy)\b|npx\s+(?:pytest|vitest|jest|eslint|tsc)\b|(?:python\d*|py)\s+-m\s+pytest\b|pytest\b|ruff\s+check\b|tsc(?:\s|$)|node\s+--test\b|deno\s+test\b|go\s+(?:test|vet|build)\b|cargo\s+(?:test|check|build|clippy)\b|dotnet\s+(?:test|build)\b|make\s+(?:test|check|lint|build|typecheck)\b)/iu.test(command)
}

function explicitFailure(text) {
  const cleaned = text
    .replace(/\b0\s+(?:tests?\s+)?(?:failed|failures?)\b/giu, '')
    .replace(/\b(?:fail|failed|failure|failures)\s*[:=]?\s*0\b/giu, '')
  for (const match of cleaned.matchAll(/\bexit(?:ed)?(?:\s+with)?[\s_-]*(?:code|status)\s*[:=]?\s*(-?\d+)\b/giu)) {
    if (Number(match[1]) !== 0) return true
  }
  return /\b(?:fail|failed|failure|failures|timeout|aborted)\b|\btimed\s+out\b|\bnot\s+ok\b/iu.test(cleaned)
}

function toolClass(call, guardedTools) {
  const name = String(call?.data?.name ?? '').trim().toLowerCase()
  if (CONTROL_TOOLS.has(name)) return 'control'
  if (READ_TOOLS.has(name) || name.startsWith('session_') || name.startsWith('cordis_inspect_')) return 'read'
  if (name === 'bash' || name === 'pwsh') return isVerificationCommand(commandOf(call)) ? 'verification' : 'mutation'
  if (name === 'str_replace_editor') {
    return parseArguments(call?.data?.arguments)?.command === 'view' ? 'read' : 'mutation'
  }
  if (guardedTools.has(name)) return 'mutation'
  return 'mutation'
}

function todoShape(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return 'Todo snapshot must contain at least one item'
  const contents = new Set()
  for (const [index, todo] of todos.entries()) {
    if (!isRecord(todo) || typeof todo.content !== 'string' || todo.content.trim() === '') {
      return `Todo item ${index + 1} has no non-empty content`
    }
    if (!TODO_STATUSES.has(todo.status)) return `Todo item ${index + 1} has invalid status ${String(todo.status)}`
    if (contents.has(todo.content)) return `Todo content ${JSON.stringify(todo.content)} is duplicated`
    contents.add(todo.content)
  }
  const active = todos.flatMap((todo, index) => todo.status === 'in_progress' ? [index] : [])
  const allCompleted = todos.every(todo => todo.status === 'completed')
  if (!allCompleted && active.length !== 1) return 'Todo must have exactly one in_progress item unless all items are completed'
  if (!allCompleted) {
    const activeIndex = active[0]
    if (todos.slice(0, activeIndex).some(todo => todo.status !== 'completed')) {
      return 'Todo contains unfinished work before the in_progress item'
    }
    if (todos.slice(activeIndex + 1).some(todo => todo.status !== 'pending')) {
      return 'Todo contains non-pending work after the in_progress item'
    }
  }
  return undefined
}

function sameContents(left, right) {
  return left.length === right.length && left.every((todo, index) => todo.content === right[index]?.content)
}

function gradeTodoFreshness(events, stageProtocol, violations) {
  const guardedTools = new Set(Array.isArray(stageProtocol?.guardedTools)
    ? stageProtocol.guardedTools.map(value => String(value).trim().toLowerCase())
    : [])
  const calls = new Map()
  const evidence = []
  let current
  let activationSeq
  let writes = 0
  let advancements = 0
  let verifiedAdvancements = 0
  let completedTurns = 0
  let prematureTerminals = 0

  for (const event of events) {
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') {
      calls.set(event.data.callId, event)
    }
    if (event.type === 'tool/result') {
      const call = calls.get(resultCallId(event))
      if (call !== undefined) {
        const kind = toolClass(call, guardedTools)
        if (kind === 'mutation') {
          evidence.push({ kind, callSeq: call.seq, resultSeq: event.seq, successful: successfulToolResult(event) })
        } else if (kind === 'verification' && successfulToolResult(event) && !explicitFailure(resultText(event))) {
          evidence.push({ kind, callSeq: call.seq, resultSeq: event.seq, successful: true })
        }
      }
    }
    if (event.type === 'todo/write') {
      writes += 1
      const todos = event.data?.todos
      const shapeError = todoShape(todos)
      if (shapeError !== undefined) {
        addViolation(violations, 'TODO_INVALID_SNAPSHOT', shapeError, { seq: event.seq })
        current = Array.isArray(todos) ? todos : []
        activationSeq = undefined
        continue
      }

      if (current === undefined || current.every(todo => todo.status === 'completed')) {
        if (todos.every(todo => todo.status === 'completed')) {
          addViolation(violations, 'TODO_INITIAL_COMPLETED', 'A fresh Todo snapshot cannot begin fully completed', { seq: event.seq })
        }
        current = todos
        activationSeq = todos.some(todo => todo.status === 'in_progress') ? event.seq : undefined
        continue
      }

      if (!sameContents(current, todos)) {
        addViolation(violations, 'TODO_REPLAN_WITH_UNFINISHED_WORK',
          'Todo content or order changed before the prior snapshot was completed', { seq: event.seq })
        current = todos
        activationSeq = todos.some(todo => todo.status === 'in_progress') ? event.seq : undefined
        continue
      }

      const regressed = current.flatMap((todo, index) => todo.status === 'completed' && todos[index]?.status !== 'completed'
        ? [index]
        : [])
      if (regressed.length > 0) {
        addViolation(violations, 'TODO_COMPLETED_REVIVED', 'Completed Todo items cannot become active or pending again', {
          seq: event.seq, indices: regressed,
        })
      }
      const priorActive = current.findIndex(todo => todo.status === 'in_progress')
      const newlyCompleted = current.flatMap((todo, index) => todo.status !== 'completed' && todos[index]?.status === 'completed'
        ? [index]
        : [])
      if (newlyCompleted.length > 1) {
        addViolation(violations, 'TODO_BATCH_ADVANCE', 'One todo/write completed more than one unfinished item', {
          seq: event.seq, indices: newlyCompleted,
        })
      }
      if (newlyCompleted.some(index => index !== priorActive)) {
        addViolation(violations, 'TODO_SKIPPED_ITEM', 'Only the previously in_progress Todo item may become completed', {
          seq: event.seq, indices: newlyCompleted, priorActive,
        })
      }

      const completedActive = newlyCompleted.length === 1 && newlyCompleted[0] === priorActive
      if (completedActive) {
        advancements += 1
        const sinceActivation = evidence.filter(item => activationSeq !== undefined
          && item.callSeq > activationSeq && item.resultSeq < event.seq)
        const mutations = sinceActivation.filter(item => item.kind === 'mutation')
        if (mutations.length > 0) {
          const lastMutation = mutations.at(-1)
          const verified = sinceActivation.some(item => item.kind === 'verification'
            && item.callSeq > lastMutation.resultSeq && item.resultSeq < event.seq)
          if (!verified) {
            addViolation(violations, 'TODO_ADVANCED_WITHOUT_VERIFICATION',
              'Todo advanced after mutation without a later successful verification', {
                seq: event.seq, activationSeq, lastMutationResultSeq: lastMutation.resultSeq,
              })
          } else {
            verifiedAdvancements += 1
          }
        } else {
          verifiedAdvancements += 1
        }
      }

      const newActive = todos.findIndex(todo => todo.status === 'in_progress')
      if (newActive >= 0 && (newActive !== priorActive || current[priorActive]?.status !== 'in_progress')) {
        activationSeq = event.seq
      }
      current = todos
    }

    if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
      completedTurns += 1
      const unresolved = current === undefined || current.some(todo => todo.status !== 'completed')
      if (unresolved) {
        prematureTerminals += 1
        addViolation(violations, 'PREMATURE_TERMINAL',
          current === undefined
            ? 'A turn completed before any durable Todo snapshot existed'
            : 'A turn completed while its durable Todo snapshot still contained unfinished work',
        { seq: event.seq, turn: event.data?.turn })
      }
    }
  }

  if (writes === 0) addViolation(violations, 'TODO_MISSING', 'The root Session contains no durable todo/write event')
  return {
    valid: !violations.some(item => item.code.startsWith('TODO_')),
    writes,
    advancements,
    verifiedAdvancements,
    finalStatuses: current?.map(todo => todo.status) ?? [],
    completedTurns,
    prematureTerminals,
  }
}

function sameOwner(left, right) {
  return left?.compactionId === right?.compactionId
    && (left?.sourceCommandId ?? null) === (right?.sourceCommandId ?? null)
}

function replacementMatches(start, summary, replacement) {
  const data = replacement?.data
  const source = data?.source
  const op = replacement?.surfaceOp
  const sourceSeqs = replacement?.sourceEventSeqs
  return replacement?.type === 'user/message'
    && source?.kind === 'plugin'
    && source?.plugin === 'compact'
    && source?.compactionId === start.data.compactionId
    && op?.op === 'replace'
    && op.start === summary.data?.shadowedRange?.start
    && op.end === summary.data?.shadowedRange?.end
    && Array.isArray(sourceSeqs)
    && sourceSeqs.includes(start.seq)
    && sourceSeqs.includes(summary.seq)
    && Array.isArray(summary.data?.shadowedSeqs)
    && summary.data.shadowedSeqs.every(seq => sourceSeqs.includes(seq))
    && JSON.stringify(data?.content) === JSON.stringify(summary.data?.summary)
}

function gradeCompactions(events, stageProtocol, violations) {
  const expected = stageProtocol?.expectedCompactions
    ?? (Array.isArray(stageProtocol?.compactions) ? stageProtocol.compactions.length : 2)
  input(Number.isSafeInteger(expected) && expected >= 0, 'stageProtocol.expectedCompactions must be a non-negative integer')
  const successful = []
  const attempts = []
  let open

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'session/end-seed' && open !== undefined) {
      addViolation(violations, 'COMPACTION_CROSSED_LIFECYCLE',
        'An unmatched compaction/start belongs to an ended process lifecycle', {
          compactionId: open.start.data.compactionId, startSeq: open.start.seq, seedEndSeq: event.seq,
        })
      attempts.push({ id: open.start.data.compactionId, startSeq: open.start.seq, successful: false })
      open = undefined
      continue
    }
    if (event.type === 'compaction/start') {
      if (open !== undefined) {
        addViolation(violations, 'COMPACTION_NESTED', 'A compaction started before the prior bracket ended', {
          compactionId: event.data?.compactionId, seq: event.seq,
        })
      }
      open = { start: event }
      continue
    }
    if (event.type === 'compaction/summary') {
      if (open === undefined || !sameOwner(open.start.data, event.data) || open.summary !== undefined) {
        addViolation(violations, 'COMPACTION_ORPHAN_SUMMARY',
          'compaction/summary has no unique matching open bracket', { compactionId: event.data?.compactionId, seq: event.seq })
        continue
      }
      open.summary = event
      const replacement = events[index + 1]
      if (!replacementMatches(open.start, event, replacement)) {
        addViolation(violations, 'COMPACTION_INVALID_REPLACEMENT',
          'A compaction summary must be immediately followed by its exact correlated surface replacement', {
            compactionId: event.data.compactionId, summarySeq: event.seq,
          })
      } else {
        open.replacement = replacement
      }
      continue
    }
    if (event.type === 'compaction/end') {
      if (open === undefined || !sameOwner(open.start.data, event.data)
        || open.start.data?.turn !== event.data?.turn) {
        addViolation(violations, 'COMPACTION_ORPHAN_END',
          'compaction/end does not match an open bracket and owner', { compactionId: event.data?.compactionId, seq: event.seq })
        continue
      }
      const complete = open.summary !== undefined
        && open.replacement !== undefined
        && event.seq > open.replacement.seq
        && event.data?.error === undefined
      const record = {
        id: event.data.compactionId,
        startSeq: open.start.seq,
        summarySeq: open.summary?.seq ?? null,
        replacementSeq: open.replacement?.seq ?? null,
        endSeq: event.seq,
        successful: complete,
      }
      attempts.push(record)
      if (complete) successful.push(record)
      else addViolation(violations, 'COMPACTION_UNSUCCESSFUL',
        'Compaction bracket did not contain a successful summary, replacement, and error-free end', record)
      open = undefined
    }
  }
  if (open !== undefined) {
    addViolation(violations, 'COMPACTION_UNCLOSED', 'The final compaction/start has no matching end', {
      compactionId: open.start.data?.compactionId, startSeq: open.start.seq,
    })
  }
  if (successful.length !== expected) {
    addViolation(violations, 'COMPACTION_COUNT_MISMATCH',
      `Expected ${expected} successful compactions but found ${successful.length}`, {
        expected, actual: successful.length,
      })
  }
  return { valid: successful.length === expected && !violations.some(item => item.code.startsWith('COMPACTION_')), expected, successful, attempts }
}

function normalizedEpochs(processLedger) {
  const rows = Array.isArray(processLedger) ? processLedger : processLedger?.epochs
  input(Array.isArray(rows), 'processLedger must be an array or an object with an epochs array')
  return rows.map((row, index) => {
    input(isRecord(row), `processLedger epoch ${index + 1} must be an object`)
    const epochId = row.epochId ?? row.epoch ?? row.id
    const processId = row.processId ?? row.pid
    const sessionId = row.sessionId ?? row.rootSessionId
    const firstSeq = row.firstSeq ?? row.startSeq
    const lastSeq = row.lastSeq ?? row.endSeq
    input(typeof epochId === 'string' && epochId.length > 0, `processLedger epoch ${index + 1} has no epoch id`)
    input((typeof processId === 'string' && processId.length > 0) || Number.isSafeInteger(processId),
      `processLedger epoch ${index + 1} has no process identity`)
    input(typeof sessionId === 'string' && sessionId.length > 0, `processLedger epoch ${index + 1} has no Session id`)
    input(Number.isSafeInteger(firstSeq) && firstSeq >= 0 && Number.isSafeInteger(lastSeq) && lastSeq >= firstSeq,
      `processLedger epoch ${index + 1} has an invalid event range`)
    return {
      epochId, processId: String(processId), sessionId, firstSeq, lastSeq,
      ended: row.ended === true || row.stopped === true || isRecord(row.exit),
      coldStart: row.coldStart === true,
      resumedFrom: row.resumedFromEpochId ?? row.resumedFrom,
    }
  })
}

function gradeColdResume(events, rootSessionId, processLedger, stageProtocol, violations) {
  const expected = stageProtocol?.expectedColdResumes ?? 1
  input(Number.isSafeInteger(expected) && expected >= 0, 'stageProtocol.expectedColdResumes must be a non-negative integer')
  const epochs = normalizedEpochs(processLedger)
  const proven = []

  for (let index = 1; index < epochs.length; index += 1) {
    const prior = epochs[index - 1]
    const current = epochs[index]
    if (prior.sessionId !== rootSessionId || current.sessionId !== rootSessionId) continue
    if (prior.processId === current.processId || prior.lastSeq >= current.firstSeq) continue
    if (!prior.ended || !current.coldStart || current.resumedFrom !== prior.epochId) continue
    const inEpoch = events.filter(event => event.seq >= current.firstSeq && event.seq <= current.lastSeq)
    const seed = inEpoch.find(event => event.type === 'session/end-seed')
    const resume = inEpoch.find(event => event.type === 'request/header'
      && event.data?.reason === 'resume' && (seed === undefined || event.seq > seed.seq))
    const liveTurn = inEpoch.find(event => event.type === 'turn/start'
      && (seed === undefined || event.seq > seed.seq))
    if (seed === undefined || resume === undefined || liveTurn === undefined) continue
    proven.push({
      fromEpoch: prior.epochId,
      toEpoch: current.epochId,
      fromProcess: prior.processId,
      toProcess: current.processId,
      seedEndSeq: seed.seq,
      resumeHeaderSeq: resume.seq,
      liveTurnSeq: liveTurn.seq,
    })
  }
  if (proven.length !== expected) {
    addViolation(violations, 'COLD_RESUME_NOT_PROVEN',
      `Expected ${expected} same-Session cold resumes but proved ${proven.length} from Session events and the process ledger`, {
        expected, actual: proven.length,
      })
  }
  return { valid: proven.length === expected, expected, proven, epochs }
}

function containsAll(text, fragments) {
  return fragments.every(fragment => text.includes(fragment))
}

function gradeForegroundRevision(sessions, root, stageProtocol, violations) {
  const protocol = stageProtocol?.foregroundFork ?? stageProtocol?.r7ForegroundFork
  input(isRecord(protocol), 'stageProtocol.foregroundFork is required')
  const parentTurn = protocol.parentTurn ?? protocol.turn
  const firstSeq = protocol.firstSeq
  const lastSeq = protocol.lastSeq
  const hasSeqRange = Number.isSafeInteger(firstSeq) && firstSeq >= 0
    && Number.isSafeInteger(lastSeq) && lastSeq >= firstSeq
  const toolName = protocol.toolName ?? 'subagent_fork'
  const revisionId = protocol.revisionId
  const fragments = protocol.requiredFragments ?? protocol.revisionFragments ?? []
  input(hasSeqRange || (Number.isSafeInteger(parentTurn) && parentTurn >= 0),
    'foregroundFork must provide a valid Session seq range or non-negative parentTurn')
  input(typeof toolName === 'string' && toolName.length > 0, 'foregroundFork.toolName must be a non-empty string')
  input(typeof revisionId === 'string' && revisionId.length > 0, 'foregroundFork.revisionId must be a non-empty string')
  input(Array.isArray(fragments) && fragments.every(value => typeof value === 'string' && value.length > 0),
    'foregroundFork.requiredFragments must be an array of non-empty strings')
  const required = [...new Set([revisionId, ...fragments])]

  const allCalls = root.events.filter(event => event.type === 'tool/call' && event.data?.name === toolName)
  if (allCalls.length !== 1) {
    addViolation(violations, 'FOREGROUND_FORK_COUNT', `Expected exactly one ${toolName} call but found ${allCalls.length}`, {
      expected: 1, actual: allCalls.length,
    })
    return { valid: false, revisionId, parentTurn: parentTurn ?? null, childSessionId: null, callSeq: null }
  }
  const call = allCalls[0]
  const effectiveParentTurn = call.data?.turn
  const args = parseArguments(call.data?.arguments)
  if ((hasSeqRange ? (call.seq < firstSeq || call.seq > lastSeq) : call.data?.turn !== parentTurn)
    || args?.run_in_background !== false
    || typeof args?.prompt !== 'string' || typeof args?.description !== 'string') {
    addViolation(violations, 'FOREGROUND_FORK_INVALID',
      'The R7 audit must be a model-authored foreground fork with a prompt and description', {
        seq: call.seq, parentTurn: effectiveParentTurn, firstSeq: firstSeq ?? null, lastSeq: lastSeq ?? null,
      })
  }

  const turnStart = root.events.filter(event => event.type === 'turn/start'
    && event.data?.turn === effectiveParentTurn && event.seq < call.seq).at(-1)
  const revisionEvents = root.events.filter(event => event.type === 'user/message'
    && event.seq < call.seq
    && event.seq >= (hasSeqRange ? firstSeq : (turnStart?.seq ?? -1))
    && containsAll(messageText(event.data), required))
  if (turnStart === undefined || revisionEvents.length === 0) {
    addViolation(violations, 'PARENT_CURRENT_REVISION_MISSING',
      'The current revision was not present in the unfinished R7 parent turn before delegation', {
        callSeq: call.seq, parentTurn: effectiveParentTurn, revisionId,
      })
  }
  if (typeof args?.prompt !== 'string' || !containsAll(args.prompt, required)) {
    addViolation(violations, 'FORK_PROMPT_REVISION_MISSING',
      'The model-authored foreground child prompt omitted the current revision', { callSeq: call.seq, revisionId })
  }

  const results = root.events.filter(event => event.type === 'tool/result'
    && resultCallId(event) === call.data?.callId && event.seq > call.seq)
  if (results.length !== 1 || !successfulToolResult(results[0])) {
    addViolation(violations, 'FOREGROUND_FORK_RESULT_INVALID',
      'The foreground fork has no unique successful root tool/result', { callSeq: call.seq })
  }
  const result = results[0]
  const children = sessions.filter(session => session.header.parentSession === root.header.id
    && session.header.origin === 'subagent'
    && session.header.delegationDepth === 1
    && (() => {
      const first = ownEvents(session).find(event => event.type === 'user/message')
      return first !== undefined && messageText(first.data) === args?.prompt
        && (result === undefined || (first.time >= call.time && first.time <= result.time))
    })())
  if (children.length !== 1) {
    addViolation(violations, 'FOREGROUND_CHILD_NOT_PROVEN',
      'No unique direct child persisted the exact model-authored foreground prompt', { callSeq: call.seq })
    return { valid: false, revisionId, parentTurn: effectiveParentTurn, childSessionId: null, callSeq: call.seq }
  }
  const child = children[0]
  const childBeforeResponse = ownEvents(child).filter(event => {
    const firstResponse = ownEvents(child).find(item => item.type === 'assistant/message')?.seq ?? Number.POSITIVE_INFINITY
    return event.seq < firstResponse && event.type === 'user/message'
  }).map(event => messageText(event.data)).join('\n')
  if (!containsAll(childBeforeResponse, required)) {
    addViolation(violations, 'CHILD_CURRENT_REVISION_MISSING',
      'The foreground child did not receive the current revision before its first response', {
        childSessionId: child.header.id, revisionId,
      })
  }
  const descriptor = ownEvents(child).find(event => event.type === 'subagent/descriptor')
  if (descriptor?.data?.mode !== 'one-shot' || descriptor.data?.provider !== 'fork') {
    addViolation(violations, 'FOREGROUND_CHILD_DESCRIPTOR_INVALID',
      'The direct child lacks a durable one-shot fork descriptor', { childSessionId: child.header.id })
  }
  const terminal = ownEvents(child).filter(event => event.type === 'turn/end').at(-1)
  if (terminal?.data?.reason?.kind !== 'completed') {
    addViolation(violations, 'FOREGROUND_CHILD_INCOMPLETE',
      'The foreground child has no durably completed turn', { childSessionId: child.header.id })
  }
  const nonReadCalls = ownEvents(child).filter(event => event.type === 'tool/call'
    && !READ_TOOLS.has(String(event.data?.name ?? '').trim().toLowerCase()))
  if (nonReadCalls.length > 0) {
    addViolation(violations, 'FOREGROUND_CHILD_NOT_READ_ONLY',
      'The foreground audit child invoked a non-read-only tool', {
        childSessionId: child.header.id,
        calls: nonReadCalls.map(event => ({ seq: event.seq, name: event.data?.name ?? null })),
      })
  }
  const ownViolations = new Set([
    'FOREGROUND_FORK_COUNT', 'FOREGROUND_FORK_INVALID', 'PARENT_CURRENT_REVISION_MISSING',
    'FORK_PROMPT_REVISION_MISSING', 'FOREGROUND_FORK_RESULT_INVALID', 'FOREGROUND_CHILD_NOT_PROVEN',
    'CHILD_CURRENT_REVISION_MISSING', 'FOREGROUND_CHILD_DESCRIPTOR_INVALID', 'FOREGROUND_CHILD_INCOMPLETE',
    'FOREGROUND_CHILD_NOT_READ_ONLY',
  ])
  return {
    valid: !violations.some(item => ownViolations.has(item.code)),
    revisionId,
    parentTurn: effectiveParentTurn,
    childSessionId: child.header.id,
    callSeq: call.seq,
    resultSeq: result?.seq ?? null,
  }
}

function gradeStaleBehavior(productGrade, violations) {
  input(isRecord(productGrade), 'productGrade must be an object produced by the hidden product grader')
  const record = isRecord(productGrade.staleBehavior) ? productGrade.staleBehavior : productGrade
  const hidden = record.hidden === true || record.source === 'hidden' || productGrade.hidden === true
  const failures = record.failures
    ?? record.staleBehaviorFailures
    ?? productGrade.historicalRequirementRegressions
  input(Number.isSafeInteger(failures) && failures >= 0,
    'productGrade must provide a non-negative staleBehavior.failures count')
  if (!hidden) {
    addViolation(violations, 'STALE_BEHAVIOR_NOT_HIDDEN_GRADED',
      'Retired behavior must be judged by the evaluator-owned hidden product grader')
  }
  if (failures > 0 || record.passed === false) {
    addViolation(violations, 'STALE_BEHAVIOR_FAILURE',
      `The hidden product grader found ${failures} stale-behavior failure${failures === 1 ? '' : 's'}`, { failures })
  }
  return { valid: hidden && failures === 0 && record.passed !== false, source: hidden ? 'hidden' : 'untrusted', failures }
}

function gradeHiddenAssetIdentity(productGrade, stageProtocol, violations) {
  const expected = stageProtocol.hiddenAssetsSha256
  input(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected),
    'stageProtocol.hiddenAssetsSha256 must be a SHA256 digest')
  const actual = productGrade.hiddenAssetsSha256
  if (actual !== expected) {
    addViolation(violations, 'HIDDEN_ASSET_IDENTITY_MISMATCH',
      'Product trace verdict does not cite the frozen hidden verifier assets', { expected, actual: actual ?? null })
  }
  return { valid: actual === expected, expected, actual: actual ?? null }
}

/**
 * Independently grade V26 continuity evidence from durable rc.7 Session logs.
 *
 * `stageProtocol` supplies evaluator-owned expectations:
 * `{ expectedCompactions, expectedColdResumes, guardedTools?, foregroundFork:
 * { parentTurn, toolName?, revisionId, requiredFragments } }`.
 *
 * `processLedger` is either an epoch array or `{ epochs }`. Each epoch contains
 * `{ epochId, processId, sessionId, firstSeq, lastSeq, ended?, coldStart?,
 * resumedFromEpochId? }`. The resumed epoch must use a different process id.
 *
 * `productGrade` must expose evaluator-owned stale-behavior results as
 * `{ staleBehavior: { hidden: true, failures, passed? } }`. Product semantics
 * deliberately remain outside this trace grader.
 */
export async function gradeV26Trace({
  sessionsRoot,
  rootSessionId,
  stageProtocol,
  processLedger,
  productGrade,
  decoderModulePath,
}) {
  input(typeof rootSessionId === 'string' && rootSessionId.length > 0, 'rootSessionId must be a non-empty string')
  input(isRecord(stageProtocol), 'stageProtocol must be an object')
  const sessions = await readSessions(sessionsRoot, decoderModulePath)
  const rootMatches = sessions.filter(session => session.header.id === rootSessionId)
  input(rootMatches.length === 1, `expected exactly one root Session ${rootSessionId}`)
  const root = rootMatches[0]
  input(root.header.parentSession === undefined && root.header.origin !== 'subagent',
    `Session ${rootSessionId} is not a root Session`)

  const violations = []
  const todoFreshness = gradeTodoFreshness(root.events, stageProtocol, violations)
  const successfulCompactions = gradeCompactions(root.events, stageProtocol, violations)
  const sameSessionResumes = gradeColdResume(root.events, rootSessionId, processLedger, stageProtocol, violations)
  const childRevisionCoverage = gradeForegroundRevision(sessions, root, stageProtocol, violations)
  const staleBehaviorFailures = gradeStaleBehavior(productGrade, violations)
  const hiddenAssetIdentity = gradeHiddenAssetIdentity(productGrade, stageProtocol, violations)
  const prematureTerminals = {
    valid: todoFreshness.prematureTerminals === 0,
    count: todoFreshness.prematureTerminals,
  }

  return {
    valid: violations.length === 0,
    violations,
    metrics: {
      todoFreshness,
      successfulCompactions,
      sameSessionResumes,
      childRevisionCoverage,
      staleBehaviorFailures,
      hiddenAssetIdentity,
      prematureTerminals,
      storage: {
        sessionCount: sessions.length,
        storageRows: sessions.reduce((sum, session) => sum + session.storageRows, 0),
        packedStorageRows: sessions.reduce((sum, session) => sum + session.packedStorageRows, 0),
        decodedEvents: sessions.reduce((sum, session) => sum + session.events.length, 0),
      },
    },
  }
}
