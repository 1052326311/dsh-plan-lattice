/**
 * Fractal Ledger: an evidence-gated recursive work graph for long-horizon agents.
 *
 * A lattice is deliberately not another todo list. Structural mutations and
 * execution leases are accepted only after the configured project contract has
 * been read in full and its current digest has been proven again.
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  assertBranchingCapacity,
  assertExpectedRevision,
  assertMutable,
  assertText,
  completeAndCollapse,
  createNode,
  findNode,
  isLeaf,
  LATTICE_SCHEMA_VERSION,
  nodeChildren,
  projectStatus,
  type LatticeDelta,
  type LatticeNode,
  type LatticeReceipt,
  type LatticeState,
} from './domain.js'
import { issueReceipt, readProjectContext, validateContextPaths } from './context.js'
import { LatticeStore } from './store.js'

export const name = 'plan-lattice'
export const inject = ['tools']

export interface Config {
  /** Tools that cannot run without an active, synchronized lattice leaf. */
  guardedTools?: string[]
  /** Include all bash calls in the guard; commands cannot be reliably classified as read-only. */
  strictBash?: boolean
  /** Maximum combined byte size of the full context contract rendered to the agent. */
  maxContextBytes?: number
  /** At most this many root nodes may exist at once. */
  topLevelLimit?: number
  /** At most this many non-root children may exist at once. */
  nestedLimit?: number
  /** Number of deltas between materialized snapshots. */
  snapshotEvery?: number
}

interface ResolvedConfig {
  guardedTools: Set<string>
  maxContextBytes: number
  topLevelLimit: number
  nestedLimit: number
  snapshotEvery: number
}

interface ExecutionLease {
  workspace: string
  nodeId: string
  revision: number
  dirty: boolean
}

interface AgentLike {
  session: {
    id: unknown
    header: { cwd?: string }
  }
}

