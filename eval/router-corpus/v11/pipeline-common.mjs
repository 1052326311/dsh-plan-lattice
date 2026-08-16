import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function stableLines(values) {
  return `${values.map(value => JSON.stringify(value)).join('\n')}\n`
}

export function nonEmptyString(value, context) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value.trim()
}

export function assertSha256(value, context) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest`)
  }
  return value
}

export function assertExactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const actual = Object.keys(value).sort()
  if (canonical(actual) !== canonical([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
  return value
}

export async function assertArtifactsAbsent(paths, stage) {
  for (const path of paths) {
    try {
      await access(path)
      throw new Error(`${stage} output already exists: ${path}; evidence is immutable`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export async function writeExclusive(path, body) {
  try {
    await writeFile(path, body, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${path} already exists; evidence is immutable`, { cause: error })
    throw error
  }
}

export function immutableFailure({ protocol, stage, error, bindings = {} }) {
  return {
    schemaVersion: 1,
    protocol: nonEmptyString(protocol, 'failure protocol'),
    evidenceStatus: 'retired-before-router-reveal',
    stage: nonEmptyString(stage, 'failure stage'),
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    },
    bindings,
  }
}

export async function runFailClosedStage({ protocol, stage, failurePath, bindings = {} }, operation) {
  await assertArtifactsAbsent([failurePath], stage)
  try {
    return await operation()
  } catch (error) {
    const manifest = immutableFailure({ protocol, stage, error, bindings })
    await writeExclusive(failurePath, `${JSON.stringify(manifest, null, 2)}\n`)
    throw error
  }
}

export async function digestPath(path) {
  return sha256(await readFile(path))
}
