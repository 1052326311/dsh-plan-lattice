#!/usr/bin/env node

import { ProtocolFailure, cutoff, sha256 } from './protocol.mjs'
import { canonicalPrompt } from './source-isolation.mjs'

const cutoffTimestamp = Date.parse(cutoff)

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

function repositorySelection(depth) {
  const parent = depth > 0 ? `parent { ${repositorySelection(depth - 1)} }` : ''
  return `id nameWithOwner isFork ${parent}`
}

export function githubGraphqlQuery(spec) {
  const repository = `
    id
    nameWithOwner
    owner { login }
    primaryLanguage { name }
    isFork
    parent { ${repositorySelection(spec.limits.maximumRepositoryLineageDepth - 1)} }
    defaultBranchRef {
      name
      target {
        __typename
        ... on Commit {
          oid
          committedDate
          history(first: 1, until: $cutoff) {
            nodes { oid committedDate }
          }
        }
      }
    }
  `
  return `
    query V11Sources(
      $ids: [ID!]!
      $cutoff: GitTimestamp!
      $commentLimit: Int!
      $reviewLimit: Int!
      $threadLimit: Int!
      $threadCommentLimit: Int!
      $commitLimit: Int!
      $includeIssueComments: Boolean!
      $includePullTimeline: Boolean!
    ) {
      nodes(ids: $ids) {
        __typename
        ... on Issue {
          id number url title body createdAt updatedAt lastEditedAt
          author { __typename login }
          repository { ${repository} }
          comments(first: $commentLimit) @include(if: $includeIssueComments) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id url body createdAt updatedAt lastEditedAt authorAssociation
              author { __typename login }
            }
          }
        }
        ... on PullRequest {
          id number url title body createdAt updatedAt lastEditedAt
          author { __typename login }
          repository { ${repository} }
          reviews(first: $reviewLimit) @include(if: $includePullTimeline) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id url body state submittedAt createdAt updatedAt lastEditedAt authorAssociation
              author { __typename login }
              commit { oid }
            }
          }
          reviewThreads(first: $threadLimit) @include(if: $includePullTimeline) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              comments(first: $threadCommentLimit) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  id url body path diffHunk createdAt updatedAt lastEditedAt authorAssociation
                  author { __typename login }
                  commit { oid }
                }
              }
            }
          }
          commits(first: $commitLimit) @include(if: $includePullTimeline) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { commit { oid committedDate message } }
          }
        }
      }
      rateLimit { cost remaining resetAt }
    }
  `
}

export function graphqlVariables(spec, requirements = {}) {
  return {
    cutoff,
    commentLimit: spec.limits.maximumTimelineComments,
    reviewLimit: spec.limits.maximumPullReviews,
    threadLimit: spec.limits.maximumPullReviewThreads,
    threadCommentLimit: spec.limits.maximumPullReviewCommentsPerThread,
    commitLimit: spec.limits.maximumPullCommits,
    includeIssueComments: requirements.includeIssueComments === true,
    includePullTimeline: requirements.includePullTimeline === true,
  }
}

function atOrBeforeCutoff(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= cutoffTimestamp
}

