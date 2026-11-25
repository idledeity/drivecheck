import { describe, expect, it } from 'vitest'
import { batchOutcome, batchState, groupTasks, itemDuration } from './taskItems'
import { makeJob } from './test/fixtures'
import type { Job } from './types'

const batch = (id: string, step: number) => ({ id, step, recipe: 'r', recipe_name: 'Stress', params: {}, stop_on_failure: true, smart: null })
const step = (id: string, n: number, o: Partial<Job>): Job => makeJob({ id, batch: batch('b', n), operation_name: `Op ${n}`, ...o })

describe('groupTasks', () => {
  it('puts a batch where its first listed step is, with every step from the pool', () => {
    const solo = makeJob({ id: 'solo' })
    const s0 = step('s0', 0, { status: 'completed' }), s1 = step('s1', 1, { status: 'failed' })
    const items = groupTasks([s1, solo, s0], [s0, s1])
    expect(items.map(i => i.key)).toEqual(['batch-b', 'solo'])
    expect(items[0].kind === 'batch' && items[0].steps.map(j => j.id)).toEqual(['s0', 's1'])
  })
})

describe('batchState', () => {
  it('counts a batch between steps as running, on its next step', () => {
    const state = batchState([step('a', 0, { status: 'completed', started_at: '2026-11-11T09:00:00', finished_at: '2026-11-11T09:05:00' }), step('b', 1, { status: 'queued' })])
    expect(state.status).toBe('running')
    expect(state.current?.id).toBe('b')
    expect(state.finishedAt).toBeNull()
    expect(batchOutcome(state, true)).toBe('Op 1 next · stops on failure')
  })

  it('takes the step that ended it as its outcome', () => {
    const steps = [
      step('a', 0, { status: 'completed', started_at: '2026-11-11T09:00:00', finished_at: '2026-11-11T09:05:00' }),
      step('b', 1, { status: 'failed', started_at: '2026-11-11T09:05:00', finished_at: '2026-11-11T10:00:00' }),
      step('c', 2, { status: 'skipped', finished_at: '2026-11-11T10:00:00' }),
    ]
    const state = batchState(steps)
    expect(state.status).toBe('failed')
    expect(batchOutcome(state, true)).toBe('Failed at Op 1 · 1 skipped')
    expect(itemDuration({ kind: 'batch', key: 'k', batchId: 'b', steps })).toBe(60 * 60e3)
  })

  it("completes with skipped steps that its drive can't run", () => {
    const state = batchState([step('a', 0, { status: 'completed' }), step('b', 1, { status: 'skipped' })])
    expect(state.status).toBe('completed')
    expect(batchOutcome(state, false)).toBe('1 of 2 steps completed · 1 skipped')
  })

  it('knows its size from the last step even when earlier rows are missing', () => {
    expect(batchState([step('c', 2, { status: 'queued' })]).total).toBe(3)
  })
})
