import { describe, expect, it } from 'vitest'
import { buildReportText, summarizeTask, verdictParagraph } from './reportText'
import type { ReportData } from './reportText'
import { makeDrive, makeJob } from './test/fixtures'
import type { SmartDetailResponse } from './types'

const smart = (over: Partial<SmartDetailResponse> = {}): SmartDetailResponse => ({
  captured_at: '2026-11-25T10:00:00+00:00', probe: 'smartctl_telemetry', detail: null, self_test_log: [],
  signals: { reallocated: 1051, smart_passed: false }, signal_flags: { reallocated: 'crit' },
  health: {
    health_pct: 8, health_status: 'Critical', floor: null,
    factors: [
      { key: 'drive', kind: 'drive', label: 'Drive reports failure', signal: null, value: 'impending failure',
        standalone: 10, weight: 0.35, role: 'start', points: 10 },
      { key: 'reallocated', kind: 'media', label: 'Reallocated sectors', signal: 'reallocated', value: '1,051',
        standalone: 40, weight: 0.3, role: 'adds', points: -1.8 },
    ],
  },
  ...over,
})

const job = makeJob({
  drive_guid: 'd1', operation_name: 'Bad Block Scan (badblocks)', status: 'completed', summary: 'No bad blocks found in 1 pass',
  started_at: '2026-11-20T00:00:00+00:00', finished_at: '2026-11-20T02:00:00+00:00',
  smart: { before: null, after: null, comparison: { changes: { reallocated: { before: 1028, after: 1051, change: 23 } }, worsened: ['reallocated'], uncompared: [] } },
})

const data = (over: Partial<ReportData> = {}): ReportData => ({
  drive: makeDrive({ guid: 'd1', serial: 'ZAD1V2H0', model: 'X316_SMBPE06TA07' }),
  smart: smart(), info: null, tests: [{ kind: 'job', key: job.id, job }], ...over,
})

describe('verdictParagraph', () => {
  it('states the status and its meaning, what it rests on, the self-tests and the latest task', () => {
    const p = verdictParagraph(data())
    expect(p).toMatch(/^Critical \(8\/100\)\. The drive says it's failing/)
    expect(p).toContain('The score rests on drive reports failure: impending failure.')
    expect(p).toContain('Also lowering it: reallocated sectors (1,051).')
    expect(p).toContain('It has no long self-test in its log.')
    expect(p).toContain('DriveCheck has run 1 test or scan on it; the latest, Bad Block Scan (badblocks)')
    expect(p).toContain('(SMART got worse: +23 Realloc).')
  })

  it('says when there is no full read', () => {
    expect(verdictParagraph(data({ smart: null, tests: [] })))
      .toMatch(/^There is no full SMART read of this drive yet, so it isn't rated\..*DriveCheck hasn't run any tests or scans on it\.$/)
  })
})

describe('summarizeTask', () => {
  it('gives name, outcome, duration and what got worse', () => {
    expect(summarizeTask({ kind: 'job', key: job.id, job })).toMatchObject({
      name: 'Bad Block Scan (badblocks)', outcome: 'No bad blocks found in 1 pass',
      duration: 2 * 3600_000, smartNote: '+23 Realloc', failed: false,
    })
  })
})

describe('buildReportText', () => {
  it('includes the verdict, health, self-tests and the task list', () => {
    const text = buildReportText(data())
    expect(text).toContain('Verdict:\n  Critical (8/100).')
    expect(text).toContain('Health: 8/100 (Critical)')
    expect(text).toContain("Self-tests (the drive's log):\n  Short:")
    expect(text).toMatch(/DriveCheck tests and scans:\n {2}.+Bad Block Scan \(badblocks\): No bad blocks found in 1 pass, ran 2h 0m \[SMART: \+23 Realloc\]/)
  })
})
