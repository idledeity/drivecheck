import type { Drive, Job } from '../types'

// Minimal stand-in for the Response shape the components actually call:
// r.status and r.json(). Not a full Response — just enough surface area.
export function fetchJsonResponse(data: unknown, status = 200) {
  return { status, json: () => Promise.resolve(data) } as Response
}

export function makeDrive(overrides: Partial<Drive> = {}): Drive {
  return {
    guid: 'guid-1',
    device: '/dev/sda',
    info_name: '/dev/sda',
    serial: 'SN123',
    manufacturer: 'Acme',
    model: 'ModelX',
    capacity_bytes: 1_000_000_000_000,
    drive_type: 'HDD',
    form_factor: '3.5 inches',
    rpm: 7200,
    bus: 'SATA III',
    power_on_hours: 1000,
    temp: 35,
    reallocated: 0,
    pending: 0,
    load_unload_cycles: null,
    uncorrected: 0,
    smart_passed: true,
    health_status: 'Healthy',
    signal_flags: {},
    last_polled_at: null,
    is_mounted: false,
    vitals: {
      temp: null,
      temp_source: null,
      captured_at: null,
      io: { read_iops: null, write_iops: null, read_bytes_per_sec: null, write_bytes_per_sec: null, busy_pct: null },
    },
    label: null,
    ...overrides,
  }
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    drive_guid: 'guid-1',
    operation: 'dd_read_test',
    operation_name: 'Full Read Test',
    category: 'Test',
    params: {},
    status: 'queued',
    progress: { percent: null, message: null, eta_seconds: null },
    result: null,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    ...overrides,
  }
}
