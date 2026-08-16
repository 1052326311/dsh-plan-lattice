import { canonical, routes, sha256 } from './protocol.mjs'

const defaultLanguages = ['en', 'zh']

function digest(value) {
  return sha256(`${JSON.stringify(canonical(value))}\n`)
}

function nonEmpty(value, context) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${context} must be a non-empty string`)
  return value.trim()
}

function positiveInteger(value, context) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${context} must be a positive integer`)
  return value
}

function normalizeTargets(targetPerLanguage, languages) {
  if (targetPerLanguage === null || typeof targetPerLanguage !== 'object' || Array.isArray(targetPerLanguage)) {
    throw new Error('targetPerLanguage must be an object')
  }
  const nested = languages.every(language => targetPerLanguage[language] !== undefined)
  return Object.fromEntries(languages.map(language => {
    const source = nested ? targetPerLanguage[language] : targetPerLanguage
    return [language, Object.fromEntries(routes.map(route => [
      route,
      positiveInteger(source?.[route], `targetPerLanguage.${nested ? `${language}.` : ''}${route}`),
    ]))]
  }))
}

function normalizeRows(rows, languages, orderingMaterial) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('selection rows must be a non-empty array')
  const ids = new Set()
  const familyDimensions = new Map()
  const normalized = rows.map((row, index) => {
    const id = nonEmpty(row?.id, `rows[${index}].id`)
    const language = nonEmpty(row?.language, `rows[${index}].language`)
    const route = nonEmpty(row?.route, `rows[${index}].route`)
    const repository = nonEmpty(row?.repository, `rows[${index}].repository`).toLowerCase()
    const sourceFamilyId = nonEmpty(row?.sourceFamilyId, `rows[${index}].sourceFamilyId`).toLowerCase()
    if (!languages.includes(language)) throw new Error(`rows[${index}].language is outside the selection domain`)
    if (!routes.includes(route)) throw new Error(`rows[${index}].route is outside the selection domain`)
    if (ids.has(id)) throw new Error(`selection rows duplicate candidate ${id}`)
    const dimensions = `${language}\0${route}\0${repository}`
    if (familyDimensions.has(sourceFamilyId) && familyDimensions.get(sourceFamilyId) !== dimensions) {
      throw new Error(`source family ${sourceFamilyId} crosses language, route, or repository dimensions and cannot enter the exact flow network`)
    }
    ids.add(id)
    familyDimensions.set(sourceFamilyId, dimensions)
    return { id, language, route, repository, sourceFamilyId }
  })
  return normalized.sort((left, right) => {
    if (orderingMaterial !== undefined) {
      const ranked = sha256(`${orderingMaterial}${left.id}`).localeCompare(sha256(`${orderingMaterial}${right.id}`))
      if (ranked !== 0) return ranked
    }
    return left.id.localeCompare(right.id)
  })
}

class Dinic {
  constructor() {
    this.names = []
    this.indexes = new Map()
    this.graph = []
    this.forward = []
  }

  node(name) {
    let index = this.indexes.get(name)
    if (index !== undefined) return index
    index = this.names.length
    this.names.push(name)
    this.indexes.set(name, index)
    this.graph.push([])
    return index
  }

  edge(fromName, toName, capacity, metadata = {}) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error('flow capacities must be non-negative integers')
    const from = this.node(fromName)
    const to = this.node(toName)
    const forward = { to, reverse: this.graph[to].length, residual: capacity, capacity, metadata }
    const reverse = { to: from, reverse: this.graph[from].length, residual: 0, capacity: 0, metadata: { reverse: true } }
    this.graph[from].push(forward)
    this.graph[to].push(reverse)
    this.forward.push({ from, edge: forward })
    return forward
  }

  maxFlow(sourceName, sinkName) {
    const source = this.indexes.get(sourceName)
    const sink = this.indexes.get(sinkName)
    if (source === undefined || sink === undefined) throw new Error('flow source and sink must exist')
    let total = 0
    for (;;) {
      const level = Array(this.graph.length).fill(-1)
      const queue = [source]
      level[source] = 0
      for (let head = 0; head < queue.length; head += 1) {
        const node = queue[head]
        for (const edge of this.graph[node]) {
          if (edge.residual > 0 && level[edge.to] < 0) {
            level[edge.to] = level[node] + 1
            queue.push(edge.to)
          }
        }
      }
      if (level[sink] < 0) break
      const cursor = Array(this.graph.length).fill(0)
      const send = (node, available) => {
        if (node === sink) return available
        for (; cursor[node] < this.graph[node].length; cursor[node] += 1) {
          const edge = this.graph[node][cursor[node]]
          if (edge.residual <= 0 || level[edge.to] !== level[node] + 1) continue
          const amount = send(edge.to, Math.min(available, edge.residual))
          if (amount === 0) continue
          edge.residual -= amount
          this.graph[edge.to][edge.reverse].residual += amount
          return amount
        }
        return 0
      }
      for (;;) {
        const amount = send(source, Number.MAX_SAFE_INTEGER)
        if (amount === 0) break
        total += amount
      }
    }
    return total
  }

  flowEdges() {
    return this.forward.flatMap(({ from, edge }) => {
      const flow = edge.capacity - edge.residual
      if (flow === 0) return []
      return [{ from: this.names[from], to: this.names[edge.to], capacity: edge.capacity, flow, ...edge.metadata }]
    })
  }

  minimumCut(sourceName) {
    const source = this.indexes.get(sourceName)
    const reachable = new Set([source])
    const queue = [source]
    for (let head = 0; head < queue.length; head += 1) {
      for (const edge of this.graph[queue[head]]) {
        if (edge.residual > 0 && !reachable.has(edge.to)) {
          reachable.add(edge.to)
          queue.push(edge.to)
        }
      }
    }
    const crossingEdges = this.forward.flatMap(({ from, edge }) => {
      if (!reachable.has(from) || reachable.has(edge.to) || edge.capacity === 0) return []
      return [{ from: this.names[from], to: this.names[edge.to], capacity: edge.capacity, ...edge.metadata }]
    }).sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to))
    return {
      reachableNodes: [...reachable].map(index => this.names[index]).sort(),
      crossingEdges,
      capacity: crossingEdges.reduce((sum, edge) => sum + edge.capacity, 0),
    }
  }
}

