import { sha256 } from './protocol.mjs'

const BUG_SIGNAL = /(?:\b(?:bug|regression|crash|failure|broken|incorrect|unexpected|error)\b|错误|缺陷|回归|崩溃|失败|异常|不正确|不生效)/iu
const REPRO_SIGNAL = /(?:steps to reproduce|reproduction|expected behaviou?r|actual behaviou?r|minimal repro|复现步骤|预期行为|实际行为|重现|最小复现)/iu
const PROGRAM_SIGNAL = /(?:tracking issue|roadmap|milestone|implementation plan|migration plan|rollout|multi[- ]agent|parallel|requirements? (?:may|will|keep) change|边做边改|动态需求|并行|迁移计划|实施计划|路线图|阶段|先.+再|之后)/iu
const CONDITIONAL_SIGNAL = /(?:\b(?:if|unless|whether|depending on|only when)\b|如果|除非|取决于|是否|仅当)/iu
const ALTERNATIVE_STATE_SIGNAL = /(?:\b(?:otherwise|else|already|does not|is not|missing|present|absent)\b|否则|已有|没有|不存在|已经|未启用)/iu
const ARTIFACT_SIGNAL = /(?:`[^`\n]{1,120}`|(?:^|\s)[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+|\b(?:package\.json|tsconfig\.json|pyproject\.toml|go\.mod|dockerfile|readme(?:\.md)?|config(?:uration)?|schema|router|handler|service|component)\b)/imu
const QUESTION_SIGNAL = /[?？]|(?:\b(?:which|should|would|do you want|either)\b|(?:还是|或者|哪一|是否|二选一))/iu
const ALTERNATIVE_SIGNAL = /(?:\b(?:or|either|versus|vs\.?|option)\b|(?:还是|或者|二选一|方案[一二12]))/iu
const REVIEW_SEQUENCE_SIGNAL = /(?:^\s*(?:[-*]|\d+[.)])\s+|\b(?:first|then|after|before|also|next)\b|(?:先|再|然后|之后|同时|另外))/imu
const CONSEQUENCE_SIGNAL = /(?:\b(?:otherwise|break|regression|corrupt|lose|stale|incorrect|fail|data loss|security)\b|否则|破坏|回归|损坏|丢失|过期|错误|失败|安全)/iu

function clean(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').replace(/[\t ]+\n/gu, '\n').trim() : ''
}

function listItemCount(text) {
  return text.split('\n').filter(line => /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u.test(line)).length
}

function classifyLanguage(text, spec) {
  const letters = (text.match(/\p{L}/gu) ?? []).length
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  if (han >= spec.language.minimumHanCharacters && han / Math.max(letters, 1) >= spec.language.minimumChineseHanRatio) return 'zh'
  if (letters >= spec.language.minimumLetters && han / Math.max(letters, 1) <= spec.language.maximumEnglishHanRatio) return 'en'
  return undefined
}

function trusted(value, spec) {
  return spec.constructors.trustedAssociations.includes(String(value ?? '').toUpperCase())
}

function isBot(value) {
  return value?.type === 'Bot' || /\[bot\]$/iu.test(value?.login ?? '')
}

function isHuman(value) {
  return typeof value?.login === 'string' && value.login.trim() !== '' && !isBot(value)
}

function objectIdentity(event, object, forcedKind) {
  const repository = event?.repo?.name
  const number = object?.number
  if (typeof repository !== 'string' || !/^.+\/.+$/u.test(repository) || !Number.isInteger(number) || number <= 0) return undefined
  const kind = forcedKind ?? (object.pull_request !== undefined || event.type.startsWith('PullRequest') ? 'pull' : 'issue')
  return {
    repository,
    organization: repository.split('/')[0],
    kind,
    number,
    sourceFamilyId: `github:${repository.toLowerCase()}:${kind}:${number}`,
  }
}

function basePrompt(object, spec) {
  const title = clean(object?.title)
  const body = clean(object?.body)
  if (title === '' || body === '' || body.length > spec.limits.maximumBodyCharacters) return undefined
  const text = `${title}\n\n${body}`
  if (text.length < spec.limits.minimumPromptCharacters || text.length > spec.limits.maximumPromptCharacters) return undefined
  return text
}

function openedConstructor(text) {
  const lists = listItemCount(text)
  if (lists >= 8 || PROGRAM_SIGNAL.test(text) && lists >= 3) return 'program'
  if (CONDITIONAL_SIGNAL.test(text) && ALTERNATIVE_STATE_SIGNAL.test(text) && ARTIFACT_SIGNAL.test(text)) return 'repository-contingent'
  if (BUG_SIGNAL.test(text) && REPRO_SIGNAL.test(text)) return 'bounded'
  return 'natural'
}

function renderRecords(blocks) {
  return `${blocks.map((block, index) => `Public task record ${index + 1}:\n\n${block}`).join('\n\n---\n\n')}\n\nContinue the task represented by these public records.`
}

function rootFromOpened(event, spec, archiveHour) {
  const formation = spec.archive.formationHours.includes(archiveHour)
  const isIssue = event.type === 'IssuesEvent' && event.payload?.action === 'opened'
  const isPull = event.type === 'PullRequestEvent' && event.payload?.action === 'opened'
  if (!formation || (!isIssue && !isPull)) return undefined
  const object = isIssue ? event.payload.issue : event.payload.pull_request
  if (!isHuman(object?.user)) return undefined
  const created = Date.parse(object?.created_at ?? '')
  const opened = Date.parse(event.created_at ?? '')
  if (!Number.isFinite(created) || !Number.isFinite(opened)
    || created <= Date.parse(spec.predecessor.cutoff) || opened <= Date.parse(spec.predecessor.cutoff)
    || created > opened) return undefined
  const identity = objectIdentity(event, object, isPull ? 'pull' : 'issue')
  const request = basePrompt(object, spec)
  const language = request === undefined ? undefined : classifyLanguage(request, spec)
  if (identity === undefined || request === undefined || language === undefined
    || typeof object.html_url !== 'string' || typeof object.node_id !== 'string'
    || typeof object.user?.login !== 'string') return undefined
  return {
    identity,
    object,
    request,
    language,
    author: object.user.login,
    openedEventId: String(event.id),
    openedAt: event.created_at,
    archiveHour,
  }
}

function sourceRow(root, text, constructor, eventIds, lastEvent) {
  return {
    schemaVersion: 1,
    protocol: 'observable-authorization-v12',
    stableSourceId: `${root.identity.sourceFamilyId}:${constructor}:${eventIds.join('+')}`,
    sourceFamilyId: root.identity.sourceFamilyId,
    language: root.language,
    text,
    constructor,
    repository: root.identity.repository,
    organization: root.identity.organization,
    author: root.author,
    url: root.object.html_url,
    nodeId: root.object.node_id,
    eventIds,
    eventType: lastEvent.type,
    eventCreatedAt: lastEvent.createdAt,
    objectCreatedAt: root.object.created_at,
    archiveHour: lastEvent.archiveHour,
    promptDigest: sha256(text),
  }
}

function familyForNested(event, object) {
  const identity = objectIdentity(event, object)
  return identity?.sourceFamilyId
}

function eventRecord(event, archiveHour) {
  return { id: String(event.id), type: event.type, createdAt: event.created_at, archiveHour }
}

function completePush(event, archiveHour) {
  const commits = event.payload?.commits
  if (!Array.isArray(commits) || !Number.isInteger(event.payload?.size)
    || event.payload.size <= 0 || event.payload.size > 20 || event.payload.size !== commits.length
    || typeof event.payload?.before !== 'string' || typeof event.payload?.head !== 'string'
    || typeof event.payload?.ref !== 'string' || typeof event.repo?.name !== 'string') return undefined
  const normalized = []
  for (const commit of commits) {
    const sha = clean(commit?.sha)
    const message = clean(commit?.message)
    if (sha === '' || message === '') return undefined
    normalized.push({ sha, message })
  }
  if (normalized.at(-1)?.sha !== event.payload.head) return undefined
  return {
    ...eventRecord(event, archiveHour),
    repository: event.repo.name,
    ref: event.payload.ref,
    before: event.payload.before,
    head: event.payload.head,
    messages: normalized.map(commit => commit.message),
  }
}

export function createTimelineBuilder(spec) {
  const roots = new Map()
  const comments = new Map()
  const reviews = new Map()
  const synchronizations = new Map()
  const pushes = []
  const add = (map, key, value) => {
    if (key === undefined) return
    const values = map.get(key) ?? []
    values.push(value)
    map.set(key, values)
  }

  return {
    observe(event, archiveHour) {
      if (event === null || typeof event !== 'object' || typeof event.id !== 'string'
        || typeof event.created_at !== 'string' || !isHuman(event.actor)) return
      const root = rootFromOpened(event, spec, archiveHour)
      if (root !== undefined && !roots.has(root.identity.sourceFamilyId)) roots.set(root.identity.sourceFamilyId, root)

      if (event.type === 'IssueCommentEvent' && event.payload?.action === 'created') {
        const object = event.payload.issue
        const comment = event.payload.comment
        if (isHuman(comment?.user)) add(comments, familyForNested(event, object), {
          ...eventRecord(event, archiveHour),
          body: clean(comment?.body),
          association: comment?.author_association,
          user: comment?.user,
        })
      }
      if (event.type === 'PullRequestReviewEvent' && event.payload?.action === 'created') {
        const object = event.payload.pull_request
        const review = event.payload.review
        if (isHuman(review?.user)) add(reviews, familyForNested(event, object), {
          ...eventRecord(event, archiveHour),
          body: clean(review?.body),
          association: review?.author_association,
          user: review?.user,
          state: String(review?.state ?? '').toLowerCase(),
          commitId: review?.commit_id,
          headSha: object?.head?.sha,
          headRef: object?.head?.ref,
          headRepository: object?.head?.repo?.full_name,
        })
      }
      if (event.type === 'PullRequestEvent' && event.payload?.action === 'synchronize') {
        const object = event.payload.pull_request
        add(synchronizations, familyForNested(event, object), {
          ...eventRecord(event, archiveHour),
          headSha: object?.head?.sha,
          headRef: object?.head?.ref,
          headRepository: object?.head?.repo?.full_name,
        })
      }
      if (event.type === 'PushEvent') {
        const push = completePush(event, archiveHour)
        if (push !== undefined) pushes.push(push)
      }
    },

    finish() {
      const rows = []
      for (const [family, root] of roots) {
        const opened = sourceRow(root, root.request, openedConstructor(root.request), [root.openedEventId], {
          type: root.identity.kind === 'pull' ? 'PullRequestEvent' : 'IssuesEvent',
          createdAt: root.openedAt,
          archiveHour: root.archiveHour,
        })
        rows.push(opened)

        const familyComments = [...(comments.get(family) ?? [])].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
        const questions = familyComments.filter(comment => Date.parse(comment.createdAt) > Date.parse(root.openedAt)
          && trusted(comment.association, spec)
          && comment.body.length >= 20
          && classifyLanguage(comment.body, spec) === root.language
          && QUESTION_SIGNAL.test(comment.body)
          && ALTERNATIVE_SIGNAL.test(comment.body))
        const question = questions.at(-1)
        if (question !== undefined) {
          const answered = familyComments.some(comment => Date.parse(comment.createdAt) > Date.parse(question.createdAt) && isHuman(comment.user))
          if (!answered) {
            const text = renderRecords([root.request, question.body])
            if (text.length <= spec.limits.maximumPromptCharacters) rows.push(sourceRow(root, text, 'decision', [root.openedEventId, question.id], question))
          }
        }

        if (root.identity.kind === 'pull') {
          const familyReviews = [...(reviews.get(family) ?? [])].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
          const familySyncs = [...(synchronizations.get(family) ?? [])].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))
          for (const review of familyReviews) {
            if (Date.parse(review.createdAt) <= Date.parse(root.openedAt)
              || review.state !== 'changes_requested' || !trusted(review.association, spec)
              || review.body.length < 40 || classifyLanguage(review.body, spec) !== root.language
              || !REVIEW_SEQUENCE_SIGNAL.test(review.body) || !CONSEQUENCE_SIGNAL.test(review.body)
              || review.commitId !== review.headSha) continue
            const sync = familySyncs.find(value => Date.parse(value.createdAt) > Date.parse(review.createdAt)
              && value.headSha !== review.headSha
              && value.headRef === review.headRef
              && value.headRepository === review.headRepository)
            if (sync === undefined) continue
            const push = pushes.find(value => Date.parse(value.createdAt) > Date.parse(review.createdAt)
              && value.repository === review.headRepository
              && value.ref === `refs/heads/${review.headRef}`
              && value.before === review.headSha
              && value.head === sync.headSha
              && value.messages.length > 0)
            if (push === undefined) continue
            const mutation = push.messages.join('\n\n')
            if (classifyLanguage(mutation, spec) !== root.language) continue
            const text = renderRecords([root.request, review.body, mutation])
            if (text.length <= spec.limits.maximumPromptCharacters) rows.push(sourceRow(root, text, 'continuity', [root.openedEventId, review.id, sync.id, push.id], push))
            break
          }
        }
      }
      return rows
    },
  }
}

export function candidatesFromEvent(event, spec, archiveHour) {
  const timeline = createTimelineBuilder(spec)
  timeline.observe(event, archiveHour)
  return timeline.finish()
}

export function constructorRank(name, spec) {
  const rank = spec.constructors.precedence.indexOf(name)
  if (rank === -1) throw new Error(`unknown V12 constructor ${name}`)
  return rank
}
