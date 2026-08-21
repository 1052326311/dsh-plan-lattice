#!/usr/bin/env node

import { resolve } from 'node:path'
import { canonicalJson } from '../../v0.4/lib/canonical.mjs'
import { FROZEN_MANIFEST_PATH } from './manifest.mjs'
import { verifyV27ReportFile } from './report-verifier.mjs'

const inputIndex = process.argv.indexOf('--input')
const configuredInput = inputIndex === -1
  ? process.env.PLAN_LATTICE_LONG_SYSTEM_V27_OUTPUT ?? ''
  : process.argv[inputIndex + 1] ?? ''
if (configuredInput.length === 0) {
  throw new Error('--input <v27-report.json> or PLAN_LATTICE_LONG_SYSTEM_V27_OUTPUT is required')
}

const manifestIndex = process.argv.indexOf('--manifest')
const manifestPath = manifestIndex === -1 ? FROZEN_MANIFEST_PATH : resolve(process.argv[manifestIndex + 1] ?? '')
const analysis = await verifyV27ReportFile({ reportPath: resolve(configuredInput), manifestPath })
process.stdout.write(canonicalJson(analysis))
process.exitCode = analysis.releaseAllowed ? 0 : 3