function countBy(values, key) {
  const counts = new Map()
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1)
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export function solveExactSelectionFlow({
  rows,
  targetPerLanguage,
  maximumPerRepository,
  maximumPerRoutePerRepository,
  languages = defaultLanguages,
  orderingMaterial,
} = {}) {
  if (!Array.isArray(languages) || languages.length === 0 || new Set(languages).size !== languages.length) {
    throw new Error('languages must be a non-empty unique array')
  }
  const targets = normalizeTargets(targetPerLanguage, languages)
  const repositoryCap = positiveInteger(maximumPerRepository, 'maximumPerRepository')
  const routeRepositoryCap = positiveInteger(maximumPerRoutePerRepository, 'maximumPerRoutePerRepository')
  const normalized = normalizeRows(rows, languages, orderingMaterial)
  const network = new Dinic()
  const source = 'source'
  const sink = 'sink'
  network.node(source)
  network.node(sink)
  const requiredFlow = languages.reduce((total, language) => (
    total + routes.reduce((sum, route) => sum + targets[language][route], 0)
  ), 0)

  for (const language of languages) {
    for (const route of routes) {
      network.edge(source, `bucket:${language}:${route}`, targets[language][route], { kind: 'quota', language, route })
    }
  }
  const repositories = [...new Set(normalized.map(row => row.repository))].sort()
  const routeRepositories = [...new Set(normalized.map(row => `${row.route}\0${row.repository}`))].sort()
  const familyRows = [...new Map(normalized.map(row => [row.sourceFamilyId, row])).values()]
  for (const repository of repositories) {
    network.edge(`repository-in:${repository}`, `repository-out:${repository}`, repositoryCap, { kind: 'repository-cap', repository })
    network.edge(`repository-out:${repository}`, sink, requiredFlow, { kind: 'repository-sink', repository })
  }
  for (const key of routeRepositories) {
    const [route, repository] = key.split('\0')
    network.edge(`route-repository-in:${route}:${repository}`, `route-repository-out:${route}:${repository}`, routeRepositoryCap, {
      kind: 'route-repository-cap', route, repository,
    })
    network.edge(`route-repository-out:${route}:${repository}`, `repository-in:${repository}`, requiredFlow, {
      kind: 'route-repository-to-repository', route, repository,
    })
  }
  for (const row of familyRows) {
    network.edge(`family-in:${row.sourceFamilyId}`, `family-out:${row.sourceFamilyId}`, 1, {
      kind: 'family-cap', sourceFamilyId: row.sourceFamilyId,
    })
    network.edge(`family-out:${row.sourceFamilyId}`, `route-repository-in:${row.route}:${row.repository}`, 1, {
      kind: 'family-route-repository', sourceFamilyId: row.sourceFamilyId, route: row.route, repository: row.repository,
    })
  }

  const candidateEdges = new Map()
  for (const row of normalized) {
    const candidate = `candidate:${row.id}`
    candidateEdges.set(row.id, network.edge(`bucket:${row.language}:${row.route}`, candidate, 1, {
      kind: 'candidate', candidateId: row.id, sourceFamilyId: row.sourceFamilyId,
    }))
    network.edge(candidate, `family-in:${row.sourceFamilyId}`, 1, {
      kind: 'candidate-family', candidateId: row.id, sourceFamilyId: row.sourceFamilyId,
    })
  }

  const flowValue = network.maxFlow(source, sink)
  const selectedRows = normalized.filter(row => {
    const edge = candidateEdges.get(row.id)
    return edge.capacity - edge.residual === 1
  })
  const selectedCandidateIds = selectedRows.map(row => row.id).sort()
  const input = {
    rows: normalized,
    targets,
    maximumPerRepository: repositoryCap,
    maximumPerRoutePerRepository: routeRepositoryCap,
    orderingMaterialDigest: orderingMaterial === undefined ? null : sha256(orderingMaterial),
  }
  const witness = {
    schemaVersion: 1,
    algorithm: 'dinic-exact-integral-max-flow-v1',
    inputDigest: digest(input),
    requiredFlow,
    flowValue,
    feasible: flowValue === requiredFlow,
    selectedCandidateIds,
    quotaCounts: countBy(selectedRows, row => `${row.language}/${row.route}`),
    repositoryCounts: countBy(selectedRows, row => row.repository),
    routeRepositoryCounts: countBy(selectedRows, row => `${row.route}/${row.repository}`),
    familyCounts: countBy(selectedRows, row => row.sourceFamilyId),
    nonZeroFlowEdges: network.flowEdges(),
    ...(flowValue === requiredFlow ? {} : { minimumCut: network.minimumCut(source) }),
  }
  witness.witnessDigest = digest(witness)
  return { feasible: witness.feasible, selectedRows, witness }
}
