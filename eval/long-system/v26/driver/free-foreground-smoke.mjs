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
import { apply as applyPlanLattice } from '../../../../lib/index.js'
import { assertNativeForegroundDelegation } from './foreground-lifecycle.mjs'

const ROOT_PROMPT = 'Delegate the requested summary implementation through the foreground subagent tool, then report completion.'
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
    { type: 'tool-call-delta', index: 0, id: CallId('v26-foreground-call'), name: 'subagent_fork', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('v26-foreground-call'), name: 'subagent_fork', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function messageText(message) {
  return message?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
}

class ForegroundLifecycleAdapter extends LlmAdapter {
  requests = []

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    this.requests.push(options)
    const userTexts = options.messages.filter(message => message.role === 'user').map(messageText)
    const hasToolResult = options.messages.some(message => message.content.some(block => block.type === 'tool-result'))
    const chunks = userTexts.includes(MODEL_AUTHORED_CHILD_PROMPT)
      ? textResponse('CHILD_SUMMARY_COMPLETE')
      : hasToolResult
        ? textResponse('ROOT_RECEIVED_CHILD_RESULT')
        : toolCallResponse()
    for (const chunk of chunks) yield chunk
  }
}

async function runArm(id, candidate) {
  const root = await mkdtemp(join(tmpdir(), `plan-lattice-v26-${id}-`))
  const ctx = new Context()
  try {
    const adapter = new ForegroundLifecycleAdapter()
    await mountAgentLoopTestDependencies(ctx)
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
    const parent = ctx.agentLoop.create(SessionId(`v26-${id}-parent`), { provider: 'mock', model: 'mock' })
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
    assert.equal(adapter.requests.length, 3, `${id}: expected root call, child call, and root post-result call`)
    assert.equal(parent.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'subagent_fork').length, 1)
    assert.equal(parent.session.events.filter(event => event.type === 'tool/result').length, 1)
    assert.equal(parent.session.events.some(event => event.type === 'tool/call' && event.data.name.startsWith('lattice_')), false)
    return { id, evidence, modelRequests: adapter.requests.length }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

const arms = [await runArm('native', false), await runArm('candidate', true)]
assert.deepEqual(arms.map(arm => arm.modelRequests), [3, 3], 'both arms must use the same foreground lifecycle')
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  protocol: 'v26-unfrozen-free-foreground-smoke',
  paidModelCalls: 0,
  arms,
}, null, 2)}\n`)
