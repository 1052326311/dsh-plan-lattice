import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`
}

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value)
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export function seededRandom(seed) {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export function deterministicShuffle(values, seed) {
  const result = [...values]
  const random = seededRandom(seed)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}
