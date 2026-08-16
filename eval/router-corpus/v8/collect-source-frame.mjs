#!/usr/bin/env node
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertArtifactsAbsent,
  challengeFamilies,
  collectionSeedCommitment,
  cutoff,
  languages,
  protocolId,
  queueCounts,
  sha256,
  stableLines,
  writeExclusive,
} from './protocol.mjs'
import { validateFrameRow, validateRegistry } from './assemble-candidates.mjs'
import {
  assertSourceDisjoint,
  canonicalPrompt,
  fiveShingles,
  nearDuplicateClusters,
  priorSourceInventory,
  shingleJaccard,
} from './source-isolation.mjs'

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(import.meta.url)
const here = dirname(scriptPath)
const maintainerAssociations = new Set(['COLLABORATOR', 'MEMBER', 'OWNER'])
const transientStatuses = new Set([429, 500, 502, 503, 504])

export const issueQuery = `
query V8Issues($owner: String!, $name: String!, $count: Int!, $closingCount: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issues(first: $count, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        id number url title body createdAt updatedAt lastEditedAt authorAssociation
        author { login }
        duplicateOf {
          ... on Issue { id url }
        }
        closedByPullRequestsReferences(first: $closingCount) {
          nodes { id url }
          pageInfo { hasNextPage }
        }
      }
    }
  }
}`

export const discussionQuery = `
query V8Discussions($owner: String!, $name: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    id
    discussions(first: $count, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        id number url title body createdAt updatedAt lastEditedAt authorAssociation
        author { login }
        category { id }
      }
    }
  }
}`

export const continuityQuery = `
query V8Continuity($owner: String!, $name: String!, $number: Int!, $reviewCount: Int!, $commitCount: Int!) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      id number url title body createdAt updatedAt lastEditedAt baseRefOid
      author { login }
      reviews(first: $reviewCount) {
        pageInfo { hasNextPage }
        nodes {
          id url body state submittedAt createdAt updatedAt lastEditedAt authorAssociation
          author { login }
          commit { oid }
        }
      }
      commits(first: $commitCount) {
        pageInfo { hasNextPage }
        nodes { commit { oid committedDate } }
      }
    }
  }
}`

function option(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function exactKeys(value, expected, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object`)
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${context} must contain exactly ${expected.join(', ')}`)
  }
}

export function validateSpec(value) {
  exactKeys(value, [
    'schemaVersion', 'protocol', 'cutoff', 'registrySha256', 'githubApiVersion',
    'limits', 'partition', 'language', 'authorAssociations', 'selectionSeedAccess',
  ], 'source-frame spec')
  if (value.schemaVersion !== 1 || value.protocol !== protocolId || value.cutoff !== cutoff) {
    throw new Error('source-frame spec protocol identity is invalid')
  }
  if (!/^[a-f0-9]{64}$/.test(value.registrySha256)) throw new Error('source-frame spec registry digest is invalid')
  if (value.selectionSeedAccess !== 'forbidden-during-source-frame-collection') {
    throw new Error('source-frame collection must not access the selection seed')
  }
  if (JSON.stringify([...value.authorAssociations].sort()) !== JSON.stringify([...maintainerAssociations].sort())) {
    throw new Error('source-frame maintainer associations differ from the protocol')
  }
  const expectedLimits = {
    issuesPerRepository: 100,
    issueCommentPagesPerRepository: 3,
    issueCommentsPerPage: 100,
    discussionsPerRepository: 100,
    reviewCommentPagesPerRepository: 3,
    reviewCommentsPerPage: 100,
    pullRequestsPerRepository: 50,
    reviewsPerContinuityPullRequest: 50,
    commitsPerContinuityPullRequest: 100,
    closingPullRequestsPerIssue: 10,
    maximumPromptCharacters: 20000,
    minimumPromptCharacters: 80,
    maximumBoundedBodyCharacters: 1600,
    maximumContinuityReviews: 2,
    concurrency: 4,
  }
  if (JSON.stringify(value.limits) !== JSON.stringify(expectedLimits)) throw new Error('source-frame limits differ from the protocol')
  return value
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[email]')
    .replace(/(?:sk|gh[opsu])-[A-Za-z0-9_-]{16,}/gu, '[secret]')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{4,}/gu, '\n\n\n')
    .trim()
}

