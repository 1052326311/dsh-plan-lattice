import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { TextDecoder } from 'node:util'
import { createGunzip } from 'node:zlib'
import { ProtocolFailure } from './protocol.mjs'

function failure(failureClass, message, stage, operation, details) {
  return new ProtocolFailure(failureClass, message, { stage, operation, details })
}

function asProtocolFailure(error, failureClass, message, stage, operation) {
  if (error instanceof ProtocolFailure) return error
  return failure(failureClass, `${message}: ${error?.message ?? String(error)}`, stage, operation)
}

function requiredMetadata(response, spec, hour) {
  const headers = {}
  for (const name of spec.archive.requiredHeaders) {
    const value = response.headers.get(name)
    if (typeof value !== 'string' || value.trim() === '') {
      throw failure('archive-metadata-incomplete', `${hour} is missing required response header ${name}`, 'archive-acquisition', hour)
    }
    headers[name] = value
  }
  const contentLength = Number(headers['content-length'])
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || String(contentLength) !== headers['content-length'].trim()) {
    throw failure('archive-content-length-invalid', `${hour} has invalid content-length`, 'archive-acquisition', hour)
  }
  if (contentLength > spec.archive.maximumCompressedBytesPerHour) {
    throw failure('archive-object-oversized', `${hour} exceeds the frozen compressed-byte limit`, 'archive-acquisition', hour, {
      contentLength,
      maximum: spec.archive.maximumCompressedBytesPerHour,
    })
  }
  const contentEncoding = response.headers.get('content-encoding')
  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== 'identity') {
    throw failure('archive-content-encoding-invalid', `${hour} was not served with identity content encoding`, 'archive-acquisition', hour, {
      contentEncoding,
    })
  }
  return { headers, contentLength }
}

export async function downloadRawArchive({ hour, spec, destination, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw failure('archive-fetch-unavailable', 'fetch implementation is unavailable', 'archive-acquisition', hour)
  }
  const url = `${spec.archive.baseUrl}/${hour}.json.gz`
  let response
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      headers: { accept: 'application/gzip', 'accept-encoding': 'identity' },
    })
  } catch (error) {
    throw asProtocolFailure(error, 'archive-download-failed', `${hour} download failed`, 'archive-acquisition', hour)
  }
  if (response?.ok !== true || response.status !== 200 || response.body === null) {
    throw failure('archive-download-failed', `${hour} returned HTTP ${response?.status ?? '<missing>'}`, 'archive-acquisition', hour)
  }
  const { headers, contentLength } = requiredMetadata(response, spec, hour)
  const hash = createHash('sha256')
  let compressedBytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      if (compressedBytes > spec.archive.maximumCompressedBytesPerHour) {
        callback(failure('archive-object-oversized', `${hour} exceeded the frozen byte limit while downloading`, 'archive-acquisition', hour))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
    if (compressedBytes !== contentLength) {
      throw failure('archive-byte-count-mismatch', `${hour} compressed byte count differs from content-length`, 'archive-acquisition', hour, {
        contentLength,
        compressedBytes,
      })
    }
    return { hour, url, headers, compressedBytes, compressedSha256: hash.digest('hex') }
  } catch (error) {
    await unlink(destination).catch(unlinkError => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError
    })
    throw asProtocolFailure(error, 'archive-download-stream-failed', `${hour} raw download could not be retained`, 'archive-acquisition', hour)
  }
}

