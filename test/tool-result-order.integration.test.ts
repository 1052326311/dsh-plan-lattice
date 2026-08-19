import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

const contexts: Context[] = []
const workspaces: string[] = []

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for native AgentLoop progress')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

class StrictToolResultAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  protocolAccepted = false

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'open-contract' as never,
          name: 'lattice_open',
          arguments: '{}',
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    this.assertToolCallAdjacency(options)
    this.protocolAccepted = true
    const text = 'The provider accepted the tool-result sequence.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  private assertToolCallAdjacency(options: GenerateOptions): void {
    const assistantIndex = options.messages.findIndex(message => (
      message.role === 'assistant'
      && message.content.some(block => block.type === 'tool-call' && block.id === 'open-contract')
    ))
    if (assistantIndex < 0) throw new Error('strict provider did not receive the lattice_open assistant tool call')

    const following = options.messages[assistantIndex + 1]
    const hasMatchingResult = following?.content.some(block => (
      block.type === 'tool-result' && block.toolCallId === 'open-contract'
    )) ?? false
    if (!hasMatchingResult) {
      throw new Error("An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.")
    }
  }
}

describe('native tool-result ordering', () => {
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('defers contract markers until after DSH commits the enclosing tool result', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-plan-lattice-tool-order-'))
    workspaces.push(workspace)
    await writeFile(join(workspace, 'target.ts'), 'export const value = 1\n', 'utf8')

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin({
      name: 'plan-lattice-tool-order-test',
      inject: ['tools'],
      apply(inner) {
        apply(inner, {
          activationMode: 'always',
          clarificationPolicy: 'never',
          controlCeiling: 'lattice',
          strictBash: false,
          contractAnchorRoot: join(workspace, '.authorization-anchors'),
        })
      },
    })
    const adapter = new StrictToolResultAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('tool-result-order'), {
      provider: 'mock',
      model: 'mock',
    }, { cwd: workspace })
    const errors: unknown[] = []
    agent.ctx.on('agent/error', ({ error }) => { errors.push(error) })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Build the accepted multi-step system. Do not ask questions; make reversible assumptions.' }],
      source: { kind: 'user' },
    }))
    await waitUntil(() => adapter.requests.length === 2 || errors.length > 0)
    await agent.whenIdle()

    expect(errors).toEqual([])
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.protocolAccepted).toBe(true)
    const events = agent.session.events
    const resultIndex = events.findIndex(event => event.type === 'tool/result')
    const markerIndex = events.findIndex(event => (
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'plan-lattice'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('[plan-lattice/input-review]'))
    ))
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(markerIndex).toBeGreaterThan(resultIndex)
  })
})