function timestamp(value, context) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${context} has an invalid timestamp`)
  return parsed
}

function atOrBeforeCutoff(value, context) {
  return timestamp(value, context) <= Date.parse(cutoff)
}

function immutableGraphql(value) {
  return atOrBeforeCutoff(value.createdAt, `${value.id}.createdAt`)
    && (value.lastEditedAt === null || atOrBeforeCutoff(value.lastEditedAt, `${value.id}.lastEditedAt`))
    && (value.updatedAt === undefined || atOrBeforeCutoff(value.updatedAt, `${value.id}.updatedAt`))
}

function immutableRest(value) {
  return atOrBeforeCutoff(value.created_at, `${value.node_id}.created_at`)
    && atOrBeforeCutoff(value.updated_at, `${value.node_id}.updated_at`)
}

function latestTimestamp(values) {
  return new Date(Math.max(...values.filter(Boolean).map(value => timestamp(value, 'content timestamp')))).toISOString()
}

function humanLogin(value) {
  const login = String(value ?? '').trim()
  if (login === '' || /(?:\[bot\]|-bot$|^github-actions$)/iu.test(login)) return undefined
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

function usableText(text, language, spec) {
  return text.length >= spec.limits.minimumPromptCharacters
    && text.length <= spec.limits.maximumPromptCharacters
    && languageMatches(text, language, spec)
}

function familyBucket(kind, sourceFamilyId) {
  return Number(BigInt(`0x${sha256(`${protocolId}\nsource-family-partition\n${kind}\n${sourceFamilyId}`).slice(0, 12)}`) % 100n)
}

export function naturalIssueVariant(sourceFamilyId) {
  return Number(BigInt(`0x${sha256(`${protocolId}\nnatural-issue-variant\n${sourceFamilyId}`).slice(0, 12)}`) % 2n)
}

function deterministicOrder(context, identity) {
  return sha256(`${protocolId}\n${context}\n${identity}`)
}

export function partitionFor(kind, sourceFamilyId) {
  const bucket = familyBucket(kind, sourceFamilyId)
  if (kind === 'pull-request') {
    if (bucket <= 49) return 'natural'
    if (bucket <= 74) return 'bounded'
    return 'continuity'
  }
  if (bucket <= 49) return 'natural'
  if (bucket <= 74) return 'decision'
  return 'repository-contingent'
}

function issueNumberFromApiUrl(value) {
  const match = String(value ?? '').match(/\/issues\/(\d+)$/u)
  return match === null ? undefined : Number(match[1])
}

function pullNumberFromApiUrl(value) {
  const match = String(value ?? '').match(/\/pulls\/(\d+)$/u)
  return match === null ? undefined : Number(match[1])
}

function pullWebUrl(source, number) {
  return `https://github.com/${source.repository}/pull/${number}`
}

function sourceFamilyId(source, kind, number) {
  return `github:${source.repositoryNodeId}:${kind}:${number}`
}

function issueRelations(issue) {
  return {
    relatedPullRequests: (issue.closedByPullRequestsReferences?.nodes ?? []).map(value => value.url),
    duplicateChain: issue.duplicateOf === null ? [] : [issue.duplicateOf.url],
    relationshipTruncated: issue.closedByPullRequestsReferences?.pageInfo?.hasNextPage === true,
  }
}

function rawRecord(stableSourceId, familyId, construction, evidence) {
  const sourceContentDigest = sha256(JSON.stringify(evidence))
  return { stableSourceId, sourceFamilyId: familyId, construction, sourceContentDigest, evidence }
}

function makeFrameRow(source, input) {
  const text = cleanText(input.text)
  const audit = rawRecord(input.stableSourceId, input.sourceFamilyId, input.construction, input.evidence)
  return {
    row: {
      stableSourceId: input.stableSourceId,
      queue: input.queue,
      constructionFamily: input.constructionFamily,
      language: source.nativeLanguage,
      text,
      platform: source.platform,
      objectType: input.objectType,
      repository: source.repository,
      repositoryNodeId: source.repositoryNodeId,
      networkRoot: source.networkRoot,
      organization: source.organization,
      ecosystem: source.ecosystem,
      authorId: input.authorId,
      url: input.url,
      nodeId: input.nodeId,
      createdAt: input.createdAt,
      contentUpdatedAt: input.contentUpdatedAt,
      immutableAtCutoff: true,
      sourceContentDigest: audit.sourceContentDigest,
      promptDigest: sha256(text),
      canonicalPromptDigest: sha256(canonicalPrompt(text)),
      relatedPullRequests: [...new Set(input.relatedPullRequests ?? [])].sort(),
      relatedCommits: [...new Set(input.relatedCommits ?? [])].sort(),
      duplicateChain: [...new Set(input.duplicateChain ?? [])].sort(),
      sourceFamilyId: input.sourceFamilyId,
    },
    audit,
  }
}

function actionRequest(text, language) {
  return language === 'zh'
    ? /(?:请|需要|应该|必须|改为|替换|删除|添加|使用|不要|移动|更新|修复)/u.test(text)
    : /\b(?:please|should|must|need(?:s)? to|change|replace|remove|add|rename|use|avoid|move|update|fix)\b/iu.test(text)
}

function unresolvedAlternative(text, language) {
  const question = /[?？]/u.test(text)
  return question && (language === 'zh'
    ? /(?:还是|或者|是否|哪种|选择|决定|要不要)/u.test(text)
    : /\b(?:either|or|which|whether|should we|do you want|would you prefer|choose|decide)\b/iu.test(text))
}

