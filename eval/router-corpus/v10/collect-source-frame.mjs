#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertArtifactsAbsent,
  cutoff,
  protocolId,
  sha256,
  stableLines,
  writeExclusive,
} from './protocol.mjs'
import {
  assertSourceDisjoint,
  canonicalPrompt,
  fiveShingles,
  priorSourceInventory,
  shingleJaccard,
} from './source-isolation.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cutoffTimestamp = Date.parse(cutoff)
const familyPriority = new Map([
  ['continuity', 0],
  ['decision', 1],
  ['repository-contingent', 2],
  ['bounded', 3],
  ['natural', 4],
])

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function timestamp(value, label) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a timestamp`)
  return parsed
}

function atOrBeforeCutoff(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= cutoffTimestamp
}

function humanLogin(user) {
  const login = cleanText(user?.login)
  if (login === '' || user?.type === 'Bot' || /(?:\[bot\]|-bot|_bot)$/iu.test(login)) return undefined
  return login.toLowerCase()
}

function languageMatches(text, language, spec) {
  const letters = [...text].filter(character => /[A-Za-z\u3400-\u9fff]/u.test(character))
  if (letters.length < spec.language.minimumLetters) return false
  const han = letters.filter(character => /[\u3400-\u9fff]/u.test(character)).length
  const ratio = han / letters.length
  return language === 'zh'
    ? han >= spec.language.minimumHanCharacters && ratio >= spec.language.minimumChineseHanRatio
    : ratio <= spec.language.maximumEnglishHanRatio
}

function actionRequest(text, language) {
  return language === 'zh'
    ? /(?:请|需要|应该|必须|改为|替换|删除|添加|使用|不要|移动|更新|修改|修复|实现|支持)/u.test(text)
    : /\b(?:please|should|must|need(?:s)? to|change|replace|remove|add|rename|use|avoid|move|update|fix|implement|support|refactor)\b/iu.test(text)
}

function unresolvedQuestion(text, language) {
  if (!/[?？]/u.test(text)) return false
  return language === 'zh'
    ? /(?:还是|或者|是否|哪种|选择|决定|要不要|能否|可以|怎么|如何|什么)/u.test(text)
    : /\b(?:either|or|which|whether|should|do you|would you|can you|could you|choose|decide|what|how)\b/iu.test(text)
}

function repositoryContingent(text, language) {
  const states = language === 'zh'
    ? /(?:如果|若)[\s\S]{0,1000}(?:否则|不然)|取决于是否|是否已经|当前(?:实现|代码|配置)|现有(?:实现|代码|配置)/u.test(text)
    : /\b(?:if|when|unless)\b[\s\S]{0,1000}\b(?:else|otherwise)\b|\bdepending on whether\b|\bwhether\b[\s\S]{0,180}\balready\b|\bcurrent (?:implementation|code|config)|\bexisting (?:implementation|code|config)/iu.test(text)
  const artifact = /`[^`\n]{2,160}`|(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|cpp|c|h|json|ya?ml|toml)\b|(?:配置|代码|文件|目录|实现)/iu.test(text)
  return states && artifact
}

function usableText(text, language, spec) {
  return text.length >= spec.limits.minimumPromptCharacters
    && text.length <= spec.limits.maximumPromptCharacters
    && languageMatches(text, language, spec)
}

function repositoryNameFromApiUrl(value) {
  const match = String(value ?? '').match(/\/repos\/([^/]+\/[^/]+)$/u)
  if (match === null) throw new Error(`cannot derive repository from ${value}`)
  return match[1]
}

function sourceFamilyId(item) {
  const repository = repositoryNameFromApiUrl(item.repository_url).toLowerCase()
  return `github:${repository}:${item.pull_request ? 'pull' : 'issue'}:${item.number}`
}

function issueText(item) {
  return cleanText(`${item.title}\n\n${item.body ?? ''}`)
}

function deterministicOrder(context, identity) {
  return sha256(`${protocolId}\n${context}\n${identity}`)
}

