/**
 * Recognize a deliberately narrow subset of Bash that cannot mutate state.
 *
 * Plan Lattice treats unknown shell as a protected side effect. This positive
 * recognizer preserves native repository exploration without pretending that
 * arbitrary shell, interpolation, redirection, or a pipeline is safe.
 */

const READ_ONLY_PROGRAMS = new Set(['pwd', 'ls', 'cat', 'head', 'tail', 'rg', 'grep'])
const FORBIDDEN_SHELL_SYNTAX = /[\n\r;&|<>`$(){}\\'"]/u

function hasUnsafeReaderArgument(program: string, words: readonly string[]): boolean {
  // ripgrep's --pre option executes its value for every candidate file. Keep
  // the native fast path positive rather than attempting to model every shell
  // and tool-specific escape hatch here.
  return program === 'rg' && words.slice(1).some(word => word === '--pre' || word.startsWith('--pre='))
}

function commandText(arguments_: unknown): string | undefined {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return undefined
  const command = (arguments_ as Record<string, unknown>).command
  return typeof command === 'string' ? command.trim() : undefined
}

/**
 * Returns true only for one or more `&&`-joined, simple inspection commands.
 * Quoting is rejected intentionally: callers fall back to the protected path
 * when a command needs shell interpretation.
 */
export function isKnownReadOnlyBash(arguments_: unknown): boolean {
  const command = commandText(arguments_)
  if (command === undefined || command === '') return false
  if (FORBIDDEN_SHELL_SYNTAX.test(command.replaceAll('&&', ''))) return false

  return command.split('&&').every(segment => {
    const words = segment.trim().split(/\s+/u)
    if (words.length === 0 || !READ_ONLY_PROGRAMS.has(words[0] ?? '')) return false
    // GNU find and shell helpers can execute or mutate through arguments; it
    // is intentionally not in the allowlist. `rg --pre` is also executable.
    // All remaining listed programs are readers when interpolation,
    // redirection, pipes, and shell control syntax are off.
    return words.every(word => word !== '') && !hasUnsafeReaderArgument(words[0]!, words)
  })
}
