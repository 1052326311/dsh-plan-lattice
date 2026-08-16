import { computeAgreement } from '../v7/agreement.mjs'
import { validateAnnotation } from '../v10/annotation-schema.mjs'
import { deriveLabel } from '../v10/derive-label.mjs'
import {
  createAdjudicationPacket,
  createIsolatedAnnotationPackets,
  resolveAdjudication,
  restoreAnnotationSets,
  verifyAgreementGate,
} from '../v11/annotation-pipeline.mjs'
import { canonical, sha256, stableLines } from './protocol.mjs'

export const annotatorNames = ['annotator-a', 'annotator-b', 'annotator-c']
export const annotationRandomizationSeed = 'plan-lattice-v12-isolated-annotation-order'
export const adjudicationRandomizationSeed = 'plan-lattice-v12-adjudication-options'

export function createAnnotationCandidates(frame) {
  const candidates = frame.map(row => ({
    id: `v12-${sha256(row.stableSourceId).slice(0, 20)}`,
    language: row.language,
    text: row.text,
  })).sort((left, right) => left.id.localeCompare(right.id))
  if (new Set(candidates.map(row => row.id)).size !== candidates.length) throw new Error('V12 annotation candidate ID collision')
  return candidates
}

export function createV12AnnotationPackets(candidates) {
  return createIsolatedAnnotationPackets({
    candidates,
    annotators: annotatorNames,
    randomizationSeed: annotationRandomizationSeed,
  })
}

function metricGate(metric, { kappa, ac1, unanimous, pairwise }) {
  return {
    kappa: metric.fleissKappa.kappa >= kappa,
    ac1: metric.gwetAc1.ac1 >= ac1,
    unanimous: metric.unanimous.rate >= unanimous,
    pairwise: metric.pairwiseConfusions.every(value => value.exact.rate >= pairwise),
  }
}

export function buildV12AgreementReport(candidates, annotationSets, digests, gates) {
  const agreement = computeAgreement(candidates, annotationSets)
  const route = metricGate(agreement.route, {
    kappa: gates.routeKappaMin,
    ac1: gates.routeAc1Min,
    unanimous: gates.routeUnanimousMin,
    pairwise: gates.pairwiseExactMin,
  })
  const outcomeCritical = metricGate(agreement.outcomeCritical, {
    kappa: gates.routeKappaMin,
    ac1: gates.routeAc1Min,
    unanimous: gates.routeUnanimousMin,
    pairwise: gates.pairwiseExactMin,
  })
  const primitives = Object.fromEntries(Object.entries(agreement.primitives).map(([field, value]) => [
    field,
    metricGate(value, {
      kappa: gates.primitiveKappaMin,
      ac1: gates.primitiveAc1Min,
      unanimous: gates.primitiveUnanimousMin,
      pairwise: gates.pairwiseExactMin,
    }),
  ]))
  return {
    schemaVersion: 1,
    protocol: 'observable-authorization-v12',
    counts: { candidates: candidates.length, annotators: annotationSets.length },
    thresholds: gates,
    agreement,
    gates: {
      route,
      outcomeCritical,
      primitives,
      allPassed: [route, outcomeCritical, ...Object.values(primitives)]
        .every(value => Object.values(value).every(Boolean)),
    },
    digests,
  }
}

export function restoreV12AnnotationSets({ candidates, mappings, annotations }) {
  return restoreAnnotationSets({ candidates, annotators: annotatorNames, mappings, annotations, validateAnnotation })
}

export function verifyV12Agreement({ candidates, annotationSets, agreementReport, gates }) {
  return verifyAgreementGate({
    candidates,
    annotationSets,
    agreementReport,
    buildAgreementReport: (rows, sets, digests) => buildV12AgreementReport(rows, sets, digests, gates),
  })
}

export function createV12AdjudicationPacket({ candidates, annotationSets, agreementReport, gates }) {
  return createAdjudicationPacket({
    candidates,
    annotationSets,
    agreementReport,
    buildAgreementReport: (rows, sets, digests) => buildV12AgreementReport(rows, sets, digests, gates),
    optionRandomizationSeed: adjudicationRandomizationSeed,
  })
}

export function resolveV12Adjudication({ candidates, annotationSets, packet, decisions }) {
  return resolveAdjudication({ candidates, annotationSets, packet, decisions, deriveLabel })
}

export function agreementDigests(candidates, annotationSets) {
  return {
    candidates: sha256(stableLines(candidates)),
    annotations: annotationSets.map((set, index) => ({
      annotator: index + 1,
      sha256: sha256(stableLines(candidates.map(candidate => {
        const { derived: _derived, ...annotation } = set.get(candidate.id)
        return annotation
      }))),
    })),
  }
}

export function assertAgreementReport(actual, expected) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) throw new Error('V12 agreement report differs from frozen inputs')
  return actual
}