/** The Harness validates every tool value at runtime; this boundary keeps the domain types isolated. */
function json(value: unknown): never {
  return value as never
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${field} must be a positive safe integer`)
  return resolved
}

function resolveConfig(config: Config): ResolvedConfig {
  const guardedTools = new Set(config.guardedTools ?? ['write', 'edit', 'str_replace_editor'])
  if (config.strictBash === true) guardedTools.add('bash')
  for (const tool of guardedTools) {
    if (tool.trim().length === 0) throw new Error('guardedTools must not contain an empty name')
  }
  return {
    guardedTools,
    maxContextBytes: positiveInteger(config.maxContextBytes, 256 * 1024, 'maxContextBytes'),
    topLevelLimit: positiveInteger(config.topLevelLimit, 2, 'topLevelLimit'),
    nestedLimit: positiveInteger(config.nestedLimit, 5, 'nestedLimit'),
    snapshotEvery: positiveInteger(config.snapshotEvery, 1024, 'snapshotEvery'),
  }
}

function statusNodeLimit(value: number | undefined): number {
  const limit = positiveInteger(value, 16, 'maxNodes')
  if (limit > 64) throw new Error('maxNodes must not exceed 64')
  return limit
}

function sessionKey(agent: AgentLike): string {
  return String(agent.session.id)
}

async function workspaceFor(agent: AgentLike | undefined): Promise<string> {
  if (agent === undefined) throw new Error('plan lattice tools require an owning agent session')
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('plan lattice tools require a session workspace')
  return realpath(cwd)
}

function renderSummary(value: unknown): { type: 'text'; text: string }[] {
  const record = value as { message?: unknown }
  return [{ type: 'text', text: typeof record.message === 'string' ? record.message : 'Plan lattice updated.' }]
}

function renderContext(value: unknown): { type: 'text'; text: string }[] {
  const record = value as { message?: unknown; documents?: { path: string; digest: string; content: string }[] }
  const heading = typeof record.message === 'string' ? record.message : 'Read the current project context.'
  const documents = record.documents ?? []
  return [{
    type: 'text',
    text: `${heading}\n\n${documents.map(document => (
      `--- ${document.path} (sha256:${document.digest}) ---\n${document.content}`
    )).join('\n\n')}`,
  }]
}

function delta(state: LatticeState, upserts: LatticeNode[], includeProject = false): LatticeDelta {
  return {
    revision: state.revision,
    ...(includeProject ? { project: state.project } : {}),
    upserts,
  }
}

/** Install the tool surface and the execution gate. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const store = new LatticeStore({ snapshotEvery: resolved.snapshotEvery })
  const receipts = new Map<string, LatticeReceipt>()
  const leases = new Map<string, ExecutionLease>()

  function clearWorkspace(workspace: string): void {
    for (const [key, receipt] of receipts) if (receipt.workspace === workspace) receipts.delete(key)
    for (const [key, lease] of leases) if (lease.workspace === workspace) leases.delete(key)
  }

  function ensureNoActiveLease(workspace: string): void {
    for (const lease of leases.values()) {
      if (lease.workspace === workspace) {
        throw new Error(`node ${JSON.stringify(lease.nodeId)} is checked out; checkpoint it before changing the plan`)
      }
    }
  }

  async function issueCurrentReceipt(agent: AgentLike, workspace: string, state: LatticeState): Promise<{
    receipt: LatticeReceipt
    documents: Awaited<ReturnType<typeof readProjectContext>>['documents']
  }> {
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    const receipt = issueReceipt(workspace, state, context)
    receipts.set(sessionKey(agent), receipt)
    return { receipt, documents: context.documents }
  }

  async function requireFreshReceipt(
    agent: AgentLike,
    workspace: string,
    receiptId: string,
    expectedRevision: number,
  ): Promise<LatticeState> {
    const state = await store.peek(workspace)
    if (state === undefined) throw new Error('no lattice exists for this workspace')
    assertExpectedRevision(state, expectedRevision)
    const receipt = receipts.get(sessionKey(agent))
    if (receipt === undefined || receipt.id !== receiptId) {
      throw new Error('context receipt is missing, expired, or belongs to another session; call lattice_refresh_context')
    }
    if (receipt.workspace !== workspace || receipt.revision !== state.revision) {
      throw new Error('context receipt is stale; call lattice_refresh_context')
    }
    // Every structural action reads the full contract again. A matching token
    // alone is intentionally insufficient after a document changes on disk.
    const context = await readProjectContext(workspace, state.project.contextPaths, resolved.maxContextBytes)
    if (context.digest !== receipt.digest) {
      throw new Error('project context changed after the receipt; call lattice_refresh_context and reconsider the mutation')
    }
    return state
  }

  ctx.tools.guard(exec => {
    if (!resolved.guardedTools.has(exec.name)) return undefined
    if (exec.agent === undefined) return `plan-lattice blocks ${exec.name}: no owning agent can hold a lattice lease`
    const lease = leases.get(sessionKey(exec.agent))
    if (lease === undefined) return `plan-lattice blocks ${exec.name}: check out one current leaf first`
    if (lease.dirty) return `plan-lattice blocks ${exec.name}: checkpoint the previous guarded action first`
    if (lease.revision < 1) return `plan-lattice blocks ${exec.name}: refresh the project context first`
    return undefined
  })

  ctx.on('tools/result', (exec, result) => {
    if (result.isError || exec.agent === undefined || !resolved.guardedTools.has(exec.name)) return
    const lease = leases.get(sessionKey(exec.agent))
    if (lease !== undefined) lease.dirty = true
  })

  ctx.tools.register(defineTool({
    name: 'lattice_open',
    description: 'Create the workspace-local evidence-gated work graph. A full context contract is read and rendered before the first root node may be added.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short project title.' },
      objective: { type: 'string', required: true, description: 'The durable outcome this lattice must preserve.' },
      contextPaths: {
        type: 'array',
        required: true,
        description: 'Every workspace-relative background, product, or architecture document required for future plan changes.',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const contextPaths = validateContextPaths(args.contextPaths)
      const context = await readProjectContext(workspace, contextPaths, resolved.maxContextBytes)
      const now = Date.now()
      const state: LatticeState = {
        schemaVersion: LATTICE_SCHEMA_VERSION,
        revision: 1,
        project: {
          title: assertText(args.title, 'title'),
          objective: assertText(args.objective, 'objective'),
          contextPaths,
          createdAt: now,
          updatedAt: now,
        },
        nodes: {},
      }
      await store.create(workspace, state, undefined)
      const receipt = issueReceipt(workspace, state, context)
      receipts.set(sessionKey(exec.agent!), receipt)
      return json({
        message: `Opened lattice revision ${state.revision}. Context is complete and current; create no more than ${resolved.topLevelLimit} root nodes before executing.`,
        project: state.project,
        receipt,
        documents: context.documents,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_status',
    description: 'Read a bounded durable graph summary and unfinished frontier without reinjecting the entire ledger into context.',
    parameters: {
      nodeId: { type: 'string', description: 'Optional node whose direct children should be inspected.' },
      maxNodes: { type: 'integer', description: 'Maximum frontier or child summaries to return, from 1 to 64. Defaults to 16.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const state = await store.peek(workspace)
      if (state === undefined) return json({ message: 'No lattice exists for this workspace.', state: null })
      const active = exec.agent === undefined ? undefined : leases.get(sessionKey(exec.agent))
      const status = projectStatus(state, { nodeId: args.nodeId, maxNodes: statusNodeLimit(args.maxNodes) })
      const liveNodes = status.counts.pending + status.counts.active + status.counts.blocked + status.counts.complete
      return json({
        message: `Lattice revision ${state.revision}: ${liveNodes} live nodes; returning ${status.frontier.nodes.length} of ${status.frontier.total} actionable frontier nodes.`,
        status,
        ...(active === undefined ? {} : { lease: { nodeId: active.nodeId, dirty: active.dirty } }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_refresh_context',
    description: 'Read every document in the current project context contract in full and issue one revision-bound freshness receipt. Use it before any structural change or after external project facts change.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderContext },
    async execute(_args, exec) {
      const workspace = await workspaceFor(exec.agent)
      const state = await store.peek(workspace)
      if (state === undefined) throw new Error('no lattice exists for this workspace')
      const issued = await issueCurrentReceipt(exec.agent!, workspace, state)
      return json({
        message: `Read ${issued.documents.length} complete context documents for lattice revision ${state.revision}.`,
        receipt: issued.receipt,
        documents: issued.documents,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_add',
    description: 'Add one pending node after re-reading the full project context. Root nodes are capped at two and nested nodes at five by default.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh receipt returned by lattice_open or lattice_refresh_context.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision observed with the receipt.' },
      parentId: { type: 'string', description: 'Parent node id. Omit only for a root node.' },
      title: { type: 'string', required: true, description: 'Concrete child outcome.' },
      acceptanceCriteria: { type: 'string', required: true, description: 'Observable proof required before completion.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'add', state => {
        assertExpectedRevision(state, args.expectedRevision)
        if (args.parentId !== undefined) assertMutable(findNode(state, args.parentId))
        assertBranchingCapacity(state, args.parentId, 1, resolved.topLevelLimit, resolved.nestedLimit)
        const node = createNode({ parentId: args.parentId, title: args.title, acceptanceCriteria: args.acceptanceCriteria, now: Date.now() })
        state.nodes[node.id] = node
        state.revision += 1
        state.project.updatedAt = Date.now()
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Added node ${result.node.id} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_split',
    description: 'Replace a pending leaf with two to five smaller pending children after re-reading the complete project context. This is recursive decomposition, not parallel execution.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Pending leaf to decompose.' },
      children: {
        type: 'array',
        required: true,
        description: 'Two to five atomic children, each with an observable acceptance criterion.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            acceptanceCriteria: { type: 'string', required: true },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      if (args.children.length < 2) throw new Error('lattice_split requires at least two children')
      const result = await store.mutate(workspace, 'split', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const parent = findNode(state, args.nodeId)
        assertMutable(parent)
        if (!isLeaf(state, parent.id)) throw new Error('only a leaf can be split')
        assertBranchingCapacity(state, parent.id, args.children.length, resolved.topLevelLimit, resolved.nestedLimit)
        const now = Date.now()
        parent.status = 'active'
        parent.updatedAt = now
        const children = args.children.map(child => createNode({ parentId: parent.id, title: child.title, acceptanceCriteria: child.acceptanceCriteria, now }))
        for (const child of children) state.nodes[child.id] = child
        state.revision += 1
        state.project.updatedAt = now
        return { value: { children, revision: state.revision }, delta: delta(state, [parent, ...children], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Split node ${args.nodeId} into ${result.children.length} children at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        children: result.children,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_update',
    description: 'Edit one unfinished node only after the whole context contract has been read again. Use lattice_checkpoint for execution evidence and completion.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Unfinished node to edit.' },
      title: { type: 'string', description: 'Replacement title.' },
      acceptanceCriteria: { type: 'string', description: 'Replacement observable acceptance criterion.' },
      blockedReason: { type: 'string', description: 'Non-empty reason to block this node; omit to leave its status unchanged.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      if (args.title === undefined && args.acceptanceCriteria === undefined && args.blockedReason === undefined) {
        throw new Error('lattice_update requires title, acceptanceCriteria, or blockedReason')
      }
      const result = await store.mutate(workspace, 'update', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        assertMutable(node)
        if (args.title !== undefined) node.title = assertText(args.title, 'title')
        if (args.acceptanceCriteria !== undefined) node.acceptanceCriteria = assertText(args.acceptanceCriteria, 'acceptanceCriteria')
        if (args.blockedReason !== undefined) {
          node.blockedReason = assertText(args.blockedReason, 'blockedReason')
          node.status = 'blocked'
        }
        node.updatedAt = Date.now()
        state.revision += 1
        state.project.updatedAt = node.updatedAt
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Updated node ${args.nodeId} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_archive',
    description: 'Archive one non-active leaf with an audit reason after rereading the full project context. Archiving preserves history; it never deletes a node.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Leaf node to archive.' },
      reason: { type: 'string', required: true, description: 'Why this path is no longer part of the current plan.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'archive', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        assertMutable(node)
        if (node.status === 'active') throw new Error('an active node must be checkpointed or blocked before it can be archived')
        if (!isLeaf(state, node.id)) throw new Error('only a leaf can be archived')
        node.status = 'archived'
        node.blockedReason = assertText(args.reason, 'reason')
        node.updatedAt = Date.now()
        state.revision += 1
        state.project.updatedAt = node.updatedAt
        return { value: { node, revision: state.revision }, delta: delta(state, [node], true) }
      })
      clearWorkspace(workspace)
      return json({
        message: `Archived node ${args.nodeId} at lattice revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkout',
    description: 'Acquire the sole execution lease for one current leaf. The lease is granted only after a complete context reread and permits configured write tools until the next successful guarded action requires a checkpoint.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      nodeId: { type: 'string', required: true, description: 'Pending or active leaf to execute.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      ensureNoActiveLease(workspace)
      const result = await store.mutate(workspace, 'checkout', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, args.nodeId)
        if (node.status !== 'pending' && node.status !== 'active') throw new Error('only a pending or active node can be checked out')
        if (!isLeaf(state, node.id)) throw new Error('only a leaf can be checked out for execution')
        const now = Date.now()
        const touched: LatticeNode[] = []
        let current: LatticeNode | undefined = node
        while (current !== undefined) {
          if (current.status === 'pending') current.status = 'active'
          current.updatedAt = now
          touched.push(current)
          current = current.parentId === undefined ? undefined : findNode(state, current.parentId)
        }
        state.revision += 1
        state.project.updatedAt = now
        return { value: { node, revision: state.revision }, delta: delta(state, touched, true) }
      })
      clearWorkspace(workspace)
      leases.set(sessionKey(agent), { workspace, nodeId: args.nodeId, revision: result.revision, dirty: false })
      return json({
        message: `Checked out leaf ${args.nodeId} at lattice revision ${result.revision}. Guarded tools are now permitted for this leaf; refresh context before checkpointing.`,
        node: result.node,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lattice_checkpoint',
    description: 'Record the result of the current minimal execution unit. This rereads context, records evidence, and either keeps the leaf active or completes it and recursively reconciles parents whose children are all complete.',
    parameters: {
      receiptId: { type: 'string', required: true, description: 'Fresh context receipt.' },
      expectedRevision: { type: 'integer', required: true, description: 'Exact lattice revision.' },
      summary: { type: 'string', required: true, description: 'What changed or was verified since the previous checkpoint.' },
      references: { type: 'array', required: true, description: 'Concrete files, commands, test names, or review evidence.', items: { type: 'string' } },
      complete: { type: 'boolean', required: true, description: 'True only when the leaf acceptance criterion is satisfied.' },
    },
    output: { schema: { type: 'json' }, render: renderSummary },
    async execute(args, exec) {
      const agent = exec.agent!
      const workspace = await workspaceFor(agent)
      const lease = leases.get(sessionKey(agent))
      if (lease === undefined || lease.workspace !== workspace) throw new Error('lattice_checkpoint requires this session to hold a leaf lease')
      await requireFreshReceipt(agent, workspace, args.receiptId, args.expectedRevision)
      const result = await store.mutate(workspace, 'checkpoint', state => {
        assertExpectedRevision(state, args.expectedRevision)
        const node = findNode(state, lease.nodeId)
        if (!isLeaf(state, node.id)) throw new Error('the checked-out node is no longer a leaf')
        const evidence = {
          summary: assertText(args.summary, 'summary'),
          references: args.references.map(reference => assertText(reference, 'reference')),
          recordedAt: Date.now(),
        }
        const touched = args.complete
          ? completeAndCollapse(state, node.id, evidence)
          : (() => {
              assertMutable(node)
              node.evidence.push(evidence)
              node.updatedAt = evidence.recordedAt
              return [node]
            })()
        state.revision += 1
        state.project.updatedAt = evidence.recordedAt
        return { value: { touched, revision: state.revision }, delta: delta(state, touched, true) }
      })
      receipts.delete(sessionKey(agent))
      if (args.complete) leases.delete(sessionKey(agent))
      else leases.set(sessionKey(agent), { ...lease, revision: result.revision, dirty: false })
      return json({
        message: args.complete
          ? `Completed ${lease.nodeId} and reconciled ${result.touched.length - 1} parent nodes at revision ${result.revision}. Context receipt consumed; refresh context before another structural change.`
          : `Checkpointed ${lease.nodeId} at revision ${result.revision}; its execution lease remains current. Refresh context before the next checkpoint.`,
        touched: result.touched,
      })
    },
  }))
}
