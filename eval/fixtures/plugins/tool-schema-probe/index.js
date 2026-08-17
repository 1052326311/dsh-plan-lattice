import { writeFileSync } from 'node:fs'

export const name = 'plan-lattice-tool-schema-probe'
export const inject = ['tools']

export function apply(ctx) {
  const output = process.env.PLAN_LATTICE_SCHEMA_PROBE
  if (output === undefined || output.length === 0) {
    throw new Error('PLAN_LATTICE_SCHEMA_PROBE is required')
  }

  void ctx.loader.await().then(() => {
    const names = ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(toolName => toolName.startsWith('lattice_'))
      .sort()
    writeFileSync(output, `${JSON.stringify(names, null, 2)}\n`, 'utf8')
  })
}
