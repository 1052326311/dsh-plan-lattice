import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'

export const name = 'plan-lattice-eval-user-questions'
export const inject = ['userQuestions']

const clarification = `Binding product clarification:
- The user is an internal release operator preparing one stable or canary release after CI has produced artifact digests.
- The interface is node src/cli.mjs plan --input <path> --channel <stable|canary> --format json.
- The UTF-8 JSON input has exactly version, artifacts, and optional rollbackToken. Each artifact has name and a lowercase 64-character SHA-256 digest.
- A stable release requires a non-empty rollback token. A canary release may omit it.
- Success prints one JSON object with exactly schemaVersion, channel, version, artifactNames, and rollbackReady; artifact names are sorted lexicographically.
- User/input validation failures exit 2. A valid manifest rejected by release policy exits 3. Diagnostics go to stderr and name the failed boundary.
- The command must not mutate its input, access the network, or add runtime dependencies. Node 22 is the runtime boundary.`

export function apply(ctx: Context): void {
  ctx.userQuestions.registerProvider({
    async ask(request) {
      return {
        answers: request.questions.map(question => {
          if (question.id === 'intake-mode') {
            return { id: question.id, selected: ['Guided clarification'] }
          }
          if (question.id === 'intake-confirm') {
            return { id: question.id, selected: ['Approve contract'] }
          }
          return { id: question.id, selected: [], custom: clarification }
        }),
      }
    },
  })
}
