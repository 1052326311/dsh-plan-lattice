import { createHash } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ContractRecord } from './contract.js'

const INPUT_REVIEW_MARKER_PREFIX = '[plan-lattice/input-review] '

export interface InputReviewMarker {
  throughSeq: number
  messageIds: string[]
  pendingDigest: string
  disposition: 'contract-unchanged' | 'contract-changed' | 'contract-reframed'
  rationale: string
  contractId: string
  contractRevision: number
  contractDigest: string
}

export interface PendingUserInput {
  seq: number
  messageId: string
  digest: string
  content: UserMessage['content']
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function userInputDigest(message: UserMessage): string {
  return sha256(JSON.stringify({ id: message.id, content: message.content, source: message.source }))
}

function isHumanInput(event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.data.source.kind === 'user'
}

function assertMarker(value: unknown, seq: number): InputReviewMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid durable Plan Lattice input-review marker')
  }
  const marker = value as InputReviewMarker
  if (!Number.isSafeInteger(marker.throughSeq) || marker.throughSeq < -1 || marker.throughSeq >= seq) {
    throw new Error('invalid durable Plan Lattice input-review boundary')
  }
  if (!Array.isArray(marker.messageIds) || marker.messageIds.some(id => typeof id !== 'string' || id.length === 0)) {
    throw new Error('invalid durable Plan Lattice input-review message ids')
  }
  if (typeof marker.pendingDigest !== 'string' || !/^[0-9a-f]{64}$/.test(marker.pendingDigest)) {
    throw new Error('invalid durable Plan Lattice input-review digest')
  }
  if (marker.disposition !== 'contract-unchanged'
    && marker.disposition !== 'contract-changed'
    && marker.disposition !== 'contract-reframed') {
    throw new Error('invalid durable Plan Lattice input-review disposition')
  }
  if (typeof marker.rationale !== 'string' || marker.rationale.trim().length === 0
    || typeof marker.contractId !== 'string' || marker.contractId.length === 0
    || !Number.isSafeInteger(marker.contractRevision) || marker.contractRevision < 1
    || typeof marker.contractDigest !== 'string' || !/^[0-9a-f]{64}$/.test(marker.contractDigest)) {
    throw new Error('invalid durable Plan Lattice input-review contract binding')
  }
  return marker
}

export function inputReviewMarkerMessage(marker: InputReviewMarker) {
  return createUserMessage({
    content: [{ type: 'text', text: `${INPUT_REVIEW_MARKER_PREFIX}${JSON.stringify(marker)}` }],
    source: {
      kind: 'plugin',
      plugin: 'plan-lattice',
      form: 'notice',
      summary: 'Plan Lattice recorded an input-review boundary.',
    },
  })
}

function markerFromEvent(event: SessionEvent): InputReviewMarker | undefined {
  if (event.type !== 'user/message'
    || event.data.source.kind !== 'plugin'
    || event.data.source.plugin !== 'plan-lattice'
    || event.data.source.form !== 'notice') return undefined
  const content = event.data.content
  if (content.length !== 1 || content[0]?.type !== 'text' || !content[0].text.startsWith(INPUT_REVIEW_MARKER_PREFIX)) return undefined
  try {
    return assertMarker(JSON.parse(content[0].text.slice(INPUT_REVIEW_MARKER_PREFIX.length)), event.seq)
  } catch (error) {
    throw error instanceof Error ? error : new Error('invalid durable Plan Lattice input-review marker')
  }
}

function currentReviewBoundary(events: readonly SessionEvent[], contract: ContractRecord): number | undefined {
  let boundary: number | undefined
  for (const event of events) {
    const marker = markerFromEvent(event)
    if (marker === undefined) continue
    if (marker.contractId !== contract.id
      || marker.contractRevision !== contract.revision
      || marker.contractDigest !== contract.documentDigest) continue
    boundary = Math.max(boundary ?? -1, marker.throughSeq)
  }
  return boundary
}

export function pendingUserInputs(events: readonly SessionEvent[], contract: ContractRecord): PendingUserInput[] {
  const boundary = currentReviewBoundary(events, contract)
  const updatedAt = Date.parse(contract.updatedAt)
  if (!Number.isFinite(updatedAt)) throw new Error('execution contract has an invalid updatedAt timestamp')
  return events.filter(isHumanInput).filter(event => (
    boundary === undefined ? event.time > updatedAt : event.seq > boundary
  )).map(event => ({
    seq: event.seq,
    messageId: String(event.data.id),
    digest: userInputDigest(event.data),
    content: event.data.content,
  }))
}

export function allHumanUserInputs(events: readonly SessionEvent[]): PendingUserInput[] {
  return events.filter(isHumanInput).map(event => ({
    seq: event.seq,
    messageId: String(event.data.id),
    digest: userInputDigest(event.data),
    content: event.data.content,
  }))
}

export function pendingUserInputDigest(inputs: readonly PendingUserInput[]): string {
  return sha256(JSON.stringify(inputs.map(input => ({
    seq: input.seq,
    messageId: input.messageId,
    digest: input.digest,
  }))))
}

export function humanInputBoundary(events: readonly SessionEvent[]): { throughSeq: number; messageIds: string[] } {
  const inputs = events.filter(isHumanInput)
  return {
    throughSeq: inputs.at(-1)?.seq ?? -1,
    messageIds: inputs.map(event => String(event.data.id)),
  }
}
