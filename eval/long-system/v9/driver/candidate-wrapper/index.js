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
}