function repositoryContingent(text, language) {
  const twoState = language === 'zh'
    ? /(?:如果|若)[\s\S]{0,800}(?:否则|不然)|取决于是否|是否已经|当前(?:实现|代码|配置)|现有(?:实现|代码|配置)/u.test(text)
    : /\b(?:if|when|unless)\b[\s\S]{0,800}\b(?:else|otherwise)\b|\bdepending on whether\b|\bwhether\b[\s\S]{0,160}\balready\b|\bcurrent (?:implementation|code|config)|\bexisting (?:implementation|code|config)/iu.test(text)
  const repositoryReference = /`[^`\n]{2,120}`|(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|cpp|c|h|json|ya?ml|toml)\b|(?:配置|代码|文件|目录|实现)/iu.test(text)
  return twoState && repositoryReference
}

function issueText(issue) {
  return cleanText(`${issue.title}\n\n${issue.body}`)
}

function commentText(comment) {
  return cleanText(comment.body)
}

function reviewCommentText(comment, bounded = false) {
  const body = cleanText(comment.body)
  if (!bounded) return body
  return cleanText(`File: ${comment.path}\n\nReview request:\n${body}\n\nObserved diff context:\n${comment.diff_hunk ?? ''}`)
}

function addCandidate(target, source, input, spec, ledger) {
  const pair = makeFrameRow(source, input)
  if (!usableText(pair.row.text, source.nativeLanguage, spec)) {
    ledger.push({ stableSourceId: input.stableSourceId, sourceFamilyId: input.sourceFamilyId, accepted: false, reason: 'text-or-language-gate' })
    return false
  }
  target.push(pair)
  ledger.push({ stableSourceId: input.stableSourceId, sourceFamilyId: input.sourceFamilyId, accepted: true, reason: input.construction })
  return true
}

function groupBy(values, key) {
  const result = new Map()
  for (const value of values) {
    const identity = key(value)
    if (identity === undefined) continue
    if (!result.has(identity)) result.set(identity, [])
    result.get(identity).push(value)
  }
  return result
}

export function buildIssueRows(source, issues, comments, baseCommit, spec) {
  const output = []
  const ledger = []
  const issueByNumber = new Map(issues.map(issue => [issue.number, issue]))
  const commentsByIssue = groupBy(comments, comment => issueNumberFromApiUrl(comment.issue_url))
  for (const issue of issues) {
    const familyId = sourceFamilyId(source, 'issue', issue.number)
    const partition = partitionFor('issue', familyId)
    const authorId = humanLogin(issue.author?.login)
    const relations = issueRelations(issue)
    if (!immutableGraphql(issue) || authorId === undefined || relations.relationshipTruncated
      || relations.duplicateChain.length > 0 || relations.relatedPullRequests.length > 0) {
      ledger.push({ stableSourceId: `github:${issue.id}`, sourceFamilyId: familyId, accepted: false, reason: 'issue-basis-gate' })
      continue
    }
    if (partition === 'natural' && naturalIssueVariant(familyId) === 0) {
      addCandidate(output, source, {
        stableSourceId: `github:${issue.id}`,
        sourceFamilyId: familyId,
        construction: 'natural-issue',
        queue: 'natural', constructionFamily: null, objectType: 'issue',
        text: issueText(issue), authorId, url: issue.url, nodeId: issue.id,
        createdAt: issue.createdAt,
        contentUpdatedAt: issue.lastEditedAt ?? issue.createdAt,
        relatedPullRequests: relations.relatedPullRequests, duplicateChain: relations.duplicateChain,
        evidence: { issue },
      }, spec, ledger)
      continue
    }
    if (partition === 'natural') {
      const eligible = (commentsByIssue.get(issue.number) ?? []).filter(comment => (
        immutableRest(comment) && humanLogin(comment.user?.login) !== undefined
      )).sort((left, right) => deterministicOrder('natural-issue-comment', left.node_id)
        .localeCompare(deterministicOrder('natural-issue-comment', right.node_id)))
      const comment = eligible[0]
      if (comment === undefined) {
        ledger.push({ stableSourceId: `github:${issue.id}`, sourceFamilyId: familyId, accepted: false, reason: 'natural-comment-missing' })
        continue
      }
      addCandidate(output, source, {
        stableSourceId: `github:${comment.node_id}`,
        sourceFamilyId: familyId,
        construction: 'natural-issue-comment',
        queue: 'natural', constructionFamily: null, objectType: 'issue-comment-request',
        text: commentText(comment), authorId: humanLogin(comment.user.login),
        url: comment.html_url, nodeId: comment.node_id,
        createdAt: comment.created_at, contentUpdatedAt: comment.updated_at,
        relatedPullRequests: relations.relatedPullRequests, duplicateChain: relations.duplicateChain,
        evidence: { issue, comment },
      }, spec, ledger)
      continue
    }
    if (partition === 'decision') {
      const timeline = (commentsByIssue.get(issue.number) ?? []).filter(comment => (
        immutableRest(comment) && humanLogin(comment.user?.login) !== undefined
      )).sort((left, right) => timestamp(left.created_at, 'issue comment') - timestamp(right.created_at, 'issue comment'))
      const comment = timeline.at(-1)
      if (comment === undefined || !maintainerAssociations.has(comment.author_association)
        || !unresolvedAlternative(comment.body, source.nativeLanguage)) {
        ledger.push({ stableSourceId: `github:${issue.id}`, sourceFamilyId: familyId, accepted: false, reason: 'decision-construction-missing' })
        continue
      }
      addCandidate(output, source, {
        stableSourceId: `github:${comment.node_id}`,
        sourceFamilyId: familyId,
        construction: 'decision-question',
        queue: 'challenge', constructionFamily: 'decision', objectType: 'issue-comment-request',
        text: cleanText(`Original request:\n${issueText(issue)}\n\nLatest maintainer question:\n${comment.body}`),
        authorId: humanLogin(comment.user.login), url: comment.html_url, nodeId: comment.node_id,
        createdAt: issue.createdAt, contentUpdatedAt: comment.updated_at,
        relatedPullRequests: relations.relatedPullRequests, duplicateChain: relations.duplicateChain,
        evidence: { issue, latestComment: comment },
      }, spec, ledger)
      continue
    }
    const text = issueText(issue)
    if (!repositoryContingent(text, source.nativeLanguage)) {
      ledger.push({ stableSourceId: `github:${issue.id}`, sourceFamilyId: familyId, accepted: false, reason: 'repository-contingent-construction-missing' })
      continue
    }
    addCandidate(output, source, {
      stableSourceId: `github:${issue.id}`,
      sourceFamilyId: familyId,
      construction: 'repository-contingent-issue',
      queue: 'challenge', constructionFamily: 'repository-contingent', objectType: 'issue',
      text, authorId, url: issue.url, nodeId: issue.id,
      createdAt: issue.createdAt, contentUpdatedAt: issue.lastEditedAt ?? issue.createdAt,
      relatedPullRequests: [], relatedCommits: [baseCommit], duplicateChain: [],
      evidence: { issue, repositoryBaseAtCutoff: baseCommit },
    }, spec, ledger)
  }
  for (const comment of comments) {
    const number = issueNumberFromApiUrl(comment.issue_url)
    if (number !== undefined && !issueByNumber.has(number)) {
      ledger.push({ stableSourceId: `github:${comment.node_id}`, sourceFamilyId: sourceFamilyId(source, 'issue', number), accepted: false, reason: 'parent-outside-frozen-issue-window' })
    }
  }
  return { output, ledger }
}

export function buildDiscussionRows(source, discussions, baseCommit, spec) {
  const output = []
  const ledger = []
  const frozenCategories = new Set(source.discussionCategoryIds)
  for (const discussion of discussions) {
    const familyId = sourceFamilyId(source, 'discussion', discussion.number)
    const partition = partitionFor('discussion', familyId)
    const authorId = humanLogin(discussion.author?.login)
    if (!immutableGraphql(discussion) || authorId === undefined || !frozenCategories.has(discussion.category?.id)) {
      ledger.push({ stableSourceId: `github:${discussion.id}`, sourceFamilyId: familyId, accepted: false, reason: 'discussion-basis-gate' })
      continue
    }
    const text = cleanText(`${discussion.title}\n\n${discussion.body}`)
    if (partition === 'natural') {
      addCandidate(output, source, {
        stableSourceId: `github:${discussion.id}`,
        sourceFamilyId: familyId,
        construction: 'natural-discussion',
        queue: 'natural', constructionFamily: null, objectType: 'discussion',
        text, authorId, url: discussion.url, nodeId: discussion.id,
        createdAt: discussion.createdAt,
        contentUpdatedAt: discussion.lastEditedAt ?? discussion.createdAt,
        relatedPullRequests: [], relatedCommits: [], duplicateChain: [],
        evidence: { discussion },
      }, spec, ledger)
    } else if (partition === 'repository-contingent' && repositoryContingent(text, source.nativeLanguage)) {
      addCandidate(output, source, {
        stableSourceId: `github:${discussion.id}`,
        sourceFamilyId: familyId,
        construction: 'repository-contingent-discussion',
        queue: 'challenge', constructionFamily: 'repository-contingent', objectType: 'discussion',
        text, authorId, url: discussion.url, nodeId: discussion.id,
        createdAt: discussion.createdAt,
        contentUpdatedAt: discussion.lastEditedAt ?? discussion.createdAt,
        relatedPullRequests: [], relatedCommits: [baseCommit], duplicateChain: [],
        evidence: { discussion, repositoryBaseAtCutoff: baseCommit },
      }, spec, ledger)
    } else {
      ledger.push({ stableSourceId: `github:${discussion.id}`, sourceFamilyId: familyId, accepted: false, reason: `${partition}-construction-missing` })
    }
  }
  return { output, ledger }
}

export function buildReviewCommentRows(source, comments, spec) {
  const output = []
  const ledger = []
  const byPull = groupBy(comments, comment => pullNumberFromApiUrl(comment.pull_request_url))
  for (const [number, values] of byPull) {
    const familyId = sourceFamilyId(source, 'pull', number)
    const partition = partitionFor('pull-request', familyId)
    if (!['natural', 'bounded'].includes(partition)) continue
    const eligible = values.filter(comment => (
      immutableRest(comment) && humanLogin(comment.user?.login) !== undefined
      && comment.path && comment.diff_hunk
      && (partition !== 'bounded' || (maintainerAssociations.has(comment.author_association)
        && cleanText(comment.body).length <= spec.limits.maximumBoundedBodyCharacters
        && actionRequest(comment.body, source.nativeLanguage)))
    )).sort((left, right) => deterministicOrder(`${partition}-review-comment`, left.node_id)
      .localeCompare(deterministicOrder(`${partition}-review-comment`, right.node_id)))
    const comment = eligible[0]
    if (comment === undefined) {
      ledger.push({ stableSourceId: `github:${source.repositoryNodeId}:pull:${number}`, sourceFamilyId: familyId, accepted: false, reason: `${partition}-review-comment-missing` })
      continue
    }
    addCandidate(output, source, {
      stableSourceId: `github:${comment.node_id}`,
      sourceFamilyId: familyId,
      construction: partition === 'bounded' ? 'bounded-inline-review' : 'natural-pull-review',
      queue: partition === 'natural' ? 'natural' : 'challenge',
      constructionFamily: partition === 'bounded' ? 'bounded' : null,
      objectType: 'pull-review',
      text: reviewCommentText(comment, partition === 'bounded'),
      authorId: humanLogin(comment.user.login), url: comment.html_url, nodeId: comment.node_id,
      createdAt: comment.created_at, contentUpdatedAt: comment.updated_at,
      relatedPullRequests: [pullWebUrl(source, number)],
      relatedCommits: [comment.commit_id, comment.original_commit_id].filter(Boolean),
      duplicateChain: [], evidence: { reviewComment: comment },
    }, spec, ledger)
  }
  return { output, ledger }
}

function validReview(review) {
  const submitted = review.submittedAt ?? review.createdAt
  return submitted !== null && immutableGraphql(review)
    && atOrBeforeCutoff(submitted, `${review.id}.submittedAt`)
    && humanLogin(review.author?.login) !== undefined
    && maintainerAssociations.has(review.authorAssociation)
    && ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state)
    && cleanText(review.body).length >= 20
}

export function buildContinuityRow(source, pullRequest, spec) {
  const familyId = sourceFamilyId(source, 'pull', pullRequest.number)
  const ledger = []
  if (partitionFor('pull-request', familyId) !== 'continuity' || !immutableGraphql(pullRequest)
    || pullRequest.reviews?.pageInfo?.hasNextPage === true || pullRequest.commits?.pageInfo?.hasNextPage === true) {
    return { output: [], ledger: [{ stableSourceId: `github:${pullRequest.id}`, sourceFamilyId: familyId, accepted: false, reason: 'continuity-partition-or-basis-gate' }] }
  }
  const reviews = (pullRequest.reviews?.nodes ?? []).filter(validReview)
    .sort((left, right) => timestamp(left.submittedAt ?? left.createdAt, 'review') - timestamp(right.submittedAt ?? right.createdAt, 'review'))
  const commits = (pullRequest.commits?.nodes ?? []).map(value => value.commit)
    .filter(commit => atOrBeforeCutoff(commit.committedDate, `${commit.oid}.committedDate`))
    .sort((left, right) => timestamp(left.committedDate, 'commit') - timestamp(right.committedDate, 'commit'))
  let chain
  for (let firstIndex = 0; firstIndex < reviews.length && chain === undefined; firstIndex += 1) {
    const first = reviews[firstIndex]
    if (first.state !== 'CHANGES_REQUESTED') continue
    const firstTime = timestamp(first.submittedAt ?? first.createdAt, 'first review')
    for (let secondIndex = firstIndex + 1; secondIndex < reviews.length; secondIndex += 1) {
      const second = reviews[secondIndex]
      const secondTime = timestamp(second.submittedAt ?? second.createdAt, 'second review')
      const between = commits.filter(commit => {
        const value = timestamp(commit.committedDate, 'intervening commit')
        return value > firstTime && value < secondTime
      })
      if (between.length > 0) {
        chain = { reviews: [first, second].slice(0, spec.limits.maximumContinuityReviews), commits: between }
        break
      }
    }
  }
  if (chain === undefined) {
    return { output: [], ledger: [{ stableSourceId: `github:${pullRequest.id}`, sourceFamilyId: familyId, accepted: false, reason: 'continuity-chain-missing' }] }
  }
  const authorId = humanLogin(chain.reviews[0].author.login)
  const text = cleanText([
    'Initial pull request task:',
    `${pullRequest.title}\n\n${pullRequest.body}`,
    ...chain.reviews.map((review, index) => `Review round ${index + 1} (${review.submittedAt ?? review.createdAt}):\n${review.body}`),
  ].join('\n\n'))
  const stableSourceId = `github:continuity:${pullRequest.id}:${chain.reviews.map(review => review.id).join(':')}`
  const output = []
  addCandidate(output, source, {
    stableSourceId, sourceFamilyId: familyId, construction: 'continuity-review-chain',
    queue: 'challenge', constructionFamily: 'continuity', objectType: 'pull-review',
    text, authorId, url: pullRequest.url, nodeId: pullRequest.id,
    createdAt: pullRequest.createdAt,
    contentUpdatedAt: latestTimestamp([
      pullRequest.lastEditedAt ?? pullRequest.createdAt,
      ...chain.reviews.map(review => review.lastEditedAt ?? review.submittedAt ?? review.createdAt),
    ]),
    relatedPullRequests: [pullRequest.url],
    relatedCommits: chain.commits.map(commit => commit.oid), duplicateChain: [],
    evidence: { pullRequest: { ...pullRequest, reviews: undefined, commits: undefined }, ...chain },
  }, spec, ledger)
  return { output, ledger }
}

function indexPriorShingles(records) {
  const normalized = records.map((record, index) => ({ ...record, index, shingles: fiveShingles(record.text) }))
  const index = new Map()
  for (const record of normalized) {
    for (const shingle of record.shingles) {
      if (!index.has(shingle)) index.set(shingle, [])
      index.get(shingle).push(record.index)
    }
  }
  return { normalized, index }
}

function priorNearDuplicate(row, priorIndex) {
  const shingles = fiveShingles(row.text)
  const candidates = new Set()
  for (const shingle of shingles) for (const index of priorIndex.index.get(shingle) ?? []) candidates.add(index)
  for (const index of candidates) {
    if (shingleJaccard(shingles, priorIndex.normalized[index].shingles) >= 0.85) return true
  }
  return false
}

export function removePromptDuplicates(pairs, prior) {
  const priorPromptDigests = new Set(prior.promptDigests)
  const priorCanonicalDigests = new Set(prior.canonicalDigests)
  const priorIndex = indexPriorShingles(prior.promptRecords)
  const retained = []
  const rejected = []
  const exact = new Map()
  for (const pair of pairs) {
    if (priorPromptDigests.has(pair.row.promptDigest) || priorCanonicalDigests.has(pair.row.canonicalPromptDigest)
      || priorNearDuplicate(pair.row, priorIndex)) {
      rejected.push({ stableSourceId: pair.row.stableSourceId, sourceFamilyId: pair.row.sourceFamilyId, accepted: false, reason: 'prior-prompt-overlap' })
      continue
    }
    const key = pair.row.canonicalPromptDigest
    if (!exact.has(key)) exact.set(key, [])
    exact.get(key).push(pair)
  }
  for (const group of exact.values()) {
    group.sort((left, right) => deterministicOrder('exact-prompt-canonical', left.row.stableSourceId)
      .localeCompare(deterministicOrder('exact-prompt-canonical', right.row.stableSourceId)))
    retained.push(group[0])
    for (const pair of group.slice(1)) rejected.push({ stableSourceId: pair.row.stableSourceId, sourceFamilyId: pair.row.sourceFamilyId, accepted: false, reason: 'current-exact-prompt-duplicate' })
  }
  const clusters = nearDuplicateClusters(retained.map(pair => ({ id: pair.row.stableSourceId, text: pair.row.text })))
  const dropped = new Set()
  for (const cluster of clusters) {
    const members = retained.filter(pair => cluster.members.includes(pair.row.stableSourceId))
      .sort((left, right) => deterministicOrder('near-duplicate-cluster', left.row.stableSourceId)
        .localeCompare(deterministicOrder('near-duplicate-cluster', right.row.stableSourceId)))
    for (const pair of members.slice(1)) {
      dropped.add(pair.row.stableSourceId)
      rejected.push({ stableSourceId: pair.row.stableSourceId, sourceFamilyId: pair.row.sourceFamilyId, accepted: false, reason: 'current-near-duplicate-cluster' })
    }
  }
  return { pairs: retained.filter(pair => !dropped.has(pair.row.stableSourceId)), rejected }
}

async function mapLimit(values, limit, operation) {
  const results = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return results
}

async function githubToken() {
  const { stdout } = await execFileAsync('gh', ['auth', 'token'], { encoding: 'utf8' })
  const token = stdout.trim()
  if (token === '') throw new Error('gh auth token returned an empty credential')
  return token
}

async function githubRequest(token, url, init, attempt = 1) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-plan-lattice-v8-source-frame',
      ...(init.headers ?? {}),
    },
  })
  if (response.ok) return response.json()
  if (attempt < 4 && transientStatuses.has(response.status)) {
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
    const retryAfter = Number(response.headers.get('retry-after')) * 1000
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() + 1000 : 1000 * (2 ** attempt)
    await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(delay, 15 * 60 * 1000)))
    return githubRequest(token, url, init, attempt + 1)
  }
  throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`)
}

