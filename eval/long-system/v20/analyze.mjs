#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson } from '../../v0.4/lib/canonical.mjs'
import { analyzeV20Pair } from './analysis.mjs'
import { verifyV20Manifest } from './freeze.mjs'

const inputIndex = process.argv.indexOf('--input')
const input = resolve(inputIndex === -1
  ? process.env.PLAN_LATTICE_LONG_SYSTEM_V20_OUTPUT ?? ''
  : process.argv[inputIndex + 1] ?? '')
if (input === resolve('')) throw new Error('--input <paired-report.json> or PLAN_LATTICE_LONG_SYSTEM_V20_OUTPUT is required')

const manifest = await verifyV20Manifest()
const report = JSON.parse(await readFile(input, 'utf8'))
if (report?.schemaVersion !== 1
  || report.protocolId !== manifest.protocolId
  || report.frozenManifestDigest !== manifest.manifestDigest
  || !Array.isArray(report.attempts)) {
  throw new Error('V20 paired report does not match the frozen protocol')
}
const analysis = analyzeV20Pair({ manifest, attempts: report.attempts })
process.stdout.write(canonicalJson(analysis))
process.exitCode = analysis.releaseAllowed ? 0 : 3
