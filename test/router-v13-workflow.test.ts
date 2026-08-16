import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const workflow = join(process.cwd(), 'eval/router-corpus/v13/workflow.mjs')

describe('V13 executable workflow', () => {
  it('creates three isolated annotation packets and refuses to overwrite them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plan-lattice-v13-workflow-'))
    const frame = ['en', 'zh'].flatMap(language => Array.from({ length: 3 }, (_, index) => ({
      stableSourceId: `github:${language}-org/repository-${index}:issue:${index}`,
      sourceFamilyId: `github:${language}-org/repository-${index}:issue:${index}`,
      language,
      text: `${language} observable authorization task ${index} with enough detail for isolated annotation.`,
    })))
    const environment = { ...process.env, PLAN_LATTICE_V13_DATA_DIR: root }
    try {
      await writeFile(join(root, 'source-frame.jsonl'), `${frame.map(row => JSON.stringify(row)).join('\n')}\n`)
      await execFile(process.execPath, [workflow, 'packets'], { env: environment })

      const names = await readdir(root)
      expect(names).toEqual(expect.arrayContaining([
        'annotation-candidates.jsonl',
        'annotation-mappings.json',
        'annotation-packet-manifest.json',
        'annotation-packet-a.jsonl',
        'annotation-packet-b.jsonl',
        'annotation-packet-c.jsonl',
      ]))
      const manifest = JSON.parse(await readFile(join(root, 'annotation-packet-manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({
        evidenceStatus: 'three-isolated-annotation-packets',
        candidateCount: frame.length,
      })
      expect(new Set(Object.values(manifest.packetDigests))).toHaveLength(3)

      await expect(execFile(process.execPath, [workflow, 'packets'], { env: environment }))
        .rejects.toMatchObject({ code: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
