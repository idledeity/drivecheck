import { describe, expect, it } from 'vitest'
import type { Job } from './types'
import { jobCancelConfirmation } from './jobCancelConfirmation'

const job = (over: Partial<Job>): Job => ({
  id: 'j', drive_guid: 'd', operation: 'op', operation_name: 'Bad Block Scan', status: 'queued',
  created_at: '2026-11-19T10:00:00', started_at: null, finished_at: null, batch: null,
  ...over,
} as Job)
const batch = (stop_on_failure: boolean) => ({ id: 'b', step: 1, recipe: 'r', recipe_name: 'Initial Scan', params: {}, stop_on_failure, smart: null })

describe('jobCancelConfirmation', () => {
  it('lets a plain job that has not started go without asking', () => {
    expect(jobCancelConfirmation([job({})], [])).toBeNull()
  })

  it('asks before cancelling a batch step, even unstarted, saying later steps are skipped', () => {
    const req = jobCancelConfirmation([job({ batch: batch(true) })], [])!
    expect(req.title).toBe('Cancel Bad Block Scan?')
    expect(req.detail).toBe("Bad Block Scan hasn't started yet. It's step 2 of Initial Scan, which stops on failure: its later steps won't run.")
    expect(req.confirmLabel).toBe('Cancel step')
    expect(req.cancelLabel).toBe('Keep it')
  })

  it('says later steps still run when the batch carries on after a failure', () => {
    const req = jobCancelConfirmation([job({ status: 'running', started_at: new Date().toISOString(), batch: batch(false) })], [])!
    expect(req.detail).toMatch(/That progress is lost\. It's step 2 of Initial Scan\. Its later steps still run, without this one's result\.$/)
    expect(req.cancelLabel).toBe('Keep running')
  })
})
