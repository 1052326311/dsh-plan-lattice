import { describe, expect, it } from 'vitest'
import { verifyStudyChecksums } from '../prospective/model-rc4-study/study-checksums.mjs'

describe('RC.4 study checksum closure', () => {
  it('binds every study implementation and model-rc4 test file', async () => {
    const result = await verifyStudyChecksums()
    expect(result.files).toBeGreaterThanOrEqual(30)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })
})
