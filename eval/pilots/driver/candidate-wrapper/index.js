import { apply as applyPlanLattice } from 'dsh-plan-lattice'
import { icaeShellAdapter } from './shell-adapter.js'
import { assertIcaeToolBoundary, hiddenIcaeHostTools } from './tool-boundary.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const restrictions = new Map()

  function replaceHostMutationRestriction(agent) {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
    const deny = hiddenIcaeHostTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (deny.length > 0) restrictions.set(key, agent.ctx.tools.restrict({ deny }))
    const remaining = hiddenIcaeHostTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (remaining.length > 0) {
      throw new Error(`ICAE candidate failed to hide host mutation tools: ${remaining.join(', ')}`)
    }
  }

  applyPlanLattice(ctx, {
    ...config,
    strictBash: true,
    preconditionAdapters: {
      ...config.preconditionAdapters,
      bash: icaeShellAdapter,
    },
  })
  ctx.on('tools/execute', async (exec, next) => {
    assertIcaeToolBoundary(exec)
    return next()
  })
  ctx.on('agent/created', ({ agent }) => replaceHostMutationRestriction(agent))
  ctx.on('agent/session-start', ({ agent }) => replaceHostMutationRestriction(agent))
  ctx.on('agent/inbox/inserted', ({ agent }) => replaceHostMutationRestriction(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
  })
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'plan-lattice:icae-shell-boundary',
    order: 56,
    text: () => {
      const containerId = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
      return `## ICAE execution boundary

During probe mode, read start.md through lattice_route and resolve the route before using any shell or requirements channel. Submit requirement questions only through lattice_intake; its user-question provider is the task Oracle and binds every answer into the contract.

After the contract and lattice are open, all development, compilation, and testing must use one exact command of this form: docker exec -w /workspace ${containerId} bash -lc '<script>'. Host mutation tools are removed from this evaluation arm, and host-side shell commands are outside the task boundary. Before each exact bash call, use lattice_refresh_context with externalActions containing toolName "bash", resource "container:${containerId}", and arguments.command byte-for-byte identical to the upcoming command. Checkpoint the observed result before another guarded command.`
    },
  }))
}
