import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed for ICAE provenance`)
  return result.stdout.trim()
}

export async function digestAssetPath(inputPath) {
  const root = resolve(inputPath)
  const hash = createHash('sha256')

  async function visit(path) {
    const stat = await lstat(path)
    const name = relative(root, path) || '.'
    const mode = (stat.mode & 0o777).toString(8)
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${name}\0${mode}\0${await readlink(path)}\0`)
      return
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${name}\0${mode}\0`)
      const entries = await readdir(path)
      for (const entry of entries.sort()) await visit(join(path, entry))
      return
    }
    if (!stat.isFile()) throw new Error(`unsupported ICAE asset type at ${path}`)
    hash.update(`file\0${name}\0${mode}\0${stat.size}\0`)
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    hash.update('\0')
  }

  await visit(root)
  return hash.digest('hex')
}

function prepareDockerImage({ icaeRoot, alias, language, pythonExecutable, dockerHost }) {
  const source = [
    'import sys',
    'from pathlib import Path',
    'sys.path.insert(0, sys.argv[1])',
    'from harness import config as C',
    'from harness.docker_env import anon_tag_for, ensure_image',
    'tar_path = C.lang_tar_path(sys.argv[3])',
    'print(ensure_image(tar_path, anon_tag=anon_tag_for(sys.argv[2], tar_path), hide_real_tag=False))',
  ].join('\n')
  const prepared = spawnSync(pythonExecutable, ['-c', source, icaeRoot, alias, language], {
    encoding: 'utf8',
    env: { ...process.env, DOCKER_HOST: dockerHost, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (prepared.status !== 0 || prepared.stdout.trim() === '') {
    throw new Error(`failed to prepare the pinned ICAE Docker image: ${prepared.stderr.trim()}`)
  }
  const tag = prepared.stdout.trim().split(/\r?\n/).at(-1)
  const inspected = spawnSync('docker', ['image', 'inspect', tag, '--format', '{{json .}}'], {
    encoding: 'utf8',
    env: { ...process.env, DOCKER_HOST: dockerHost },
  })
  if (inspected.status !== 0) throw new Error('failed to inspect the pinned ICAE Docker image')
  const image = JSON.parse(inspected.stdout)
  if (typeof image.Id !== 'string' || !image.Id.startsWith('sha256:')) {
    throw new Error('ICAE Docker image inspection omitted its immutable ID')
  }
  return {
    tag,
    id: image.Id,
    repoDigests: Array.isArray(image.RepoDigests) ? [...image.RepoDigests].sort() : [],
    architecture: image.Architecture,
    os: image.Os,
    created: image.Created,
  }
}

export async function collectIcaeTaskProvenance({
  icaeRoot,
  expectedCommit,
  task,
  officialDataAssets,
  pythonExecutable,
  dockerHost,
}) {
  const commit = git(icaeRoot, ['rev-parse', 'HEAD'])
  if (commit !== expectedCommit) throw new Error(`ICAE checkout is ${commit}, expected ${expectedCommit}`)
  if (git(icaeRoot, ['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('ICAE tracked files changed after the benchmark commit was selected')
  }
  const aliases = JSON.parse(await readFile(join(icaeRoot, 'repo_alias.json'), 'utf8'))
  const alias = Object.entries(aliases).find(([, record]) => record?.key === task.repositoryKey)?.[0]
  if (typeof alias !== 'string') throw new Error(`ICAE alias is missing for ${task.repositoryKey}`)

  const paths = {
    repositoryCatalog: 'repo_alias.json',
    repositorySelection: 'harness/repos.yaml',
    fuzzyPrd: `fuzzy_prds/${alias}`,
    oracleRequirements: `user_agent/prd_json_medium/${alias}.json`,
    goldenRepository: `realcode_repos/${task.repositoryKey}`,
    authoritativeTests: `rcb_tests_repos/${task.repositoryKey}`,
    dockerImageTar: 'docker_lang_official/node_20.tar',
  }
  const assets = {}
  for (const [name, path] of Object.entries(paths)) {
    assets[name] = { path, sha256: await digestAssetPath(join(icaeRoot, path)) }
  }
  return {
    schemaVersion: 1,
    commit,
    alias,
    taskId: task.id,
    repositoryKey: task.repositoryKey,
    selectionHash: task.selectionHash,
    officialDataAssets,
    assets,
    dockerImage: prepareDockerImage({
      icaeRoot,
      alias,
      language: task.language,
      pythonExecutable,
      dockerHost,
    }),
  }
}
