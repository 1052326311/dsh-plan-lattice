import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { canonical, sha256 } from './protocol.mjs'

export const externalVerificationProtocol = 'drand-bls-external-ed25519-attestation-v1'

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`, 'utf8')
}

function exactHex(value, bytes, context) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`, 'u').test(value)) {
    throw new Error(`${context} must be exactly ${bytes} lowercase hexadecimal bytes`)
  }
  return value
}

function parseBoundJson(bytes, context) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error(`${context} bytes are required`)
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    throw new Error(`${context} is not valid JSON`, { cause: error })
  }
}

export function buildExternalVerificationAttestation({ responseBytes, chainInfoBytes, spec, verifierId }) {
  const response = parseBoundJson(responseBytes, 'drand response')
  const chainInfo = parseBoundJson(chainInfoBytes, 'drand chain info')
  const signature = exactHex(response.signature, 96, 'drand signature')
  const previousSignature = exactHex(response.previous_signature, 96, 'drand previous signature')
  if (typeof verifierId !== 'string' || verifierId.trim() === '') throw new Error('external verifier ID is required')
  return {
    schemaVersion: 1,
    verificationProtocol: externalVerificationProtocol,
    verifierId: verifierId.trim(),
    chainHash: spec.selectionBeacon.chainHash,
    round: spec.selectionBeacon.round,
    roundTime: spec.selectionBeacon.roundTime,
    schemeID: chainInfo.schemeID,
    publicKey: chainInfo.public_key,
    responseSha256: sha256(Buffer.from(responseBytes)),
    chainInfoSha256: sha256(Buffer.from(chainInfoBytes)),
    signatureSha256: sha256(Buffer.from(signature, 'hex')),
    previousSignatureSha256: sha256(Buffer.from(previousSignature, 'hex')),
    randomness: response.randomness,
    blsSignatureVerified: true,
  }
}

export function externalAttestationBytes(attestation) {
  return canonicalBytes(attestation)
}

/**
 * Node does not expose BLS12-381 pairing verification. This API fails closed
 * unless a separately trusted Ed25519 key attests that an external verifier
 * checked the exact chained drand BLS response. The trust key must be frozen
 * outside both the response and `externalVerification`, and its digest belongs
 * in the enclosing protocol manifest.
 */
export function verifyDrandBeacon({
  responseBytes,
  chainInfoBytes,
  externalVerification,
  trustedVerifierPublicKey,
  spec,
  now = Date.now(),
}) {
  const response = parseBoundJson(responseBytes, 'drand response')
  const chainInfo = parseBoundJson(chainInfoBytes, 'drand chain info')
  const expected = spec?.selectionBeacon
  if (expected?.chainHash !== '8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce') {
    throw new Error('drand chain hash is not the frozen mainnet chain')
  }
  if (expected.round !== 6391766 || expected.roundTime !== '2026-08-20T00:00:00Z') {
    throw new Error('drand round identity or expected round time changed')
  }
  if (chainInfo.hash !== expected.chainHash
    || chainInfo.schemeID !== 'pedersen-bls-chained'
    || chainInfo.metadata?.beaconID !== 'default') {
    throw new Error('drand chain info does not identify the frozen mainnet beacon')
  }
  exactHex(chainInfo.public_key, 48, 'drand public key')
  if (!Number.isInteger(chainInfo.period) || chainInfo.period <= 0 || !Number.isInteger(chainInfo.genesis_time)) {
    throw new Error('drand chain timing metadata is invalid')
  }
  const computedRoundTimeMs = (chainInfo.genesis_time + (expected.round - 1) * chainInfo.period) * 1000
  if (!Number.isFinite(Date.parse(expected.roundTime)) || computedRoundTimeMs !== Date.parse(expected.roundTime)) {
    throw new Error('drand chain timing does not produce the frozen round time')
  }
  if (!Number.isFinite(now) || now < computedRoundTimeMs) throw new Error('drand beacon round is not yet available')
  if (response.round !== expected.round) throw new Error('drand response round mismatch')
  const signature = exactHex(response.signature, 96, 'drand signature')
  exactHex(response.previous_signature, 96, 'drand previous signature')
  const randomness = exactHex(response.randomness, 32, 'drand randomness')
  if (sha256(Buffer.from(signature, 'hex')) !== randomness) {
    throw new Error('drand signature/randomness consistency check failed')
  }

  if (externalVerification?.protocol !== externalVerificationProtocol
    || externalVerification.attestation === null
    || typeof externalVerification?.attestation !== 'object'
    || typeof externalVerification.signatureBase64 !== 'string'
    || trustedVerifierPublicKey === undefined) {
    throw new Error('digest-bound external BLS verification is required')
  }
  const expectedAttestation = buildExternalVerificationAttestation({
    responseBytes,
    chainInfoBytes,
    spec,
    verifierId: externalVerification.attestation.verifierId,
  })
  if (JSON.stringify(canonical(externalVerification.attestation)) !== JSON.stringify(canonical(expectedAttestation))) {
    throw new Error('external BLS attestation is not bound to the exact drand response')
  }
  let publicKey
  try {
    publicKey = trustedVerifierPublicKey?.type === 'public'
      ? trustedVerifierPublicKey
      : createPublicKey(trustedVerifierPublicKey)
  } catch (error) {
    throw new Error('trusted external verifier public key is invalid', { cause: error })
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('external verifier trust key must be Ed25519')
  const signatureBytes = Buffer.from(externalVerification.signatureBase64, 'base64')
  if (signatureBytes.length !== 64
    || signatureBytes.toString('base64') !== externalVerification.signatureBase64
    || !verifySignature(null, externalAttestationBytes(expectedAttestation), publicKey, signatureBytes)) {
    throw new Error('external BLS verification attestation signature is invalid')
  }
  return {
    schemaVersion: 1,
    evidenceStatus: 'verified-drand-beacon',
    provider: 'drand-mainnet',
    chainHash: expected.chainHash,
    round: expected.round,
    roundTime: expected.roundTime,
    randomness,
    responseSha256: expectedAttestation.responseSha256,
    chainInfoSha256: expectedAttestation.chainInfoSha256,
    externalAttestationDigest: sha256(externalAttestationBytes(expectedAttestation)),
    externalVerifierId: expectedAttestation.verifierId,
    trustedVerifierPublicKeySha256: sha256(publicKey.export({ format: 'der', type: 'spki' })),
  }
}