function stableSort(values, context, identity = value => value.id ?? value.node_id ?? value.url) {
  return [...values].sort((left, right) => (
    deterministicOrder(context, identity(left)).localeCompare(deterministicOrder(context, identity(right)))
  ))
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function githubToken() {
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  if (token === '') throw new Error('gh auth token returned an empty credential')
  return token
}

function githubClient(spec) {
  const token = githubToken()
  const cache = new Map()
  return async function github(path, params = {}) {
    const url = new URL(path.startsWith('http') ? path : `https://api.github.com${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const cacheKey = url.toString()
    if (cache.has(cacheKey)) return cache.get(cacheKey)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': spec.githubApiVersion,
          'user-agent': 'dsh-plan-lattice-v10-source-frame',
        },
      })
      const remaining = Number(response.headers.get('x-ratelimit-remaining') ?? '1')
      if ((response.status === 403 || response.status === 429 || remaining === 0) && attempt < 3) {
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? '0') * 1000
        const wait = Math.max(1_000, Math.min(70_000, reset - Date.now() + 1_000))
        await response.arrayBuffer()
        await sleep(wait)
        continue
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500)
        throw new Error(`GitHub API ${response.status} for ${url.pathname}: ${body.replace(token, '<redacted>')}`)
      }
      const value = await response.json()
      cache.set(cacheKey, value)
      return value
    }
    throw new Error(`GitHub API retries exhausted for ${url.pathname}`)
  }
}

async function mapLimit(values, concurrency, mapper) {
  const output = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      output[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return output
}

function validTimelineItem(item) {
  return humanLogin(item.user) !== undefined
    && atOrBeforeCutoff(item.created_at ?? item.submitted_at)
    && atOrBeforeCutoff(item.updated_at ?? item.submitted_at ?? item.created_at)
}

function maintainer(item, associations) {
  return associations.has(item.author_association)
}

function feedbackItems(reviews, comments, associations, language) {
  return [
    ...reviews.map(review => ({
      kind: 'review',
      id: review.node_id,
      url: review.html_url,
      body: review.body,
      createdAt: review.submitted_at ?? review.created_at,
      updatedAt: review.submitted_at ?? review.created_at,
      state: review.state,
      commitId: review.commit_id,
      authorAssociation: review.author_association,
      user: review.user,
      path: null,
      diffHunk: null,
      raw: review,
    })),
    ...comments.map(comment => ({
      kind: 'inline-review',
      id: comment.node_id,
      url: comment.html_url,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      state: 'COMMENTED',
      commitId: comment.commit_id,
      authorAssociation: comment.author_association,
      user: comment.user,
      path: comment.path,
      diffHunk: comment.diff_hunk,
      raw: comment,
    })),
  ].filter(feedback => (
    humanLogin(feedback.user) !== undefined
    && associations.has(feedback.authorAssociation)
    && atOrBeforeCutoff(feedback.createdAt)
    && atOrBeforeCutoff(feedback.updatedAt)
    && cleanText(feedback.body).length >= 10
    && (feedback.state === 'CHANGES_REQUESTED' || actionRequest(feedback.body, language))
  )).sort((left, right) => timestamp(left.createdAt, 'feedback') - timestamp(right.createdAt, 'feedback'))
}

function frameRow(candidate, repository, input) {
  const text = cleanText(input.text)
  const repositoryName = repository.full_name.toLowerCase()
  const networkRoot = (repository.source?.full_name ?? repository.parent?.full_name ?? repository.full_name).toLowerCase()
  return {
    stableSourceId: input.stableSourceId,
    sourceFamilyId: input.sourceFamilyId,
    queue: input.family === 'natural' ? 'natural' : 'challenge',
    constructionFamily: input.family === 'natural' ? null : input.family,
    construction: input.construction,
    language: candidate.language,
    text,
    platform: 'github',
    objectType: input.objectType,
    repository: repositoryName,
    repositoryNodeId: repository.node_id,
    networkRoot,
    organization: repository.owner.login.toLowerCase(),
    ecosystem: cleanText(repository.language || 'unknown').toLowerCase(),
    authorId: input.authorId,
    url: input.url,
    nodeId: input.nodeId,
    createdAt: input.createdAt,
    contentUpdatedAt: input.contentUpdatedAt,
    immutableAtCutoff: true,
    sourceContentDigest: sha256(JSON.stringify(input.evidence)),
    promptDigest: sha256(text),
    canonicalPromptDigest: sha256(canonicalPrompt(text)),
    relatedPullRequests: [...new Set(input.relatedPullRequests ?? [])].sort(),
    relatedCommits: [...new Set(input.relatedCommits ?? [])].sort(),
    duplicateChain: [],
    repositoryBaseCommit: input.repositoryBaseCommit ?? null,
    searchId: candidate.search.id,
    __auditEvidence: input.evidence,
  }
}

async function repositoryMetadata(candidate, github, priorNetworks, ledger) {
  const repositoryName = repositoryNameFromApiUrl(candidate.item.repository_url).toLowerCase()
  if (priorNetworks.has(repositoryName)) {
    ledger.push({ sourceFamilyId: candidate.familyId, accepted: false, reason: 'prior-repository', repository: repositoryName })
    return undefined
  }
  const repository = await github(candidate.item.repository_url)
  const networkRoot = (repository.source?.full_name ?? repository.parent?.full_name ?? repository.full_name).toLowerCase()
  if (priorNetworks.has(networkRoot)) {
    ledger.push({ sourceFamilyId: candidate.familyId, accepted: false, reason: 'prior-network-root', repository: repositoryName, networkRoot })
    return undefined
  }
  return repository
}

async function buildNatural(candidate, repository) {
  const item = candidate.item
  const text = issueText(item)
  return frameRow(candidate, repository, {
    stableSourceId: `github:${item.node_id}`,
    sourceFamilyId: candidate.familyId,
    family: 'natural',
    construction: 'global-search-natural-issue',
    objectType: 'issue',
    text,
    authorId: humanLogin(item.user),
    url: item.html_url,
    nodeId: item.node_id,
    createdAt: item.created_at,
    contentUpdatedAt: item.updated_at,
    evidence: { searchId: candidate.search.id, item },
  })
}

async function buildDecision(candidate, repository, github, spec) {
  const item = candidate.item
  if (item.comments < 1 || item.comments > spec.limits.maximumTimelineComments || !actionRequest(issueText(item), candidate.language)) return undefined
  const comments = await github(item.comments_url, { per_page: spec.limits.maximumTimelineComments })
  if (comments.length !== item.comments) return undefined
  const timeline = comments.filter(validTimelineItem)
    .sort((left, right) => timestamp(left.created_at, 'issue comment') - timestamp(right.created_at, 'issue comment'))
  const latest = timeline.at(-1)
  const associations = new Set(spec.authorAssociations)
  if (latest === undefined || !maintainer(latest, associations) || !unresolvedQuestion(latest.body, candidate.language)) return undefined
  const text = cleanText(`Original request:\n${issueText(item)}\n\nUnresolved maintainer question at the cutoff:\n${latest.body}`)
  return frameRow(candidate, repository, {
    stableSourceId: `github:${latest.node_id}`,
    sourceFamilyId: candidate.familyId,
    family: 'decision',
    construction: 'unanswered-maintainer-question',
    objectType: 'issue-comment-request',
    text,
    authorId: humanLogin(latest.user),
    url: latest.html_url,
    nodeId: latest.node_id,
    createdAt: item.created_at,
    contentUpdatedAt: latest.updated_at,
    evidence: { searchId: candidate.search.id, issue: item, comments: timeline },
  })
}

async function pullTimeline(candidate, github, spec) {
  const pullUrl = candidate.item.pull_request?.url
  if (pullUrl === undefined) return undefined
  const pull = await github(pullUrl)
  const [reviews, reviewComments, commits] = await Promise.all([
    github(`${pullUrl}/reviews`, { per_page: spec.limits.maximumPullReviews }),
    github(`${pullUrl}/comments`, { per_page: spec.limits.maximumPullReviewComments }),
    github(`${pullUrl}/commits`, { per_page: spec.limits.maximumPullCommits }),
  ])
  if (pull.commits > spec.limits.maximumPullCommits
    || reviews.length >= spec.limits.maximumPullReviews
    || reviewComments.length >= spec.limits.maximumPullReviewComments) return undefined
  return { pull, reviews, reviewComments, commits }
}

function feedbackText(feedback) {
  return cleanText([
    feedback.path ? `File: ${feedback.path}` : null,
    feedback.body,
    feedback.diffHunk ? `Observed diff context:\n${feedback.diffHunk}` : null,
  ].filter(Boolean).join('\n\n'))
}

async function buildBounded(candidate, repository, github, spec) {
  const timeline = await pullTimeline(candidate, github, spec)
  if (timeline === undefined) return undefined
  const associations = new Set(spec.authorAssociations)
  const feedback = feedbackItems(timeline.reviews, timeline.reviewComments, associations, candidate.language)[0]
  if (feedback === undefined) return undefined
  const text = cleanText(`Pull request task:\n${timeline.pull.title}\n\n${timeline.pull.body ?? ''}\n\nFocused maintainer request:\n${feedbackText(feedback)}`)
  if (text.length > spec.limits.maximumBoundedPromptCharacters) return undefined
  return frameRow(candidate, repository, {
    stableSourceId: `github:bounded:${timeline.pull.node_id}:${feedback.id}`,
    sourceFamilyId: candidate.familyId,
    family: 'bounded',
    construction: feedback.kind === 'inline-review' ? 'bounded-inline-review' : 'bounded-review',
    objectType: 'pull-review',
    text,
    authorId: humanLogin(feedback.user),
    url: feedback.url ?? timeline.pull.html_url,
    nodeId: feedback.id,
    createdAt: timeline.pull.created_at,
    contentUpdatedAt: feedback.updatedAt,
    relatedPullRequests: [timeline.pull.html_url],
    relatedCommits: [feedback.commitId].filter(Boolean),
    evidence: { searchId: candidate.search.id, pull: timeline.pull, feedback: feedback.raw },
  })
}

async function buildContinuity(candidate, repository, github, spec) {
  const timeline = await pullTimeline(candidate, github, spec)
  if (timeline === undefined) return undefined
  const associations = new Set(spec.authorAssociations)
  const feedbacks = feedbackItems(timeline.reviews, timeline.reviewComments, associations, candidate.language)
  for (const feedback of feedbacks) {
    const feedbackTime = timestamp(feedback.createdAt, 'feedback')
    const laterCommit = timeline.commits.find(commit => {
      const date = commit.commit?.committer?.date ?? commit.commit?.author?.date
      return atOrBeforeCutoff(date) && timestamp(date, 'commit') > feedbackTime && commit.sha !== feedback.commitId
    })
    if (laterCommit === undefined) continue
    const commitDate = laterCommit.commit.committer?.date ?? laterCommit.commit.author?.date
    const text = cleanText([
      'Initial pull request task:',
      `${timeline.pull.title}\n\n${timeline.pull.body ?? ''}`,
      'Maintainer change request:',
      feedbackText(feedback),
      `Later mutation (${commitDate}):`,
      laterCommit.commit.message,
    ].join('\n\n'))
    return frameRow(candidate, repository, {
      stableSourceId: `github:continuity:${timeline.pull.node_id}:${feedback.id}:${laterCommit.sha}`,
      sourceFamilyId: candidate.familyId,
      family: 'continuity',
      construction: feedback.kind === 'inline-review' ? 'inline-review-commit-chain' : 'review-commit-chain',
      objectType: 'pull-review',
      text,
      authorId: humanLogin(feedback.user),
      url: timeline.pull.html_url,
      nodeId: timeline.pull.node_id,
      createdAt: timeline.pull.created_at,
      contentUpdatedAt: commitDate,
      relatedPullRequests: [timeline.pull.html_url],
      relatedCommits: [feedback.commitId, laterCommit.sha].filter(Boolean),
      evidence: { searchId: candidate.search.id, pull: timeline.pull, feedback: feedback.raw, laterCommit },
    })
  }
  return undefined
}

async function buildRepositoryContingent(candidate, repository, github) {
  const item = candidate.item
  const text = issueText(item)
  if (!repositoryContingent(text, candidate.language) || !actionRequest(text, candidate.language)) return undefined
  const commits = await github(`${candidate.item.repository_url}/commits`, {
    sha: repository.default_branch,
    until: cutoff,
    per_page: 1,
  })
  const baseCommit = commits[0]?.sha
  if (!/^[0-9a-f]{40}$/u.test(baseCommit ?? '')) return undefined
  return frameRow(candidate, repository, {
    stableSourceId: `github:${item.node_id}`,
    sourceFamilyId: candidate.familyId,
    family: 'repository-contingent',
    construction: 'conditional-repository-state',
    objectType: 'issue',
    text,
    authorId: humanLogin(item.user),
    url: item.html_url,
    nodeId: item.node_id,
    createdAt: item.created_at,
    contentUpdatedAt: item.updated_at,
    repositoryBaseCommit: baseCommit,
    relatedCommits: [baseCommit],
    evidence: { searchId: candidate.search.id, item, repositoryBaseAtCutoff: baseCommit },
  })
}

async function buildCandidate(candidate, repository, github, spec) {
  if (!atOrBeforeCutoff(candidate.item.created_at) || !atOrBeforeCutoff(candidate.item.updated_at)
    || humanLogin(candidate.item.user) === undefined) return undefined
  switch (candidate.search.family) {
    case 'natural': return buildNatural(candidate, repository)
    case 'decision': return buildDecision(candidate, repository, github, spec)
    case 'bounded': return buildBounded(candidate, repository, github, spec)
    case 'continuity': return buildContinuity(candidate, repository, github, spec)
    case 'repository-contingent': return buildRepositoryContingent(candidate, repository, github)
    default: throw new Error(`unknown search family ${candidate.search.family}`)
  }
}

function firstCurrentNearDuplicate(row, accepted) {
  const shingles = fiveShingles(row.text)
  for (const other of accepted) {
    if (shingleJaccard(shingles, other.shingles) >= 0.85) return other.row.stableSourceId
  }
  return undefined
}

function countFrame(rows, spec) {
  const counts = { natural: { en: 0, zh: 0 }, challenge: {} }
  const failures = []
  for (const language of ['en', 'zh']) {
    counts.natural[language] = rows.filter(row => row.queue === 'natural' && row.language === language).length
    if (counts.natural[language] < spec.capacity.naturalPerLanguage) {
      failures.push(`natural/${language} has ${counts.natural[language]}`)
    }
    for (const family of ['bounded', 'decision', 'continuity', 'repository-contingent']) {
      const stratum = rows.filter(row => row.queue === 'challenge' && row.language === language && row.constructionFamily === family)
      const key = `${language}/${family}`
      counts.challenge[key] = {
        rows: stratum.length,
        repositories: new Set(stratum.map(row => row.repository)).size,
        organizations: new Set(stratum.map(row => row.organization)).size,
      }
      if (stratum.length < spec.capacity.challengePerLanguageAndFamily) failures.push(`challenge/${key} has ${stratum.length}`)
      if (counts.challenge[key].repositories < spec.capacity.minimumRepositoriesPerChallengeStratum) {
        failures.push(`challenge/${key} has fewer than ${spec.capacity.minimumRepositoriesPerChallengeStratum} repositories`)
      }
      if (counts.challenge[key].organizations < spec.capacity.minimumOrganizationsPerChallengeStratum) {
        failures.push(`challenge/${key} has fewer than ${spec.capacity.minimumOrganizationsPerChallengeStratum} organizations`)
      }
    }
  }
  return { counts, failures }
}

function queryCandidate(search, item) {
  return { search, item, language: search.language, familyId: sourceFamilyId(item) }
}

async function main() {
  const framePath = option('--frame')
  const auditPath = option('--audit')
  const ledgerPath = option('--ledger')
  const manifestPath = option('--manifest')
  const failurePath = option('--failure-manifest')
  if ([framePath, auditPath, ledgerPath, manifestPath, failurePath].some(value => value === undefined)) {
    throw new Error('usage: collect-source-frame.mjs --frame <private.jsonl> --audit <private.jsonl> --ledger <private.jsonl> --manifest <json> --failure-manifest <json>')
  }
  const outputs = [framePath, auditPath, ledgerPath, manifestPath, failurePath].map(value => resolve(value))
  await assertArtifactsAbsent(outputs, 'V10 source-frame collection')
  const spec = JSON.parse(await readFile(resolve(here, 'source-frame-spec.json'), 'utf8'))
  if (spec.protocol !== protocolId || spec.cutoff !== cutoff || spec.selectionSeedAccess !== 'forbidden-during-source-frame-collection') {
    throw new Error('source-frame spec does not match the frozen V10 protocol')
  }
  const searchIds = new Set()
  for (const search of spec.searches) {
    if (searchIds.has(search.id)) throw new Error(`duplicate search id ${search.id}`)
    searchIds.add(search.id)
    if (!['en', 'zh'].includes(search.language) || !familyPriority.has(search.family)) throw new Error(`invalid search ${search.id}`)
    if (!search.query.includes('updated:<=2026-08-15')) throw new Error(`search ${search.id} does not bind the cutoff date`)
  }

  const inventory = await priorSourceInventory()
  const priorNetworks = new Set([...(inventory.repositories ?? []), ...(inventory.networkMembers ?? [])])
  const github = githubClient(spec)
  const searchSnapshots = []
  for (const search of [...spec.searches].sort((left, right) => left.id.localeCompare(right.id))) {
    const result = await github('/search/issues', {
      q: search.query,
      per_page: spec.limits.searchResultsPerPage,
      page: 1,
    })
    searchSnapshots.push({
      search,
      totalCount: result.total_count,
      items: result.items.slice(0, spec.limits.maximumCandidatesPerSearch),
    })
  }

  const rawCandidates = searchSnapshots.flatMap(snapshot => snapshot.items.map(item => queryCandidate(snapshot.search, item)))
    .sort((left, right) => {
      const priority = familyPriority.get(left.search.family) - familyPriority.get(right.search.family)
      if (priority !== 0) return priority
      return deterministicOrder('candidate', `${left.search.id}\n${left.familyId}`)
        .localeCompare(deterministicOrder('candidate', `${right.search.id}\n${right.familyId}`))
    })
  const ledger = []
  const repositoryCache = new Map()
  const timelineCache = new Map()
  const candidates = await mapLimit(rawCandidates, spec.limits.concurrency, async candidate => {
    if (!repositoryCache.has(candidate.item.repository_url)) {
      repositoryCache.set(candidate.item.repository_url, repositoryMetadata(candidate, github, priorNetworks, ledger))
    }
    const repository = await repositoryCache.get(candidate.item.repository_url)
    if (repository === undefined) return undefined
    const timelineKey = `${candidate.search.family}\0${candidate.familyId}\0${candidate.language}`
    if (!timelineCache.has(timelineKey)) {
      timelineCache.set(timelineKey, buildCandidate(candidate, repository, github, spec))
    }
    const built = await timelineCache.get(timelineKey)
    if (built === undefined) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'construction-or-time-gate' })
      return undefined
    }
    const { __auditEvidence, ...row } = built
    if (!usableText(row.text, candidate.language, spec)) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'text-or-language-gate' })
      return undefined
    }
    try {
      assertSourceDisjoint([row], inventory)
    } catch (error) {
      ledger.push({ sourceFamilyId: candidate.familyId, searchId: candidate.search.id, accepted: false, reason: 'prior-source-isolation', detail: error.message })
      return undefined
    }
    return {
      row,
      audit: {
        stableSourceId: row.stableSourceId,
        searchId: candidate.search.id,
        sourceContentDigest: row.sourceContentDigest,
        evidence: __auditEvidence,
      },
    }
  })

  const byFamily = new Map()
  for (const pair of candidates.filter(Boolean)) {
    if (!byFamily.has(pair.row.sourceFamilyId)) byFamily.set(pair.row.sourceFamilyId, [])
    byFamily.get(pair.row.sourceFamilyId).push(pair)
  }
  const collapsed = [...byFamily.values()].map(values => values.sort((left, right) => {
    const priority = familyPriority.get(left.row.constructionFamily ?? 'natural') - familyPriority.get(right.row.constructionFamily ?? 'natural')
    if (priority !== 0) return priority
    return deterministicOrder('family-collapse', left.row.stableSourceId).localeCompare(deterministicOrder('family-collapse', right.row.stableSourceId))
  })[0])

  const accepted = []
  const seenPrompt = new Set()
  const seenCanonical = new Set()
  for (const pair of collapsed.sort((left, right) => deterministicOrder('near-duplicate-collapse', left.row.stableSourceId)
    .localeCompare(deterministicOrder('near-duplicate-collapse', right.row.stableSourceId)))) {
    if (seenPrompt.has(pair.row.promptDigest) || seenCanonical.has(pair.row.canonicalPromptDigest)) {
      ledger.push({ stableSourceId: pair.row.stableSourceId, accepted: false, reason: 'current-exact-duplicate' })
      continue
    }
    const nearDuplicate = firstCurrentNearDuplicate(pair.row, accepted)
    if (nearDuplicate !== undefined) {
      ledger.push({ stableSourceId: pair.row.stableSourceId, accepted: false, reason: 'current-near-duplicate', duplicateOf: nearDuplicate })
      continue
    }
    seenPrompt.add(pair.row.promptDigest)
    seenCanonical.add(pair.row.canonicalPromptDigest)
    accepted.push({ ...pair, shingles: fiveShingles(pair.row.text) })
    ledger.push({ stableSourceId: pair.row.stableSourceId, sourceFamilyId: pair.row.sourceFamilyId, searchId: pair.row.searchId, accepted: true, reason: pair.row.construction })
  }

  const rows = accepted.map(pair => pair.row).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  assertSourceDisjoint(rows, inventory)
  const audit = accepted.map(pair => pair.audit).sort((left, right) => left.stableSourceId.localeCompare(right.stableSourceId))
  const frameText = stableLines(rows)
  const auditText = stableLines(audit)
  const ledgerText = stableLines(ledger.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
  const capacity = countFrame(rows, spec)
  const baseManifest = {
    schemaVersion: 1,
    protocol: protocolId,
    cutoff,
    seedAccessed: false,
    searchCount: spec.searches.length,
    searchSnapshotCounts: Object.fromEntries(searchSnapshots.map(snapshot => [snapshot.search.id, snapshot.items.length])),
    counts: capacity.counts,
    digests: {
      spec: sha256(await readFile(resolve(here, 'source-frame-spec.json'))),
      collector: sha256(await readFile(fileURLToPath(import.meta.url))),
      priorInventoryFiles: sha256(inventory.files),
      sourceFrame: sha256(frameText),
      privateAudit: sha256(auditText),
      rejectionLedger: sha256(ledgerText),
    },
  }

  await writeExclusive(resolve(framePath), frameText)
  await writeExclusive(resolve(auditPath), auditText)
  await writeExclusive(resolve(ledgerPath), ledgerText)
  if (capacity.failures.length > 0) {
    const failure = {
      ...baseManifest,
      evidenceStatus: 'retired-before-seed-reveal',
      capacityFailures: capacity.failures,
    }
    await writeExclusive(resolve(failurePath), `${JSON.stringify(failure, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`)
    process.exitCode = 2
    return
  }
  const manifest = {
    ...baseManifest,
    evidenceStatus: 'source-frame-capacity-passed',
    capacityFailures: [],
  }
  await writeExclusive(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

if (basename(process.argv[1] ?? '') === basename(fileURLToPath(import.meta.url))) await main()

export {
  actionRequest,
  buildCandidate,
  feedbackItems,
  languageMatches,
  repositoryContingent,
  unresolvedQuestion,
}