async function rest(token, path, parameters = {}) {
  const url = new URL(`https://api.github.com${path}`)
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
  return githubRequest(token, url, { method: 'GET' })
}

async function graphql(token, query, variables) {
  const value = await githubRequest(token, 'https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    throw new Error(`GitHub GraphQL failed: ${value.errors.map(error => error.type ?? 'unknown').join(', ')}`)
  }
  return value.data
}

function repositoryParts(repository) {
  const [owner, name] = repository.split('/')
  return { owner, name }
}

async function listFixedPages(token, path, pages, perPage) {
  const values = []
  for (let page = 1; page <= pages; page += 1) {
    const result = await rest(token, path, { sort: 'created', direction: 'desc', per_page: perPage, page })
    if (!Array.isArray(result)) throw new Error(`${path} did not return an array`)
    values.push(...result)
    if (result.length < perPage) break
  }
  return values
}

async function collectRepository(token, source, spec) {
  const { owner, name } = repositoryParts(source.repository)
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const [baseCommits, issueData, issueComments, discussionData, reviewComments, pullRequests] = await Promise.all([
    rest(token, `${repoPath}/commits`, { until: cutoff, per_page: 1, page: 1 }),
    source.objectTypes.includes('issue') || source.objectTypes.includes('issue-comment-request')
      ? graphql(token, issueQuery, { owner, name, count: spec.limits.issuesPerRepository, closingCount: spec.limits.closingPullRequestsPerIssue })
      : undefined,
    source.objectTypes.includes('issue-comment-request')
      ? listFixedPages(token, `${repoPath}/issues/comments`, spec.limits.issueCommentPagesPerRepository, spec.limits.issueCommentsPerPage)
      : [],
    source.objectTypes.includes('discussion')
      ? graphql(token, discussionQuery, { owner, name, count: spec.limits.discussionsPerRepository })
      : undefined,
    source.objectTypes.includes('pull-review')
      ? listFixedPages(token, `${repoPath}/pulls/comments`, spec.limits.reviewCommentPagesPerRepository, spec.limits.reviewCommentsPerPage)
      : [],
    source.objectTypes.includes('pull-review')
      ? rest(token, `${repoPath}/pulls`, { state: 'all', sort: 'created', direction: 'desc', per_page: spec.limits.pullRequestsPerRepository, page: 1 })
      : [],
  ])
  if (!Array.isArray(baseCommits) || baseCommits.length !== 1) throw new Error(`${source.repository} has no commit at or before cutoff`)
  if (issueData !== undefined && issueData.repository?.id !== source.repositoryNodeId) throw new Error(`${source.repository} GraphQL issue identity drifted`)
  if (discussionData !== undefined && discussionData.repository?.id !== source.repositoryNodeId) throw new Error(`${source.repository} GraphQL discussion identity drifted`)
  const continuityPulls = pullRequests.filter(pull => {
    const familyId = sourceFamilyId(source, 'pull', pull.number)
    return partitionFor('pull-request', familyId) === 'continuity'
      && immutableRest(pull) && humanLogin(pull.user?.login) !== undefined
  })
  const continuity = await mapLimit(continuityPulls, spec.limits.concurrency, async pull => {
    const value = await graphql(token, continuityQuery, {
      owner, name, number: pull.number,
      reviewCount: spec.limits.reviewsPerContinuityPullRequest,
      commitCount: spec.limits.commitsPerContinuityPullRequest,
    })
    if (value.repository?.id !== source.repositoryNodeId || value.repository.pullRequest?.id !== pull.node_id) {
      throw new Error(`${source.repository}#${pull.number} continuity identity drifted`)
    }
    return value.repository.pullRequest
  })
  return {
    source,
    baseCommit: baseCommits[0].sha,
    issues: issueData?.repository?.issues?.nodes ?? [],
    issueComments,
    discussions: discussionData?.repository?.discussions?.nodes ?? [],
    reviewComments,
    continuity,
  }
}

