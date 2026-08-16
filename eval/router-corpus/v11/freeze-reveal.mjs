import {
  assertArtifactsAbsent,
  assertSha256,
  canonical,
  immutableFailure,
  nonEmptyString,
  sha256,
  writeExclusive,
} from './pipeline-common.mjs'

const requiredArtifacts = ['router', 'runtime', 'sources', 'labels', 'prompts']

function artifactBody(value, context) {
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value
  throw new Error(`${context} must be a string or Buffer`)
}

function artifactRecords(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('freeze artifacts must be an object')
  }
  for (const name of requiredArtifacts) {
    if (!Object.hasOwn(artifacts, name)) throw new Error(`freeze artifacts are missing ${name}`)
  }
  return Object.fromEntries(Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
    const body = artifactBody(value, `artifact ${name}`)
    return [name, { bytes: Buffer.byteLength(body), sha256: sha256(body) }]
  }))
}

export function createFreezeManifest({
  protocol,
  routerCommit,
  exposureRegistryDigest,
  artifacts,
  expectedArtifactDigests,
  configuration,
}) {
  const protocolId = nonEmptyString(protocol, 'freeze protocol')
  const commit = nonEmptyString(routerCommit, 'router commit')
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('router commit must be an exact 40-character Git commit')
  assertSha256(exposureRegistryDigest, 'V10 exposure registry digest')
  const records = artifactRecords(artifacts)
  for (const name of ['router', 'runtime']) {
    const expected = assertSha256(expectedArtifactDigests?.[name], `expected ${name} digest`)
    if (records[name].sha256 !== expected) throw new Error(`${name} differs from its preregistered digest`)
  }
  return {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: 'frozen-before-one-reveal',
    routerCommit: commit,
    predecessorExposure: {
      protocol: 'observable-authorization-v10',
      registrySha256: exposureRegistryDigest,
    },
    configuration,
    artifacts: records,
  }
}

export function verifyFreezeManifest(manifest, artifacts) {
  if (manifest?.schemaVersion !== 1 || manifest.evidenceStatus !== 'frozen-before-one-reveal') {
    throw new Error('freeze manifest identity is invalid')
  }
  if (manifest.predecessorExposure?.protocol !== 'observable-authorization-v10') {
    throw new Error('freeze manifest is not bound to V10 exposure')
  }
  assertSha256(manifest.predecessorExposure.registrySha256, 'frozen V10 exposure registry digest')
  const actual = artifactRecords(artifacts)
  if (canonical(actual) !== canonical(manifest.artifacts)) throw new Error('frozen artifact digest mismatch')
  return manifest
}

export async function writeFreezeManifest(path, manifest) {
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  await writeExclusive(path, body)
  return { body, sha256: sha256(body) }
}

export async function runOneReveal({
  manifestText,
  expectedManifestDigest,
  artifacts,
  attemptPath,
  resultPath,
  failurePath,
  predict,
  score,
}) {
  if (typeof predict !== 'function' || typeof score !== 'function') {
    throw new Error('one reveal requires predict and score functions')
  }
  await assertArtifactsAbsent([attemptPath, resultPath, failurePath], 'V11 one reveal')
  let manifest
  try {
    const expectedDigest = assertSha256(expectedManifestDigest, 'expected freeze manifest digest')
    if (sha256(manifestText) !== expectedDigest) throw new Error('freeze manifest differs from its preregistered digest')
    manifest = JSON.parse(manifestText)
    verifyFreezeManifest(manifest, artifacts)
  } catch (error) {
    const failure = immutableFailure({
      protocol: manifest?.protocol ?? 'observable-authorization-v11',
      stage: 'pre-reveal-freeze-verification',
      error,
      bindings: { freezeManifestSha256: sha256(manifestText) },
    })
    await writeExclusive(failurePath, `${JSON.stringify(failure, null, 2)}\n`)
    throw error
  }

  const attempt = {
    schemaVersion: 1,
    protocol: manifest.protocol,
    evidenceStatus: 'one-reveal-consumed-before-router-execution',
    freezeManifestSha256: sha256(manifestText),
    routerCommit: manifest.routerCommit,
    artifactDigests: Object.fromEntries(Object.entries(manifest.artifacts).map(([name, value]) => [name, value.sha256])),
  }
  const attemptText = `${JSON.stringify(attempt, null, 2)}\n`
  await writeExclusive(attemptPath, attemptText)

  try {
    const predictions = await predict({
      prompts: artifactBody(artifacts.prompts, 'artifact prompts'),
      router: artifactBody(artifacts.router, 'artifact router'),
      runtime: artifactBody(artifacts.runtime, 'artifact runtime'),
      manifest,
    })
    const analysis = await score({
      predictions,
      labels: artifactBody(artifacts.labels, 'artifact labels'),
      sources: artifactBody(artifacts.sources, 'artifact sources'),
      manifest,
    })
    const result = {
      schemaVersion: 1,
      protocol: manifest.protocol,
      evidenceStatus: 'immutable-first-reveal',
      freezeManifestSha256: sha256(manifestText),
      revealAttemptSha256: sha256(attemptText),
      predictions,
      analysis,
    }
    await writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    const failure = {
      ...immutableFailure({
        protocol: manifest.protocol,
        stage: 'router-reveal',
        error,
        bindings: {
          freezeManifestSha256: sha256(manifestText),
          revealAttemptSha256: sha256(attemptText),
        },
      }),
      evidenceStatus: 'immutable-reveal-failure',
    }
    await writeExclusive(failurePath, `${JSON.stringify(failure, null, 2)}\n`)
    throw error
  }
}
