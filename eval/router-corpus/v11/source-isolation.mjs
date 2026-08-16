#!/usr/bin/env node

import {
  assertSourceDisjoint as assertV10SourceDisjoint,
  canonicalPrompt,
  fiveShingles,
  normalizeRepository,
  normalizeUrl,
  priorSourceInventory,
  shingleJaccard,
} from '../v10/source-isolation.mjs'
import { exposureMatch } from './exposure-registry.mjs'

export {
  canonicalPrompt,
  fiveShingles,
  normalizeRepository,
  normalizeUrl,
  priorSourceInventory,
  shingleJaccard,
}

export function assertSourceDisjoint(rows, priorInventory, exposures) {
  assertV10SourceDisjoint(rows, priorInventory)
  for (const row of rows) {
    const match = exposureMatch(row, exposures)
    if (match !== undefined) {
      throw new Error(`V11 reuses a V10-exposed source by ${match}: ${row.sourceFamilyId ?? row.nodeId ?? row.url}`)
    }
  }
  return true
}
