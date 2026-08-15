import fs from 'node:fs'
import path from 'node:path'

const [outputPath, projectRoot, arm] = process.argv.slice(2)

if (!outputPath || !projectRoot || !arm) {
  throw new Error('usage: render-patch.mjs <output> <project-root> <arm>')
}

const entries = [
  {
    id: 'plan-lattice-eval-user-questions',
    name: path.join(projectRoot, 'eval/support/scripted-user-questions.ts'),
  },
]

if (arm === 'lattice-guided') {
  entries.push({
    id: 'plan-lattice',
    name: path.join(projectRoot, 'lib/index.js'),
    config: {
      intakeMode: 'adaptive',
      longTaskThreshold: 8,
      guardedTools: ['write', 'edit', 'str_replace_editor'],
      strictBash: false,
      topLevelLimit: 2,
      nestedLimit: 5,
    },
  })
}

fs.writeFileSync(outputPath, `${JSON.stringify([{ insert: entries }], null, 2)}\n`)