function humanLogin(author) {
  const login = cleanText(author?.login)
  if (login === '' || author?.__typename === 'Bot' || /(?:\[bot\]|-bot|_bot)$/iu.test(login)) return undefined
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

export function actionRequest(text, language) {
  return language === 'zh'
    ? /(?:请|需要|应该|必须|改为|替换|删除|添加|使用|不要|移动|更新|修改|修复|实现|支持)/u.test(text)
    : /\b(?:please|should|must|need(?:s)? to|change|replace|remove|add|rename|use|avoid|move|update|fix|implement|support|refactor)\b/iu.test(text)
}

export function unresolvedQuestion(text, language) {
  if (!/[?？]/u.test(text)) return false
  return language === 'zh'
    ? /(?:还是|或者|是否|哪种|选择|决定|要不要|能否|可以|怎么|如何|什么)/u.test(text)
    : /\b(?:either|or|which|whether|should|do you|would you|can you|could you|choose|decide|what|how)\b/iu.test(text)
}

export function repositoryContingent(text, language) {
  const states = language === 'zh'
    ? /(?:如果|若)[\s\S]{0,1000}(?:否则|不然)|取决于是否|是否已经|当前(?:实现|代码|配置)|现有(?:实现|代码|配置)/u.test(text)
    : /\b(?:if|when|unless)\b[\s\S]{0,1000}\b(?:else|otherwise)\b|\bdepending on whether\b|\bwhether\b[\s\S]{0,180}\balready\b|\bcurrent (?:implementation|code|config)|\bexisting (?:implementation|code|config)/iu.test(text)
  const artifact = /`[^`\n]{2,160}`|(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|cpp|c|h|json|ya?ml|toml)\b|(?:配置|代码|文件|目录|实现)/iu.test(text)
  return states && artifact
}

function issueText(node) {
  return cleanText(`${node.title}\n\n${node.body ?? ''}`)
}

function connectionRejection(connection, limit, label) {
  if (connection === null || typeof connection !== 'object' || !Array.isArray(connection.nodes)
    || !Number.isInteger(connection.totalCount) || connection.totalCount < 0 || connection.pageInfo === undefined) {
    return { reason: 'timeline-shape-invalid', detail: label }
  }
  if (connection.pageInfo.hasNextPage === true || connection.totalCount !== connection.nodes.length
    || connection.nodes.length > limit) {
    return { reason: 'timeline-pagination-truncated', detail: label }
  }
  return undefined
}

export function repositoryIdentity(repository, maximumDepth) {
  if (!repository || typeof repository.nameWithOwner !== 'string' || typeof repository.id !== 'string') {
    return { rejection: { reason: 'repository-identity-missing' } }
  }
  let current = repository
  let depth = 0
  while (current.parent && depth < maximumDepth) {
    current = current.parent
    depth += 1
  }
  if ((current.isFork === true && !current.parent) || (depth === maximumDepth && current.isFork === true)) {
    return { rejection: { reason: 'repository-lineage-truncated', detail: repository.nameWithOwner } }
  }
  return {
    repository: repository.nameWithOwner.toLowerCase(),
    repositoryNodeId: repository.id,
    networkRoot: current.nameWithOwner.toLowerCase(),
    organization: repository.owner?.login?.toLowerCase(),
    ecosystem: cleanText(repository.primaryLanguage?.name || 'unknown').toLowerCase(),
  }
}

export function repositoryBaseAtCutoff(repository) {
  const target = repository?.defaultBranchRef?.target
  const commit = target?.__typename === 'Commit' ? target.history?.nodes?.[0] : undefined
  if (!commit || !/^[0-9a-f]{40}$/iu.test(commit.oid ?? '') || !atOrBeforeCutoff(commit.committedDate)) {
    return { rejection: { reason: 'cutoff-base-commit-unavailable' } }
  }
  return { oid: commit.oid.toLowerCase(), committedDate: commit.committedDate }
}

function sourceTimestampValid(value) {
  return value === null || value === undefined || atOrBeforeCutoff(value)
}

function nodeAtCutoff(node) {
  return atOrBeforeCutoff(node.createdAt) && atOrBeforeCutoff(node.updatedAt)
    && sourceTimestampValid(node.lastEditedAt)
}

function feedbackItems(node, associations, language) {
  const reviews = node.reviews.nodes.map(review => ({
    kind: 'review',
    id: review.id,
    url: review.url,
    body: review.body,
    createdAt: review.submittedAt ?? review.createdAt,
    updatedAt: review.submittedAt ?? review.updatedAt ?? review.createdAt,
    lastEditedAt: review.lastEditedAt,
    state: review.state,
    commitId: review.commit?.oid,
    authorAssociation: review.authorAssociation,
    author: review.author,
    path: null,
    diffHunk: null,
    raw: review,
  }))
  const comments = node.reviewThreads.nodes.flatMap(thread => thread.comments.nodes).map(comment => ({
    kind: 'inline-review',
    id: comment.id,
    url: comment.url,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    lastEditedAt: comment.lastEditedAt,
    state: 'COMMENTED',
    commitId: comment.commit?.oid,
    authorAssociation: comment.authorAssociation,
    author: comment.author,
    path: comment.path,
    diffHunk: comment.diffHunk,
    raw: comment,
  }))
  return [...reviews, ...comments].filter(feedback => (
    humanLogin(feedback.author) !== undefined
    && associations.has(feedback.authorAssociation)
    && atOrBeforeCutoff(feedback.createdAt)
    && atOrBeforeCutoff(feedback.updatedAt)
    && sourceTimestampValid(feedback.lastEditedAt)
    && cleanText(feedback.body).length >= 10
    && (feedback.state === 'CHANGES_REQUESTED' || actionRequest(feedback.body, language))
  )).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
}

function feedbackText(feedback) {
  return cleanText([
    feedback.path ? `File: ${feedback.path}` : null,
    feedback.body,
    feedback.diffHunk ? `Observed diff context:\n${feedback.diffHunk}` : null,
  ].filter(Boolean).join('\n\n'))
}

function frameRow(candidate, node, identity, input) {
  const text = cleanText(input.text)
  return {
    stableSourceId: input.stableSourceId,
    sourceFamilyId: candidate.familyId,
    queue: input.family === 'natural' ? 'natural' : 'challenge',
    constructionFamily: input.family === 'natural' ? null : input.family,
    construction: input.construction,
    language: candidate.language,
    text,
    platform: 'github',
    objectType: input.objectType,
    repository: identity.repository,
    repositoryNodeId: identity.repositoryNodeId,
    networkRoot: identity.networkRoot,
    organization: identity.organization,
    ecosystem: identity.ecosystem,
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

function reject(reason, detail) {
  return { rejection: { reason, ...(detail === undefined ? {} : { detail }) } }
}

export function materializeCandidate(candidate, node, spec) {
  const expectedType = candidate.item.pull_request ? 'PullRequest' : 'Issue'
  if (!node || node.__typename !== expectedType || node.id !== candidate.item.node_id) {
    throw new ProtocolFailure('graphql-node-identity-mismatch', `GraphQL node does not match ${candidate.familyId}`, {
      stage: 'graphql-materialization', operation: candidate.familyId,
    })
  }
  const expectedRepository = candidate.familyId.split(':')[1]
  if (node.repository?.nameWithOwner?.toLowerCase() !== expectedRepository) {
    throw new ProtocolFailure('graphql-repository-identity-drift', `repository changed while resolving ${candidate.familyId}`, {
      stage: 'graphql-materialization', operation: candidate.familyId,
    })
  }
  if (!nodeAtCutoff(node)) {
    throw new ProtocolFailure('graphql-cutoff-drift', `source changed after the V11 cutoff: ${candidate.familyId}`, {
      stage: 'graphql-materialization', operation: candidate.familyId,
    })
  }
  const identityResult = repositoryIdentity(node.repository, spec.limits.maximumRepositoryLineageDepth)
  if (identityResult.rejection) return identityResult
  const identity = identityResult
  if (!identity.organization || humanLogin(node.author) === undefined) return reject('human-or-repository-gate')
  const text = issueText(node)
  const associations = new Set(spec.authorAssociations)
  let row
  if (candidate.search.family === 'natural') {
    row = frameRow(candidate, node, identity, {
      stableSourceId: `github:${node.id}`,
      family: 'natural',
      construction: 'global-search-natural-issue-page-2-plus',
      objectType: 'issue',
      text,
      authorId: humanLogin(node.author),
      url: node.url,
      nodeId: node.id,
      createdAt: node.createdAt,
      contentUpdatedAt: node.updatedAt,
      evidence: { searchId: candidate.search.id, node },
    })
  } else if (candidate.search.family === 'decision') {
    const incomplete = connectionRejection(node.comments, spec.limits.maximumTimelineComments, 'issue-comments')
    if (incomplete) return { rejection: incomplete }
    if (!actionRequest(text, candidate.language)) return reject('construction-gate')
    const comments = node.comments.nodes.filter(comment => humanLogin(comment.author) !== undefined
      && atOrBeforeCutoff(comment.createdAt) && atOrBeforeCutoff(comment.updatedAt)
      && sourceTimestampValid(comment.lastEditedAt))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    const latest = comments.at(-1)
    if (!latest || !associations.has(latest.authorAssociation) || !unresolvedQuestion(latest.body, candidate.language)) {
      return reject('construction-gate')
    }
    const rendered = cleanText(`Original request:\n${text}\n\nUnresolved maintainer question at the cutoff:\n${latest.body}`)
    row = frameRow(candidate, node, identity, {
      stableSourceId: `github:${latest.id}`,
      family: 'decision',
      construction: 'unanswered-maintainer-question',
      objectType: 'issue-comment-request',
      text: rendered,
      authorId: humanLogin(latest.author),
      url: latest.url,
      nodeId: latest.id,
      createdAt: node.createdAt,
      contentUpdatedAt: latest.updatedAt,
      evidence: { searchId: candidate.search.id, issue: node, latestComment: latest },
    })
  } else if (candidate.search.family === 'repository-contingent') {
    if (!repositoryContingent(text, candidate.language) || !actionRequest(text, candidate.language)) return reject('construction-gate')
    const base = repositoryBaseAtCutoff(node.repository)
    if (base.rejection) return base
    row = frameRow(candidate, node, identity, {
      stableSourceId: `github:${node.id}`,
      family: 'repository-contingent',
      construction: 'conditional-repository-state',
      objectType: 'issue',
      text,
      authorId: humanLogin(node.author),
      url: node.url,
      nodeId: node.id,
      createdAt: node.createdAt,
      contentUpdatedAt: node.updatedAt,
      repositoryBaseCommit: base.oid,
      relatedCommits: [base.oid],
      evidence: { searchId: candidate.search.id, issue: node, repositoryBaseAtCutoff: base },
    })
  } else {
    for (const [connection, limit, label] of [
      [node.reviews, spec.limits.maximumPullReviews, 'pull-reviews'],
      [node.reviewThreads, spec.limits.maximumPullReviewThreads, 'pull-review-threads'],
      [node.commits, spec.limits.maximumPullCommits, 'pull-commits'],
    ]) {
      const incomplete = connectionRejection(connection, limit, label)
      if (incomplete) return { rejection: incomplete }
    }
    for (const [index, thread] of node.reviewThreads.nodes.entries()) {
      const incomplete = connectionRejection(
        thread.comments,
        spec.limits.maximumPullReviewCommentsPerThread,
        `pull-review-thread-${index + 1}-comments`,
      )
      if (incomplete) return { rejection: incomplete }
    }
    const feedback = feedbackItems(node, associations, candidate.language)
    if (candidate.search.family === 'bounded') {
      const first = feedback[0]
      if (!first) return reject('construction-gate')
      const rendered = cleanText(`Pull request task:\n${node.title}\n\n${node.body ?? ''}\n\nFocused maintainer request:\n${feedbackText(first)}`)
      if (rendered.length > spec.limits.maximumBoundedPromptCharacters) return reject('bounded-prompt-too-long')
      row = frameRow(candidate, node, identity, {
        stableSourceId: `github:bounded:${node.id}:${first.id}`,
        family: 'bounded',
        construction: first.kind === 'inline-review' ? 'bounded-inline-review' : 'bounded-review',
        objectType: 'pull-review',
        text: rendered,
        authorId: humanLogin(first.author),
        url: first.url ?? node.url,
        nodeId: first.id,
        createdAt: node.createdAt,
        contentUpdatedAt: first.updatedAt,
        relatedPullRequests: [node.url],
        relatedCommits: [first.commitId].filter(Boolean),
        evidence: { searchId: candidate.search.id, pull: node, feedback: first.raw },
      })
    } else if (candidate.search.family === 'continuity') {
      let chain
      for (const item of feedback) {
        const laterCommit = node.commits.nodes.map(entry => entry.commit).find(commit => (
          atOrBeforeCutoff(commit.committedDate)
          && Date.parse(commit.committedDate) > Date.parse(item.createdAt)
          && commit.oid !== item.commitId
        ))
        if (laterCommit) {
          chain = { item, laterCommit }
          break
        }
      }
      if (!chain) return reject('construction-gate')
      const rendered = cleanText([
        'Initial pull request task:',
        `${node.title}\n\n${node.body ?? ''}`,
        'Maintainer change request:',
        feedbackText(chain.item),
        `Later mutation (${chain.laterCommit.committedDate}):`,
        chain.laterCommit.message,
      ].join('\n\n'))
      row = frameRow(candidate, node, identity, {
        stableSourceId: `github:continuity:${node.id}:${chain.item.id}:${chain.laterCommit.oid}`,
        family: 'continuity',
        construction: chain.item.kind === 'inline-review' ? 'inline-review-commit-chain' : 'review-commit-chain',
        objectType: 'pull-review',
        text: rendered,
        authorId: humanLogin(chain.item.author),
        url: node.url,
        nodeId: node.id,
        createdAt: node.createdAt,
        contentUpdatedAt: chain.laterCommit.committedDate,
        relatedPullRequests: [node.url],
        relatedCommits: [chain.item.commitId, chain.laterCommit.oid].filter(Boolean),
        evidence: { searchId: candidate.search.id, pull: node, feedback: chain.item.raw, laterCommit: chain.laterCommit },
      })
    } else {
      throw new Error(`unknown V11 construction family ${candidate.search.family}`)
    }
  }
  if (row.text.length < spec.limits.minimumPromptCharacters
    || row.text.length > spec.limits.maximumPromptCharacters
    || !languageMatches(row.text, candidate.language, spec)) return reject('text-or-language-gate')
  return { row }
}
