import { realpathSync } from 'node:fs'
import { apply as applyPlanLattice } from 'dsh-plan-lattice'
import { installLongSystemBoundary } from './common-boundary.js'
import { workspaceShellAdapter } from './workspace-shell-adapter.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  applyPlanLattice(ctx, {
    ...config,
    strictBash: true,
    preconditionAdapters: {
      ...config.preconditionAdapters,
      bash: workspaceShellAdapter,
    },
  })
  installLongSystemBoundary(ctx)
  ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.section({
    name: 'plan-lattice:long-system-protocol',
    order: 56,
    text: assemble => {
      const visible = new Set(assemble.agent?.ctx.tools.schemas(assemble.agent).map(tool => tool.name) ?? [])
      if (!visible.has('lattice_open')) return 'Persist the complete accepted execution contract before protected work.'
      const workspace = realpathSync(process.cwd())
      return `## Plan Lattice long-system protocol

This complete multi-stage system requires full Lattice control. On the first stage, call lattice_open with an empty object immediately, before inspection or design narration. The controller binds every invariant and acceptance criterion from immutable human authority and creates the minimal initial graph. Inspect the repository only after open, then refine the focused leaf only as evidence requires; do not design the complete tree up front. Keep implementation choices changeable; keep product behavior, authority, error boundaries, and acceptance fixed until human input revises them.

At every resumed or compacted stage, read the complete contract and current root-to-leaf plan before mutation. A plugin-authored continuation is not new human authority. A user-authored revision must be classified through lattice_review_input and lattice_commit_input_review; when it changes the contract, call lattice_reframe and reconcile every affected unfinished node before continuing.

For each Bash command, call lattice_refresh_context separately with all affected targetPaths and one externalActions row whose toolName is "bash", resource is "workspace:${workspace}", and arguments.command is byte-for-byte identical to the next Bash command. Then call Bash separately. The controller automatically persists the exact settled attempt as a mechanical receipt whether Bash succeeds or fails; do not copy that result into lattice_checkpoint. Before the next protected action, refresh the complete current basis. Use lattice_checkpoint only when you have verified semantic leaf progress, acceptance evidence, a blocker, or completion. Never batch refresh and Bash together.`
    },
  }))
}
