import { realpathSync } from 'node:fs'
import { hiddenLongSystemTools, assertLongSystemToolBoundary } from './tool-boundary.js'
import { longSystemCommonPrompt } from './common-prompt.js'

export function installLongSystemBoundary(ctx) {
  const restrictions = new Map()

  function replaceRestriction(agent) {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
    const deny = hiddenLongSystemTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (deny.length > 0) restrictions.set(key, agent.ctx.tools.restrict({ deny }))
    const remaining = hiddenLongSystemTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (remaining.length > 0) {
      throw new Error(`long-system matched boundary failed to hide tools: ${remaining.join(', ')}`)
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    assertLongSystemToolBoundary(exec)
    return next()
  })
  ctx.on('agent/created', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/session-start', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/inbox/inserted', ({ agent }) => replaceRestriction(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
  })
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'long-system:matched-boundary',
    order: 55,
    text: () => longSystemCommonPrompt(realpathSync(process.cwd())),
  }))
}
