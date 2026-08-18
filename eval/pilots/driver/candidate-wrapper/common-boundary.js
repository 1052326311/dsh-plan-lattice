import { createIcaeToolBoundary, hiddenIcaeExecutionTools } from './tool-boundary.js'
import { icaeCommonPrompt } from './common-prompt.js'
import { assertIcaeBashArguments } from './shell-adapter.js'

export function installIcaeCommonBoundary(ctx, { additionalDeniedTools = [] } = {}) {
  const restrictions = new Map()
  const assertToolBoundary = createIcaeToolBoundary()
  const additionalDenied = new Set(additionalDeniedTools)

  function replaceExecutionRestriction(agent) {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
    const visible = agent.ctx.tools.schemas(agent).map(tool => tool.name)
    const deny = [...new Set([
      ...hiddenIcaeExecutionTools(visible),
      ...visible.filter(name => additionalDenied.has(name)),
    ])].sort()
    if (deny.length > 0) restrictions.set(key, agent.ctx.tools.restrict({ deny }))
    const after = agent.ctx.tools.schemas(agent).map(tool => tool.name)
    const remaining = [...new Set([
      ...hiddenIcaeExecutionTools(after),
      ...after.filter(name => additionalDenied.has(name)),
    ])].sort()
    if (remaining.length > 0) {
      throw new Error(`ICAE matched boundary failed to hide direct or delegated execution tools: ${remaining.join(', ')}`)
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    assertToolBoundary(exec)
    if (additionalDenied.has(exec.name)) {
      throw new Error(`ICAE controlled arm replaces ${exec.name} with its durable intake path`)
    }
    if (exec.name === 'bash') {
      const containerId = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
      if (!/^[0-9a-f]{64}$/.test(containerId ?? '')) {
        throw new Error('frozen ICAE container identity is unavailable')
      }
      assertIcaeBashArguments(exec.arguments, containerId)
    }
    return next()
  })
  ctx.on('agent/created', ({ agent }) => replaceExecutionRestriction(agent))
  ctx.on('agent/session-start', ({ agent }) => replaceExecutionRestriction(agent))
  ctx.on('agent/inbox/inserted', ({ agent }) => replaceExecutionRestriction(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
  })
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'icae:matched-execution-boundary',
    order: 55,
    text: () => icaeCommonPrompt(process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID),
  }))
}
