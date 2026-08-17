import { apply as applyPlanLattice } from 'dsh-plan-lattice'
import { icaeShellAdapter } from './shell-adapter.js'
import { createIcaeToolBoundary, hiddenIcaeExecutionTools } from './tool-boundary.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const restrictions = new Map()
  const assertToolBoundary = createIcaeToolBoundary()

  function replaceExecutionRestriction(agent) {
    const key = String(agent.id)
    restrictions.get(key)?.()
    restrictions.delete(key)
    const deny = hiddenIcaeExecutionTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (deny.length > 0) restrictions.set(key, agent.ctx.tools.restrict({ deny }))
    const remaining = hiddenIcaeExecutionTools(agent.ctx.tools.schemas(agent).map(tool => tool.name))
    if (remaining.length > 0) {
      throw new Error(`ICAE candidate failed to hide direct or delegated execution tools: ${remaining.join(', ')}`)
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
    assertToolBoundary(exec)
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
    name: 'plan-lattice:icae-shell-boundary',
    order: 56,
    text: () => {
      const containerId = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
      return `## ICAE execution boundary

During probe mode, read start.md through lattice_route and resolve the route before using any shell or requirements channel. Submit requirement questions only through lattice_intake; its user-question provider is the task Oracle and binds every answer into the contract.

After route resolution, make exactly one valid lattice_intake call containing every required question. Ask no more than five questions. Each question must request one short, independently answerable, outcome-critical contract fact; do not combine several endpoints, interfaces, mappings, or test contracts into one question. Do not include suggested answers that assume the hidden contract. If lattice_intake returns a pendingIntakeId, the next control call must be lattice_commit_intake with every returned answer bound exactly once. If intake returns HTTP 400, HTTP 429, or any other error, do not retry, reframe around the failure, or implement from guesses: stop and report the failed evidence path.

Never contact the Oracle through Bash, web search, direct HTTP, delegation, workflows, or background agents. Direct host mutation, external search, background process control, and every indirect execution tool are absent from this arm. Bash is only for workspace execution after the contract and lattice are open.

After the contract and lattice are open, all development, compilation, and testing must use one exact command of this form: docker exec -w /workspace ${containerId} bash -lc '<script>'. Host-side shell commands are outside the task boundary.

Execute protected commands serially:
1. Call lattice_refresh_context by itself and wait for its result. Set externalActions to toolName "bash", resource "container:${containerId}", and arguments.command byte-for-byte identical to the next Bash command.
2. Call Bash separately with that exact command. Provide only command and the required description. Do not set workdir, run_in_background, or timeoutMs: /workspace exists inside the container, while the Harness process runs on the host, and scheduling controls are outside this evaluation protocol.
3. After Bash returns, call lattice_refresh_context again, then checkpoint the observed result before preparing another Bash command.

Never issue lattice_refresh_context and Bash in the same parallel tool batch.`
    },
  }))
}
