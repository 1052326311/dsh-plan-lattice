import { describe, expect, it } from 'vitest'
import { routeRequest, type RouteConfig, type RoutePhase } from '../src/router.js'
import { assessTaskInvariants } from '../src/task-invariants.js'

const config: RouteConfig = {
  activationMode: 'auto',
  clarificationPolicy: 'critical',
  controlCeiling: 'lattice',
  longTaskThreshold: 8,
}

function expectRoute(text: string, expected: RoutePhase): void {
  expect(routeRequest(text, config).phase, text).toBe(expected)
}

describe('authoritative mutation basis routing', () => {
  it.each([
    {
      stable: 'Bug: parser `parseId` returns empty for input `a:b`; expected `a`. Add a regression test.',
      unstable: 'The parser fails. Fix it.',
      stableRoute: 'bypass',
      unstableRoute: 'probe',
    },
    {
      stable: 'Fix the typo in README line 14.',
      unstable: 'Unify terminology across all documentation, the generator, and the public website.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Bug: clicking the button twice emits two events; expected one event. Repro steps are attached.',
      unstable: 'Define whether the event fires on click, value change, or submit; this is undecided.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix one local sorting function; preserve the existing fixture output.',
      unstable: 'Change the sorting strategy to prevent concurrent transaction deadlocks across supported databases.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Bug: the login time label renders UTC; expected the configured local timezone. Database data is correct.',
      unstable: 'Add login history with retention, permissions, storage, and an administration UI.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Bug: implement the missing `seek()` method; the API contract defines its command mapping and expected result.',
      unstable: 'Add seek support, but the device command mapping and supported device range are unknown.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Change one config default; the existing schema defines the valid range.',
      unstable: 'Add a configuration layer; environment override precedence is undecided.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix the migration test error message.',
      unstable: 'Migrate all tenant databases in batches and preserve rollback compatibility.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'The accepted design is frozen. One agent will make two local changes on one branch.',
      unstable: 'Use three parallel agents to change the client, server, and migration tool under the same accepted design.',
      stableRoute: 'contract',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix this method; its focused local test immediately proves the result.',
      unstable: 'Implement this change; correctness can only be verified after deployment and customer traffic.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Build the bounded workflow from this frozen contract.',
      unstable: 'Build the workflow; after each demo the user will revise the next phase.',
      stableRoute: 'contract',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix this local parser in one revertible commit.',
      unstable: 'Publish a migration that writes irreversible production data with no rollback path.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix `src/parser.ts`; its caller and expected output are given.',
      unstable: 'Find the real behavior owner; it may live in the plugin, core, or UI.',
      stableRoute: 'bypass',
      unstableRoute: 'probe',
    },
    {
      stable: 'Does the current adapter support Kingbase?',
      unstable: 'Implement Kingbase support; compatible versions and required behavior are unspecified.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
    {
      stable: 'Fix four independent typos and verify the rendered pages once.',
      unstable: 'Complete four dependent stages; each stage output becomes the next stage input.',
      stableRoute: 'bypass',
      unstableRoute: 'contract',
    },
  ] satisfies Array<{
    stable: string
    unstable: string
    stableRoute: RoutePhase
    unstableRoute: RoutePhase
  }>)('changes control only when the authority-basis risk changes: $stable', ({
    stable, unstable, stableRoute, unstableRoute,
  }) => {
    expectRoute(stable, stableRoute)
    expectRoute(unstable, unstableRoute)
  })

  it('keeps the three causal axes independent', () => {
    const incomplete = assessTaskInvariants('Build a customer approval application.')
    const expiring = assessTaskInvariants('Execute four dependent stages; each stage output becomes the next stage input.')
    const consequential = assessTaskInvariants('Delete production tenant records now.')

    expect(incomplete.definitionGap).toBeGreaterThanOrEqual(4)
    expect(incomplete.basisExpiryExposure).toBeLessThan(7)
    expect(expiring.basisExpiryExposure).toBeGreaterThanOrEqual(7)
    expect(consequential.staleMutationImpact).toBeGreaterThanOrEqual(4)
  })

  it('requires an explicit basis invalidation chain before using continuity control', () => {
    expectRoute(
      'Security bug: one local token parser returns the wrong user for a fixed fixture; expected the fixture user. Add one regression test.',
      'bypass',
    )
    expectRoute(
      'Add token routing whose permissions are synchronized from a changing configuration service while parallel agents update the gateway and storage adapters.',
      'contract',
    )
    expectRoute(
      'Publish one irreversible production migration with no rollback path.',
      'contract',
    )
  })

  it('does not parse a product version before reproduction steps as execution length', () => {
    const text = 'Bug: build args fail on PowerShell. React version: 18 Steps To Reproduce: run one build command. Expected: two packages build; actual: nothing builds.'
    const assessment = assessTaskInvariants(text)
    expect(assessment.mutationEpochs).toBe(1)
    expect(assessment.declaredLongHorizon).toBe(false)
    expectRoute(text, 'bypass')
  })

  it.each([
    {
      text: 'Bug: `saveBatch` replaces generated IDs with duplicate values; the supplied fixture shows the expected IDs.',
      expected: 'contract',
    },
    {
      text: 'Bug: a custom SQL page order removes the equals expression. The query and expected order are attached.',
      expected: 'contract',
    },
    {
      text: 'Bug: launching the local integration breaks another application until its external environment is reset. Reproduction and expected behavior are attached.',
      expected: 'contract',
    },
    {
      text: 'Add user login history as four work items: timeline, authentication method, storage/API records, and an administration UI.',
      expected: 'contract',
    },
    {
      text: 'A key-storage migration completes, then old encrypted files can no longer be accessed or decrypted.',
      expected: 'contract',
    },
    {
      text: 'Bug: the `migrations` command is missing; expected the command to be listed. Server configuration: database SQLite, external storage enabled.',
      expected: 'bypass',
    },
    {
      text: 'Bug: the dependency scanner prints a vulnerability warning. Update `@scope/server` to exactly 2.0.5.\n\n### Severity\nCritical: Data loss, app crash, security issue\n\nExpected behavior: no warning. This occurs only in development CLI tools and migrations.',
      expected: 'bypass',
    },
  ] satisfies Array<{ text: string; expected: RoutePhase }>)('routes structural authority-basis risk: $text', ({ text, expected }) => {
    expectRoute(text, expected)
  })
})