export async function verifyRawArchiveFile({ path, expectedLength, expectedSha256, maximumLength, hour }) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0
    || !Number.isSafeInteger(maximumLength) || expectedLength > maximumLength
    || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) {
    throw failure('archive-manifest-record-invalid', `${hour} has invalid frozen byte metadata`, 'archive-cache-verification', hour)
  }
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    throw asProtocolFailure(error, 'archive-cache-file-unavailable', `${hour} content-addressed archive is unavailable`, 'archive-cache-verification', hour)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw failure('archive-cache-file-invalid', `${hour} content-addressed archive is not a regular file`, 'archive-cache-verification', hour)
  }
  if (metadata.size !== expectedLength) {
    throw failure('archive-cache-length-mismatch', `${hour} cached length differs from the raw archive manifest`, 'archive-cache-verification', hour, {
      expectedLength,
      actualLength: metadata.size,
    })
  }
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length
      if (bytes > maximumLength) {
        throw failure('archive-object-oversized', `${hour} cached archive exceeds the frozen byte limit`, 'archive-cache-verification', hour)
      }
      hash.update(chunk)
    }
  } catch (error) {
    throw asProtocolFailure(error, 'archive-cache-read-failed', `${hour} cached archive could not be verified`, 'archive-cache-verification', hour)
  }
  const compressedSha256 = hash.digest('hex')
  if (bytes !== expectedLength || compressedSha256 !== expectedSha256) {
    throw failure('archive-cache-digest-mismatch', `${hour} cached bytes differ from the raw archive manifest`, 'archive-cache-verification', hour, {
      expectedLength,
      actualLength: bytes,
      expectedSha256,
      actualSha256: compressedSha256,
    })
  }
  return { compressedBytes: bytes, compressedSha256 }
}

function decoderFailure(hour, lineNumber, error) {
  return failure('archive-utf8-invalid', `${hour}:${lineNumber} is not valid UTF-8: ${error?.message ?? String(error)}`, 'archive-parse', `${hour}:${lineNumber}`)
}

export async function consumeGzipJsonLines({ stream, expectedLength, expectedSha256, maximumLength, hour, onRecord }) {
  if (typeof onRecord !== 'function') {
    throw failure('archive-record-handler-invalid', 'onRecord must be a function', 'archive-decompression', hour)
  }
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0
    || !Number.isSafeInteger(maximumLength) || expectedLength > maximumLength
    || !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) {
    throw failure('archive-manifest-record-invalid', `${hour} has invalid frozen byte metadata`, 'archive-decompression', hour)
  }
  const hash = createHash('sha256')
  let compressedBytes = 0
  let lineNumber = 0
  let recordCount = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      compressedBytes += chunk.length
      if (compressedBytes > maximumLength) {
        callback(failure('archive-object-oversized', `${hour} exceeded the frozen byte limit while parsing`, 'archive-decompression', hour))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  const gunzip = createGunzip()
  let pending = ''

  async function consumeLine(rawLine) {
    lineNumber += 1
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) {
      throw failure('archive-jsonl-empty-line', `${hour}:${lineNumber} is an empty JSONL record`, 'archive-parse', `${hour}:${lineNumber}`)
    }
    let event
    try {
      event = JSON.parse(line)
    } catch {
      throw failure('archive-jsonl-invalid', `${hour}:${lineNumber} is not valid JSON`, 'archive-parse', `${hour}:${lineNumber}`)
    }
    try {
      await onRecord(event, lineNumber)
    } catch (error) {
      throw asProtocolFailure(error, 'archive-record-handler-failed', `${hour}:${lineNumber} record handler failed`, 'archive-parse', `${hour}:${lineNumber}`)
    }
    recordCount += 1
  }

  try {
    const decoded = stream.pipe(meter).pipe(gunzip)
    for await (const chunk of decoded) {
      let text
      try {
        text = decoder.decode(chunk, { stream: true })
      } catch (error) {
        throw decoderFailure(hour, lineNumber + 1, error)
      }
      pending += text
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        await consumeLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    try {
      pending += decoder.decode()
    } catch (error) {
      throw decoderFailure(hour, lineNumber + 1, error)
    }
    if (pending.length > 0) await consumeLine(pending)
  } catch (error) {
    throw asProtocolFailure(error, 'archive-decompression-failed', `${hour} gzip stream could not be consumed`, 'archive-decompression', hour)
  }

  const compressedSha256 = hash.digest('hex')
  if (compressedBytes !== expectedLength || compressedSha256 !== expectedSha256) {
    throw failure('archive-frozen-bytes-mismatch', `${hour} differs from the published raw archive manifest`, 'archive-decompression', hour, {
      expectedLength,
      compressedBytes,
      expectedSha256,
      compressedSha256,
    })
  }
  return { compressedBytes, compressedSha256, recordCount }
}

export function consumeArchiveFile({ path, ...options }) {
  return consumeGzipJsonLines({ stream: createReadStream(path), ...options })
}
