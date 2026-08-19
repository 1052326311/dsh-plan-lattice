import { describe, expect, it } from 'vitest'
import { isKnownReadOnlyBash } from '../src/shell-readonly.js'

describe('known read-only Bash', () => {
  it('allows simple native workspace inspection without activating the write firewall', () => {
    expect(isKnownReadOnlyBash({ command: 'pwd && ls -la' })).toBe(true)
    expect(isKnownReadOnlyBash({ command: 'rg -n TODO src' })).toBe(true)
    expect(isKnownReadOnlyBash({ command: 'head -40 package.json' })).toBe(true)
  })

  it('fails closed for shell interpretation and every unrecognized command', () => {
    expect(isKnownReadOnlyBash({ command: 'cat > src/app.ts' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: 'node test/smoke.mjs' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: 'cat package.json | tee copy.json' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: 'echo $(pwd)' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: 'ls; rm -rf .dsh' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: 'rg --pre=touch TODO src' })).toBe(false)
    expect(isKnownReadOnlyBash({ command: "rg --pre 'touch injected-file' TODO src" })).toBe(false)
    expect(isKnownReadOnlyBash({ command: "cat 'package.json'" })).toBe(false)
  })
})
