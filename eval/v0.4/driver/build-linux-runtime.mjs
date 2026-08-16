#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../lib/canonical.mjs'
import { withoutEvaluationCapabilities } from './lib/environment.mjs'
import { packagePluginAtCommit } from './lib/runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const harnessRoot = resolve(option('--harness-root') ?? '')
const output = resolve(option('--output') ?? '')
const pluginCommit = option('--plugin-commit')
const harnessCommit = option('--harness-commit')
const image = option('--image')
const arm = JSON.parse(option('--arm-json') ?? '{}')
if (!harnessRoot || !output || typeof arm.id !== 'string' || !/^[0-9a-f]{40}$/.test(harnessCommit ?? '') || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(image ?? '')) {
  throw new Error('usage: build-linux-runtime.mjs --harness-root <path> --harness-commit <sha> --image <name@sha256:digest> --output <tgz> --arm-json <json> [--plugin-commit <sha>]')
}
if (arm.plugin === 'none' && pluginCommit) throw new Error('native runtime must not include a plugin commit')
if (arm.plugin !== 'none' && !/^[0-9a-f]{40}$/.test(pluginCommit ?? '')) throw new Error('every controlled runtime requires an exact plugin commit')
const actualHarnessCommit = spawnSync('git', ['-C', harnessRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim()
if (actualHarnessCommit !== harnessCommit) throw new Error(`Harness checkout mismatch: expected ${harnessCommit}, got ${actualHarnessCommit}`)

const context = await mkdtemp(join(tmpdir(), 'plan-lattice-linux-runtime-'))
const pluginPackage = arm.plugin === 'none'
  ? undefined
  : (await packagePluginAtCommit(pluginCommit, join(context, 'plugin-package'))).path
const pluginPackageDigest = pluginPackage ? sha256(await readFile(pluginPackage)) : null
const supportDigest = sha256({
  package: await readFile(join(here, 'support-plugin', 'package.json'), 'utf8'),
  patch: await readFile(join(here, 'support-plugin', 'cordis.patch.yml'), 'utf8'),
  source: await readFile(join(here, 'support-plugin', 'index.js'), 'utf8'),
})
const runtimeMetadata = {
  schemaVersion: 1,
  arm,
  armDigest: sha256(arm),
  harnessCommit,
  pluginCommit: pluginCommit ?? null,
  pluginPackageDigest,
  baseImage: image,
}
const harnessArchive = join(context, 'harness.tar')
const archiveResult = spawnSync('git', ['-C', harnessRoot, 'archive', '--format=tar', '-o', harnessArchive, harnessCommit], { encoding: 'utf8' })
if (archiveResult.error) throw archiveResult.error
if (archiveResult.status !== 0) throw new Error(`Harness source archive failed: ${archiveResult.stderr || archiveResult.stdout}`)
const patchRows = [
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
if (pluginPackage) {
  patchRows.push('- id: plan-lattice', '  config:')
  if (arm.plugin === 'v0.3.0') patchRows.push('    intakeMode: off')
  else {
    for (const key of ['activationMode', 'clarificationPolicy', 'controlCeiling']) {
      if (arm[key] !== undefined) patchRows.push(`    ${key}: ${arm[key]}`)
    }
  }
}
const profilePatch = `${patchRows.join('\n')}\n`
await writeFile(join(context, 'cordis.patch.yml'), profilePatch, 'utf8')
runtimeMetadata.supportDigest = supportDigest
runtimeMetadata.profilePatchDigest = sha256(profilePatch)
await writeFile(join(context, 'runtime.json'), `${JSON.stringify(runtimeMetadata, null, 2)}\n`, 'utf8')
await writeFile(join(context, 'build.sh'), `#!/usr/bin/env bash
set -euo pipefail
npm install --global pnpm@10.14.0
mkdir -p /work/harness /installed-agent/runtime /output
tar -xf /inputs/harness.tar -C /work/harness
cd /work/harness
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @deepseek-ai/dsh deploy --legacy --prod /installed-agent/runtime/dsh
cp /usr/local/bin/node /installed-agent/runtime/node
cp /inputs/session-metrics.mjs /installed-agent/runtime/session-metrics.mjs
mkdir -p /installed-agent/runtime/lib
cp /inputs/session-metrics-lib.mjs /installed-agent/runtime/lib/session-metrics.mjs
cp /inputs/runtime.json /installed-agent/runtime/runtime.json
mkdir -p /installed-agent/runtime/packages/support /installed-agent/runtime/dsh/node_modules/dsh-plan-lattice-eval-support
cp -a /inputs/support/. /installed-agent/runtime/packages/support/
cp -a /inputs/support/. /installed-agent/runtime/dsh/node_modules/dsh-plan-lattice-eval-support/
export DSH_HOME=/installed-agent/runtime/home
/installed-agent/runtime/node /installed-agent/runtime/dsh/lib/bin.js plugin --profile headless add /installed-agent/runtime/dsh/node_modules/dsh-plan-lattice-eval-support
if test -f /inputs/plugin.tgz; then
  cp /inputs/plugin.tgz /installed-agent/runtime/packages/plugin.tgz
  /installed-agent/runtime/node /installed-agent/runtime/dsh/lib/bin.js plugin --profile headless add /installed-agent/runtime/packages/plugin.tgz
fi
cp /inputs/cordis.patch.yml /installed-agent/runtime/home/profiles/headless/cordis.patch.yml
touch /installed-agent/runtime/.ready
tar -czf /output/${basename(output)} -C / installed-agent/runtime
`, { mode: 0o755 })

await mkdir(dirname(output), { recursive: true })
const dockerArgs = [
  'run', '--rm',
  '--mount', `type=bind,src=${harnessArchive},dst=/inputs/harness.tar,readonly`,
  '--mount', `type=bind,src=${join(here, 'support-plugin')},dst=/inputs/support,readonly`,
  '--mount', `type=bind,src=${join(here, 'container-session-metrics.mjs')},dst=/inputs/session-metrics.mjs,readonly`,
  '--mount', `type=bind,src=${join(here, 'lib', 'session-metrics.mjs')},dst=/inputs/session-metrics-lib.mjs,readonly`,
  '--mount', `type=bind,src=${join(context, 'cordis.patch.yml')},dst=/inputs/cordis.patch.yml,readonly`,
  '--mount', `type=bind,src=${join(context, 'build.sh')},dst=/inputs/build.sh,readonly`,
  '--mount', `type=bind,src=${join(context, 'runtime.json')},dst=/inputs/runtime.json,readonly`,
  '--mount', `type=bind,src=${dirname(output)},dst=/output`,
]
if (pluginPackage) dockerArgs.push('--mount', `type=bind,src=${pluginPackage},dst=/inputs/plugin.tgz,readonly`)
dockerArgs.push(image, 'bash', '/inputs/build.sh')
const result = spawnSync('docker', dockerArgs, {
  encoding: 'utf8',
  env: withoutEvaluationCapabilities(),
  maxBuffer: 64 * 1024 * 1024,
})
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Linux runtime build failed: ${result.stderr || result.stdout}`)
process.stdout.write(`${JSON.stringify({
  path: output,
  sha256: sha256(await readFile(output)),
  image,
  harnessCommit,
  runtimeMetadata,
  runtimeMetadataDigest: sha256(runtimeMetadata),
  supportDigest,
  arm,
})}\n`)