function theoreticalCapacity(rows) {
  const failures = []
  for (const language of languages) {
    const natural = rows.filter(row => row.language === language && row.queue === 'natural')
    if (natural.length < queueCounts.naturalPerLanguage) failures.push(`natural/${language} has ${natural.length}`)
    for (const objectType of ['issue', 'discussion', 'issue-comment-request', 'pull-review']) {
      const count = natural.filter(row => row.objectType === objectType).length
      if (count < 100) failures.push(`natural/${language}/${objectType} has ${count}`)
    }
    if (new Set(natural.map(row => row.repository)).size < 40) failures.push(`natural/${language} has fewer than 40 repositories`)
    for (const family of challengeFamilies) {
      const challenge = rows.filter(row => row.language === language && row.queue === 'challenge' && row.constructionFamily === family)
      if (challenge.length < queueCounts.challengePerFamilyPerLanguage) failures.push(`challenge/${language}/${family} has ${challenge.length}`)
      if (new Set(challenge.map(row => row.repository)).size < 15) failures.push(`challenge/${language}/${family} has fewer than 15 repositories`)
      if (new Set(challenge.map(row => row.organization)).size < 8) failures.push(`challenge/${language}/${family} has fewer than 8 organizations`)
    }
  }
  return failures
}

async function main() {
  const registryPath = resolve(option('--registry') ?? resolve(here, 'source-registry.frozen.json'))
  const specPath = resolve(option('--spec') ?? resolve(here, 'source-frame-spec.json'))
  const framePath = option('--frame')
  const auditPath = option('--audit')
  const ledgerPath = option('--ledger')
  const manifestPath = option('--manifest')
  const failurePath = option('--failure-manifest')
  if ([framePath, auditPath, ledgerPath, manifestPath, failurePath].some(value => value === undefined)) {
    throw new Error('usage: collect-source-frame.mjs --frame <private.jsonl> --audit <private.jsonl> --ledger <private.jsonl> --manifest <json> --failure-manifest <json>')
  }
  const outputs = [framePath, auditPath, ledgerPath, manifestPath, failurePath].map(value => resolve(value))
  await assertArtifactsAbsent(outputs, 'V8 source-frame collection')
  const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: resolve(here, '../../..'), encoding: 'utf8' })
  if (status.stdout.trim() !== '') throw new Error('source-frame collection requires a clean committed worktree')
  const [registryText, specText, freezeManifestText, collectorText, protocolText] = await Promise.all([
    readFile(registryPath, 'utf8'),
    readFile(specPath, 'utf8'),
    readFile(resolve(here, 'source-registry-freeze-manifest.json'), 'utf8'),
    readFile(scriptPath, 'utf8'),
    readFile(resolve(here, 'SOURCE_FRAME_PROTOCOL.md'), 'utf8'),
  ])
  const registry = validateRegistry(JSON.parse(registryText))
  const spec = validateSpec(JSON.parse(specText))
  const freezeManifest = JSON.parse(freezeManifestText)
  if (sha256(registryText) !== spec.registrySha256 || freezeManifest.registrySha256 !== spec.registrySha256) {
    throw new Error('source-frame registry binding mismatch')
  }
  const token = await githubToken()
  const collected = await mapLimit(registry.sources, spec.limits.concurrency, source => collectRepository(token, source, spec))
  const pairs = []
  const ledger = []
  for (const repository of collected) {
    const issueRows = buildIssueRows(repository.source, repository.issues, repository.issueComments, repository.baseCommit, spec)
    const discussionRows = buildDiscussionRows(repository.source, repository.discussions, repository.baseCommit, spec)
    const reviewRows = buildReviewCommentRows(repository.source, repository.reviewComments, spec)
    pairs.push(...issueRows.output, ...discussionRows.output, ...reviewRows.output)
    ledger.push(...issueRows.ledger, ...discussionRows.ledger, ...reviewRows.ledger)
    for (const pullRequest of repository.continuity) {
      const result = buildContinuityRow(repository.source, pullRequest, spec)
      pairs.push(...result.output)
      ledger.push(...result.ledger)
    }
  }
  const prior = await priorSourceInventory()
  const deduplicated = removePromptDuplicates(pairs, prior)
  ledger.push(...deduplicated.rejected)
  const sortedPairs = deduplicated.pairs.sort((left, right) => left.row.stableSourceId.localeCompare(right.row.stableSourceId))
  const frame = sortedPairs.map((pair, index) => validateFrameRow(pair.row, index, registry))
  if (new Set(frame.map(row => row.stableSourceId)).size !== frame.length) throw new Error('source frame duplicates stableSourceId')
  if (new Set(frame.map(row => row.sourceFamilyId)).size !== frame.length) throw new Error('source frame duplicates sourceFamilyId')
  assertSourceDisjoint(frame, prior)
  const capacityFailures = theoreticalCapacity(frame)
  const frameText = stableLines(frame)
  const auditText = stableLines(sortedPairs.map(pair => pair.audit))
  const ledgerText = stableLines(ledger.sort((left, right) => (
    left.sourceFamilyId.localeCompare(right.sourceFamilyId) || left.stableSourceId.localeCompare(right.stableSourceId)
  )))
  const { stdout: commitText } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: resolve(here, '../../..'), encoding: 'utf8' })
  const manifest = {
    schemaVersion: 1,
    protocol: protocolId,
    evidenceStatus: capacityFailures.length === 0 ? 'source-frame-frozen-before-seed-reveal' : 'retired-before-seed-reveal',
    cutoff,
    sourceFrameCommit: commitText.trim(),
    seedCommitment: collectionSeedCommitment,
    seedAccessed: false,
    counts: {
      frame: frame.length,
      queue: Object.fromEntries(['natural', 'challenge'].map(queue => [queue, frame.filter(row => row.queue === queue).length])),
      languages: Object.fromEntries(languages.map(language => [language, frame.filter(row => row.language === language).length])),
      naturalObjectTypes: Object.fromEntries(languages.map(language => [language, Object.fromEntries(
        ['issue', 'discussion', 'issue-comment-request', 'pull-review'].map(type => [type, frame.filter(row => row.language === language && row.queue === 'natural' && row.objectType === type).length]),
      )])),
      challengeFamilies: Object.fromEntries(languages.map(language => [language, Object.fromEntries(
        challengeFamilies.map(family => [family, frame.filter(row => row.language === language && row.queue === 'challenge' && row.constructionFamily === family).length]),
      )])),
    },
    capacityFailures,
    digests: {
      sourceFrame: sha256(frameText),
      privateAudit: sha256(auditText),
      rejectionLedger: sha256(ledgerText),
      registry: sha256(registryText),
      registryFreezeManifest: sha256(freezeManifestText),
      spec: sha256(specText),
      collector: sha256(collectorText),
      sourceFrameProtocol: sha256(protocolText),
      priorInventoryFiles: sha256(JSON.stringify(prior.files)),
    },
  }
  if (capacityFailures.length > 0) {
    await Promise.all([
      writeExclusive(resolve(framePath), frameText),
      writeExclusive(resolve(auditPath), auditText),
      writeExclusive(resolve(ledgerPath), ledgerText),
      writeExclusive(resolve(failurePath), `${JSON.stringify(manifest, null, 2)}\n`),
    ])
    throw new Error(`V8 source frame retired: ${capacityFailures[0]}`)
  }
  await Promise.all([
    writeExclusive(resolve(framePath), frameText),
    writeExclusive(resolve(auditPath), auditText),
    writeExclusive(resolve(ledgerPath), ledgerText),
    writeExclusive(resolve(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`),
  ])
  console.log(JSON.stringify(manifest, null, 2))
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
