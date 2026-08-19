import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const SHELL_PROBE_TEST_FILE = '.v21-shell-probe.test.mjs'
export const SHELL_PROBE_PASS_FILE = '.v21-shell-probe.passed'
export const SHELL_PROBE_TEST_SOURCE = "import test from 'node:test'; import assert from 'node:assert/strict'; test('V21 real Bash execution', () => assert.equal(2 + 2, 4))\n"
export const SHELL_PROBE_PASS_CONTENT = 'V21_REAL_BASH_AND_OUTER_SANDBOX_OK\n'

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function buildShellProbeCommand(forbiddenReadablePath) {
  return [
    `printf '%s' ${shellQuote(SHELL_PROBE_TEST_SOURCE)} > ${shellQuote(SHELL_PROBE_TEST_FILE)}`,
    `node --test ${shellQuote(SHELL_PROBE_TEST_FILE)}`,
    `printf '%s\\n' 'V21_NODE_TEST_PASSED'`,
    `if [ -r ${shellQuote(forbiddenReadablePath)} ]; then printf '%s\\n' 'outer sandbox read boundary failed' >&2; exit 91; fi`,
    `printf '%s' ${shellQuote(SHELL_PROBE_PASS_CONTENT)} > ${shellQuote(SHELL_PROBE_PASS_FILE)}`,
  ].join(' && ')
}

export async function verifyShellProbe(workspace) {
  const [testSource, passContent] = await Promise.all([
    readFile(join(workspace, SHELL_PROBE_TEST_FILE), 'utf8'),
    readFile(join(workspace, SHELL_PROBE_PASS_FILE), 'utf8'),
  ])
  if (testSource !== SHELL_PROBE_TEST_SOURCE || passContent !== SHELL_PROBE_PASS_CONTENT) {
    throw new Error('V21 real Bash probe artifacts do not match the frozen command')
  }
  return {
    testFile: SHELL_PROBE_TEST_FILE,
    passFile: SHELL_PROBE_PASS_FILE,
    testSourceSha256Input: testSource,
  }
}
