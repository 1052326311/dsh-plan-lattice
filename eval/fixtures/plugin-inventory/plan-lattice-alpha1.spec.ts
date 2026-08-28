import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginInventory from '../src/index.ts'
import { expect, it } from 'vitest'

const ALPHA_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
const ALPHA_TAG = 'dsh-v0.1.2-alpha.1'
const ALPHA_VERSION = '0.1.2-alpha.1'
const LOADER_ENTRY = 'dsh-plan-lattice'

interface Fixture {
  readonly root: string
  readonly source: string
  readonly sha256: string
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

async function resolveIdentity(fixture: Fixture): Promise<{
  expectedIdentity: { name: string; version: string }
  observedIdentity: { name: string; version: string }
}> {
  const manifestPath = join(fixture.root, 'node_modules', LOADER_ENTRY, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  expect(manifest.name).toBe(LOADER_ENTRY)
  expect(typeof manifest.version).toBe('string')
  const expectedIdentity = { name: manifest.name as string, version: manifest.version as string }

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(join(fixture.root, 'cordis.yml')).href
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
    await ctx.plugin(PluginInventory)

    const internal = ctx.loader.internal
    if (internal === undefined) throw new Error('Loader internal importer is unavailable')
    ctx.loader.internal = {
      version: 'v2',
      import: async (specifier: string, ...args: unknown[]) => {
        if (specifier === LOADER_ENTRY) return { default: () => {} }
        return await (internal as never as {
          import(specifier: string, ...args: unknown[]): Promise<unknown>
        }).import(specifier, ...args)
      },
    }
    await ctx.loader.create({ name: LOADER_ENTRY })
    const entry = [...ctx.loader.entries()].find(current => current.options.name === LOADER_ENTRY)
    expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)

    const prepared = await ctx.deepseekLlmApiExtensions.prepare({
      body: { messages: [] },
      signal: new AbortController().signal,
    })
    expect(prepared.fields.dsh_plugin_packages).toEqual({
      version: 1,
      packages: [expectedIdentity],
    })
    return {
      expectedIdentity,
      observedIdentity: prepared.fields.dsh_plugin_packages!.packages[0]!,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

it('resolves the exact Plan Lattice package identity with the official alpha.1 implementation', async () => {
  const fixtures: Fixture[] = [
    {
      root: required('PLAN_LATTICE_RELEASE_ROOT'),
      source: required('PLAN_LATTICE_RELEASE_SOURCE'),
      sha256: required('PLAN_LATTICE_RELEASE_SHA256'),
    },
    {
      root: required('PLAN_LATTICE_CANDIDATE_ROOT'),
      source: required('PLAN_LATTICE_CANDIDATE_SOURCE'),
      sha256: required('PLAN_LATTICE_CANDIDATE_SHA256'),
    },
  ]
  const artifacts = []
  for (const fixture of fixtures) {
    artifacts.push({
      source: fixture.source,
      artifactSha256: fixture.sha256,
      loaderEntry: LOADER_ENTRY,
      loaderState: 'ACTIVE',
      ...await resolveIdentity(fixture),
    })
  }

  const record = {
    schema: 'dsh-plugin-inventory-source-contract/v1',
    verified: true,
    scope: 'source-contract-only',
    dshVersion: ALPHA_VERSION,
    dshTag: ALPHA_TAG,
    dshCommit: ALPHA_COMMIT,
    installableAlphaArtifactTested: false,
    inventoryField: 'dsh_plugin_packages',
    inventorySchemaVersion: 1,
    providerMetadataOnly: true,
    endorsement: false,
    checkedAt: new Date().toISOString(),
    runner: `${process.platform}-${process.arch}-node-${process.version}`,
    checks: [
      'exact-official-source-tag',
      'exact-artifact-manifest',
      'active-loader-entry',
      'official-identity-resolver',
      'exact-name-version-observation',
    ],
    artifacts,
  }
  await writeFile(required('INVENTORY_RECORD'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  expect(artifacts).toHaveLength(2)
})
