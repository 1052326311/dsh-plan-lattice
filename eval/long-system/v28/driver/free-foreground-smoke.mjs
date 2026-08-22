import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyPlanLattice } from '../../../../lib/index.js'
import { assertNativeForegroundDelegation } from './foreground-lifecycle.mjs'

const ROOT_PROMPT = `Implement the accepted incident-response system in 12 atomic stages across the API, storage, and web UI.
Scope is only the current workspace and its tests; do not deploy or touch production. Existing schemas and tests are the source of truth.
Done means all visible tests pass without regressing prior behavior. Do not ask questions; make only reversible assumptions.
Create the native Todo first, then delegate the requested read-only summary audit through the foreground subagent tool and report completion.`
const MODEL_AUTHORED_CHILD_PROMPT = 'Inspect the shared project and implement the summary milestone with focused tests. Preserve every completed transition behavior.'

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse() {
  const args = JSON.stringify({
    description: 'implement summary',
    prompt: MODEL_AUTHORED_CHILD_PROMPT,
    run_in_background: false,
  })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('v28-foreground-call'), name: 'subagent_fork', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('v28-foreground-call'), name: 'subagent_fork', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function todoCallResponse() {
  const args = JSON.stringify({
    todos: [
      { content: 'Implement the accepted incident behavior', status: 'in_progress' },
      { content: 'Verify the foreground summary audit result', status: 'pending' },
    ],
  })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('v28-todo-call'), name: 'todo_write', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('v28-todo-call'), name: 'todo_write', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function todoTransitionResponse() {
  const args = JSON.stringify({
    todos: [
      { content: 'Implement the accepted incident behavior', status: 'completed' },
      { content: 'Verify the foreground summary audit result', status: 'in_progress' },
    ],
  })
  return toolResponse('v28-todo-transition', 'todo_write', args)
}

function todoCompleteResponse() {
  const args = JSON.stringify({
    todos: [
      { content: 'Implement the accepted incident behavior', status: 'completed' },
      { content: 'Verify the foreground summary audit result', status: 'completed' },
    ],
  })
  return toolResponse('v28-todo-complete', 'todo_write', args)
}

function verificationResponse(callId) {
  return toolResponse(callId, 'bash', JSON.stringify({ command: 'go test ./...' }))
}

function toolResponse(callId, name, args) {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(callId), name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId(callId), name, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function messageText(message) {
  return message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
}

function requestSummary(request, index) {
  return {
    index: index + 1,
    roles: request.messages.map(message => message.role),
    userTexts: request.messages
      .filter(message => message.role === 'user')
      .map(messageText),
    toolResults: request.messages.flatMap(message => message.content
      .filter(block => block.type === 'tool-result')
      .map(block => block.name ?? block.toolName ?? block.toolCallId ?? 'unknown')),
    systemTail: request.system?.slice(-320) ?? '',
    tools: request.tools?.map(tool => tool.name).sort() ?? [],
  }
}

class ForegroundLifecycleAdapter extends LlmAdapter {
  requests = []

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    this.requests.push(options)
    const userTexts = options.messages.filter(message => message.role === 'user').map(messageText)
    const parentRequest = this.requests.filter(request => request.messages
      .filter(message => message.role === 'user')
      .map(messageText)
      .includes(ROOT_PROMPT)).length
    const chunks = userTexts.includes(MODEL_AUTHORED_CHILD_PROMPT)
      ? textResponse('CHILD_SUMMARY_COMPLETE')
      : parentRequest === 1
        ? todoCallResponse()
        : parentRequest === 2
          ? toolCallResponse()
          : parentRequest === 3
            ? verificationResponse('v28-first-verification')
            : parentRequest === 4
              ? todoTransitionResponse()
              : parentRequest === 5
                ? verificationResponse('v28-second-verification')
                : parentRequest === 6
                  ? todoCompleteResponse()
                  : textResponse('ROOT_RECEIVED_CHILD_RESULT')
    for (const chunk of chunks) yield chunk
  }
}

async function runArm(id, candidate) {
  const root = await mkdtemp(join(tmpdir(), `plan-lattice-v28-${id}-`))
  const ctx = new Context()
  try {
    const adapter = new ForegroundLifecycleAdapter()
    await mountAgentLoopTestDependencies(ctx)
    ctx.tools.register(defineTool({
      name: 'todo_write',
      description: 'Replace the native DSH Todo for the foreground smoke.',
      parameters: {
        todos: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              content: { type: 'string', required: true },
              status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args, exec) {
        if (exec.agent === undefined) throw new Error('foreground Todo fixture requires an owning agent')
        exec.agent.session.append('todo/write', { todos: args.todos })
        return Promise.resolve({ todos: args.todos })
      },
    }))
    ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Run one focused verification command for the foreground smoke.',
      parameters: {
        command: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(args) {
        assert.equal(args.command, 'go test ./...')
        return Promise.resolve('ok\tfixture/smoke\t0.001s\nexit code: 0')
      },
    }))
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Fork, { providerName: 'fork' })
    await ctx.plugin(ToolSubagent, {
      provider: 'fork',
      toolName: 'subagent_fork',
      backgroundMode: 'one-shot',
      maxDepth: 1,
    })
    if (candidate) {
      applyPlanLattice(ctx, {
        activationMode: 'auto',
        clarificationPolicy: 'never',
        controlCeiling: 'lattice',
        contractAnchorRoot: join(root, 'anchors'),
      })
    }
    ctx.llm.registerAdapter(['mock'], adapter)

    let childSession
    ctx.on('subagent/start', info => {
      if (info.provider === 'fork') childSession = ctx.agents.get(info.id)?.session
    })
    const parent = ctx.agentLoop.create(SessionId(`v28-${id}-parent`), { provider: 'mock', model: 'mock' })
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: ROOT_PROMPT }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    assert.ok(childSession, `${id}: native subagent/start did not expose the published child`)
    const evidence = assertNativeForegroundDelegation({
      sessions: [
        { header: parent.session.header, events: [...parent.session.events] },
        { header: childSession.header, events: [...childSession.events] },
      ],
      parentSessionId: String(parent.session.header.id),
    })
    assert.equal(evidence.prompt, MODEL_AUTHORED_CHILD_PROMPT)
    assert.equal(
      adapter.requests.length,
      8,
      `${id}: expected Todo, fork, child, two verifications, two Todo transitions, and final calls\n${JSON.stringify(adapter.requests.map(requestSummary), null, 2)}`,
    )
    const todoWrites = parent.session.events.filter(event => event.type === 'todo/write')
    assert.equal(todoWrites.length, 3)
    assert.equal(todoWrites.at(-1).data.todos.every(todo => todo.status === 'completed'), true)
    assert.equal(parent.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'subagent_fork').length, 1)
    assert.equal(parent.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'bash').length, 2)
    assert.equal(parent.session.events.filter(event => event.type === 'tool/result').length, 6)
    assert.equal(parent.session.events.some(event => event.type === 'tool/call' && event.data.name.startsWith('lattice_')), false)
    assert.equal(adapter.requests.some(request => request.messages.some(message =>
      messageText(message).includes('[plan-lattice/native-workflow]'))), false)
    return { id, evidence, modelRequests: adapter.requests.length }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const arms = [await runArm('native', false), await runArm('candidate', true)]
assert.deepEqual(arms.map(arm => arm.modelRequests), [8, 8], 'both arms must use the same foreground lifecycle')
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  protocol: 'v28-unfrozen-free-foreground-smoke',
  paidModelCalls: 0,
  arms,
}, null, 2)}\n`)
