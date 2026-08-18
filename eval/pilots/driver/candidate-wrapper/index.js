import { apply as applyPlanLattice } from 'dsh-plan-lattice'
import { installIcaeCommonBoundary } from './common-boundary.js'
import { icaeShellAdapter } from './shell-adapter.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  applyPlanLattice(ctx, {
    ...config,
    strictBash: true,
    preconditionAdapters: {
      ...config.preconditionAdapters,
      bash: icaeShellAdapter,
    },
  })
  installIcaeCommonBoundary(ctx, { additionalDeniedTools: ['ask_user_question'] })
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'plan-lattice:icae-shell-boundary',
    order: 56,
    text: assemble => {
      const containerId = process.env.DSH_PLAN_LATTICE_ICAE_CONTAINER_ID
      const visible = new Set(assemble.agent?.ctx.tools.schemas(assemble.agent).map(tool => tool.name) ?? [])
      const latticeControl = visible.has('lattice_open')
      const executionProtocol = latticeControl
        ? 'The selected route is full lattice control. Create the initial tree in lattice_open.initialPlan in one call and select its first executable leaf. Refresh that leaf, check it out, and checkpoint protected commands.'
        : 'The selected route is contract control. Do not look for lattice_open, checkout, or checkpoint tools. Commit the contract, then execute directly through a fresh action basis before each protected command.'
      return `## Plan Lattice control protocol

During probe mode, read start.md through lattice_route and resolve the route before using any shell or requirements channel. Submit requirement questions only through lattice_intake; its user-question provider is the task Oracle and binds every answer into the contract.

After route resolution, make exactly one valid lattice_intake call containing every required question. Ask no more than five questions. Each question must request one short, independently answerable, outcome-critical contract fact; do not combine several endpoints, interfaces, mappings, or test contracts into one question. Do not include suggested answers that assume the hidden contract. If lattice_intake returns a pendingIntakeId, the next control call must be lattice_commit_intake with every returned answer bound exactly once. If intake returns HTTP 400, HTTP 429, or any other error, do not retry, reframe around the failure, or implement from guesses: stop and report the failed evidence path.

${executionProtocol}

Execute protected commands serially:
1. Call lattice_refresh_context by itself and wait for its result. Set externalActions to toolName "bash", resource "container:${containerId}", and arguments.command byte-for-byte identical to the next Bash command.
2. Call Bash separately with that exact command.
3. After Bash returns, ${latticeControl ? 'call lattice_refresh_context again, then checkpoint the observed result before preparing another Bash command' : 'inspect the result and prepare a new lattice_refresh_context basis before the next protected command'}.

Never issue lattice_refresh_context and Bash in the same parallel tool batch.`
    },
  }))
}
