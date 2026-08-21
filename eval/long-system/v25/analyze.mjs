#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson } from '../../v0.4/lib/canonical.mjs'
import { analyzeV25 } from './analysis.mjs'

const inputIndex = process.argv.indexOf('--input')
const configuredInput = inputIndex === -1
  ? process.env.PLAN_LATTICE_LONG_SYSTEM_V25_OUTPUT ?? ''
  : process.argv[inputIndex + 1] ?? ''
if (configuredInput.length === 0) {
  throw new Error('--input <v25-report.json> or PLAN_LATTICE_LONG_SYSTEM_V25_OUTPUT is required')
}

const report = JSON.parse(await readFile(resolve(configuredInput), 'utf8'))
const analysis = analyzeV25(report)
process.stdout.write(canonicalJson(analysis))
process.exitCode = analysis.releaseAllowed ? 0 : 3
