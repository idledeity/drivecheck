import { describe, expect, it } from 'vitest'
import { summarizeDrive, summaryMarkdown, summaryText } from './driveSummary'
import { makeDrive, makeJob } from './test/fixtures'

const failing = makeDrive({
  guid: 'd1', manufacturer_short: 'NETAPP', model: 'X316_SMBPE06TA07', capacity_bytes: 6001175126016,
  serial: 'ZAD1V2H0', block_device: '/dev/sdb', health_status: 'Critical', health_pct: 8,
  health_factors: [{ key: 'drive', kind: 'drive', label: 'Drive reports failure', signal: null, value: 'impending failure',
                     standalone: 10, weight: 0.35, role: 'start', points: 10 }],
  power_on_hours: 51680, reallocated: 1051, pending: 0, uncorrected: 0,
  self_test_coverage: {
    latest: {
      short: { protocol: 'scsi', type_code: 1, type: 'Background short', kind: 'short', result: 'Completed', drive_report: 'ok',
               hours: 51600, age_hours: 80, in_drive_log: true, recent: true },
      conveyance: null,
      long: { protocol: 'scsi', type_code: 2, type: 'Background long', kind: 'long', result: 'Failed in segment', drive_report: 'failed',
              hours: 50000, age_hours: 1680, in_drive_log: true, recent: false },
    },
    hours_reset: false, log_seen_at: null, log_missing: false,
  },
})

describe('summarizeDrive', () => {
  it('takes the worst factor, self-tests and the last task', () => {
    const job = makeJob({ drive_guid: 'd1', operation_name: 'badblocks', status: 'failed', error: '12 bad blocks',
                          finished_at: new Date().toISOString() })
    const s = summarizeDrive(failing, [job])
    expect(s.name).toBe('NETAPP X316_SMBPE06TA07')
    expect(s.worst).toEqual({ label: 'Drive reports failure', value: 'impending failure' })
    expect(s.short).toEqual({ text: 'Passed 80 h ago', tone: 'ok' })
    expect(s.long).toEqual({ text: 'Failed 1,680 h ago', tone: 'crit' })
    expect(s.lastTask).toMatchObject({ name: 'badblocks', outcome: '12 bad blocks', failed: true })
  })

  it('says never run and none when there is nothing', () => {
    const s = summarizeDrive(makeDrive({ guid: 'd2' }))
    expect(s.short.text).toBe('Never run')
    expect(s.lastTask).toBeNull()
  })
})

describe('copy formats', () => {
  it('text: a block per drive', () => {
    const text = summaryText([summarizeDrive(failing)])
    expect(text.split('\n').slice(0, 5)).toEqual([
      'NETAPP X316_SMBPE06TA07 · 6 TB · S/N ZAD1V2H0 · /dev/sdb',
      '  Health:     Critical 8/100 (worst: Drive reports failure, impending failure)',
      expect.stringContaining('  Signals:    Power-on hours 51,680h · Reallocated sectors 1,051'),
      '  Self-tests: Short passed 80 h ago · Long failed 1,680 h ago',
      '  Last task:  None',
    ])
  })

  it('markdown: a header, a divider and a row per drive', () => {
    const md = summaryMarkdown([summarizeDrive(failing), summarizeDrive(makeDrive({ guid: 'd2' }))]).split('\n')
    expect(md).toHaveLength(4)
    expect(md[0]).toMatch(/^\| Drive \| Capacity \| Serial \| Health \| Worst factor \|/)
    expect(md[2]).toContain('| Critical 8/100 | Drive reports failure (impending failure) |')
  })
})
