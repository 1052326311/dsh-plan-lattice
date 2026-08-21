import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

function invariant(condition, message) {
  if (!condition) throw new Error(`V26 foreground lifecycle: ${message}`)
}

function textBlocks(message) {
  invariant(message && typeof message === 'object' && Array.isArray(message.content), 'message content is malformed')
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
}

function ownEvents(session) {
  const seedLength = session.header?.seedLength ?? 0
  invariant(Number.isSafeInteger(seedLength) && seedLength >= 0 && seedLength <= session.events.length,
    `Session ${String(session.header?.id)} has an invalid seedLength`)
  return session.events.slice(seedLength)
}

function firstOwnUserMessage(session) {
  return ownEvents(session).find(event => event.type === 'user/message')
}

function toolResultBlock(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return undefined
  return content.find(block => block?.type === 'tool-result')
}

function parseCallArguments(event) {
  invariant(typeof event.data.arguments === 'string', 'parent tool/call arguments are not the raw model JSON string')
  let args
  try {
    args = JSON.parse(event.data.arguments)
  } catch {
    throw new Error('V26 foreground lifecycle: parent subagent arguments are not valid JSON')
  }
  invariant(args && typeof args === 'object' && !Array.isArray(args), 'parent subagent arguments are not an object')
  invariant(typeof args.description === 'string' && args.description.length > 0, 'model did not author a delegation description')
  invariant(typeof args.prompt === 'string' && args.prompt.length > 0, 'model did not author a delegation prompt')
  invariant(args.run_in_background === false, 'delegation was not explicitly foreground')
  return args
}

function candidateCalls(parent, toolName) {
  return parent.events.filter(event => event.type === 'tool/call' && event.data?.name === toolName)
}

function requestToolSchema(parent, call, toolName) {
  const headers = parent.events.filter(event => event.type === 'request/header'
    && event.seq < call.seq
    && Array.isArray(event.data?.header?.tools))
  const header = headers.at(-1)
  invariant(header !== undefined, `parent call ${String(call.data.callId)} has no preceding native request/header`)
  const matches = header.data.header.tools.filter(tool => tool?.name === toolName)
  invariant(matches.length === 1, `parent request must expose exactly one ${toolName} schema`)
  return matches[0]
}

function matchingResult(parent, call) {
  const matches = parent.events.filter(event => {
    if (event.type !== 'tool/result') return false
    const block = toolResultBlock(event)
    return block?.toolCallId === call.data.callId
  })
  invariant(matches.length === 1, `parent call ${String(call.data.callId)} must have exactly one matching tool/result`)
  return matches[0]
}

function matchingChildren(sessions, parentSessionId, call, args, result) {
  return sessions.filter(session => {
    if (session.header?.parentSession !== parentSessionId
      || session.header?.origin !== 'subagent'
      || session.header?.delegationDepth !== 1) return false
    const first = firstOwnUserMessage(session)
    if (first === undefined) return false
    const blocks = textBlocks(first.data)
    return blocks.length === 1
      && blocks[0].text === args.prompt
      && first.data?.source?.kind === 'user'
      && first.time >= call.time
      && first.time <= result.time
  })
}

/**
 * Prove that a child came from the root model-facing foreground `subagent_fork`
 * tool, rather than from an evaluator calling `ctx.subagents.start()`.
 */
export function assertNativeForegroundDelegation({ sessions, parentSessionId, toolName = 'subagent_fork' }) {
  invariant(Array.isArray(sessions), 'sessions must be an array')
  const parentMatches = sessions.filter(session => session.header?.id === parentSessionId)
  invariant(parentMatches.length === 1, `expected exactly one parent Session ${parentSessionId}`)
  const parent = parentMatches[0]
  const calls = candidateCalls(parent, toolName)
  invariant(calls.length === 1, `parent must contain exactly one model-authored ${toolName} tool/call`)
  const call = calls[0]
  const args = parseCallArguments(call)
  const result = matchingResult(parent, call)
  invariant(result.seq > call.seq, 'parent tool/result precedes its tool/call')
  invariant(result.data.turn === call.data.turn && result.data.step === call.data.step,
    'parent tool/call and tool/result are not in the same native step')
  invariant(Array.isArray(result.sourceEventSeqs) && result.sourceEventSeqs.includes(call.seq),
    'parent tool/result does not cite the matching tool/call event')
  const resultBlock = toolResultBlock(result)
  invariant(resultBlock?.isError === false, 'foreground subagent tool/result is an error')
  const toolSchema = requestToolSchema(parent, call, toolName)

  const children = matchingChildren(sessions, parentSessionId, call, args, result)
  invariant(children.length === 1, 'no unique direct child has a first user message equal to the model-authored prompt')
  const child = children[0]
  const descriptor = child.events.find(event => event.type === 'subagent/descriptor')
  invariant(descriptor?.data?.mode === 'one-shot', 'foreground child lacks the native one-shot descriptor')
  invariant(descriptor.data.provider === 'fork', 'foreground child was not created by the native fork provider')
  invariant(descriptor.data.label === args.description, 'child descriptor label differs from the model-authored description')

  const first = firstOwnUserMessage(child)
  invariant(first.data.source.kind === 'user', 'child first message is not an ordinary user message')
  invariant(textBlocks(first.data).length === 1, 'child first message is not the exact single text prompt')
  const terminal = child.events.filter(event => event.type === 'turn/end').at(-1)
  invariant(terminal?.data?.reason?.kind === 'completed', 'foreground child has no durably completed turn')

  return {
    parentSessionId,
    childSessionId: child.header.id,
    callSeq: call.seq,
    resultSeq: result.seq,
    callId: call.data.callId,
    description: args.description,
    prompt: args.prompt,
    promptSha256: createHash('sha256').update(args.prompt).digest('hex'),
    toolSchemaSha256: createHash('sha256').update(JSON.stringify(toolSchema)).digest('hex'),
    childTerminalSeq: terminal.seq,
  }
}

async function walk(directory) {
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
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.name === 'session.jsonl') files.push(path)
  }
  return files
}

function parseSession(text, path) {
  invariant(text.endsWith('\n'), `${path} is not a complete JSONL artifact`)
  const lines = text.split(/\r?\n/).filter(Boolean)
  invariant(lines.length > 0, `${path} is empty`)
  const rows = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error(`V26 foreground lifecycle: ${path} has invalid JSON on line ${index + 1}`)
    }
  })
  const [header, ...events] = rows
  invariant(header?.type === 'session' && typeof header.id === 'string', `${path} has no Session header`)
  events.forEach((event, index) => {
    invariant(Number.isSafeInteger(event?.seq) && event.seq === index, `${path} has non-contiguous events`)
  })
  return { path, header, events }
}

export async function readDurableSessions(root) {
  const files = await walk(root)
  invariant(files.length > 0, 'Harness produced no persistent session.jsonl artifact')
  return Promise.all(files.map(async path => parseSession(await readFile(path, 'utf8'), path)))
}

export async function assertDurableNativeForegroundDelegation(options) {
  const sessions = await readDurableSessions(options.sessionsRoot)
  return assertNativeForegroundDelegation({
    sessions,
    parentSessionId: options.parentSessionId,
    toolName: options.toolName,
  })
}
