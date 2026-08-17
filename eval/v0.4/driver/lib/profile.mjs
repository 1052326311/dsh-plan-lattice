import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withoutEvaluationCapabilities } from './environment.mjs'

export function armPluginConfig(arm) {
  if (arm.plugin === 'none') return undefined
  if (arm.plugin === 'v0.3.0') return { intakeMode: 'off' }
  const config = {}
  for (const key of ['activationMode', 'clarificationPolicy', 'controlCeiling', 'strictBash']) {
    if (arm[key] !== undefined) config[key] = arm[key]
  }
  return config
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result
}

export async function configureProfile({ dshBin, dshHome, supportPlugin, pluginPackage, arm }) {
  const env = { ...withoutEvaluationCapabilities(), DSH_HOME: dshHome }
  const dshPackageRoot = resolve(dirname(dshBin), '..')
  const supportSource = join(dshPackageRoot, 'node_modules', 'dsh-plan-lattice-eval-support')
  await rm(supportSource, { recursive: true, force: true })
  await mkdir(dirname(supportSource), { recursive: true })
  await cp(supportPlugin, supportSource, { recursive: true, force: true })
  run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', supportSource], { env })
  if (pluginPackage) run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', pluginPackage], { env })
  const profileDir = join(dshHome, 'profiles', 'headless')
  await mkdir(profileDir, { recursive: true })
  const pluginConfig = armPluginConfig(arm)
  const rows = [
    '- id: headless-runner',
    '  disabled: !!js Boolean(process.env.DSH_PLAN_LATTICE_EVAL_SESSION_ID)',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    '    root: !!js process.env.DSH_PLAN_LATTICE_SESSION_ROOT',
    '    packChunks: false',
    '    compression: none',
  ]
  if (pluginConfig) {
    rows.push('- id: plan-lattice', '  config:')
    for (const [key, value] of Object.entries(pluginConfig)) rows.push(`    ${key}: ${value}`)
  }
  await writeFile(join(profileDir, 'cordis.patch.yml'), `${rows.join('\n')}\n`, 'utf8')
  return { profileDir, pluginConfig }
}
