# CLAUDE.md — drivecheck

Project context for AI-assisted development. Paste this at the start of each session.

---

## Project Summary

A browser-based drive health evaluation and monitoring tool for Linux. The core use
case is vetting used hard drives before trusting them with data — running SMART tests,
collecting SMART attributes, optionally running badblocks, and producing a report.
Distinct from passive monitoring tools like Scrutiny in emphasis: drivecheck is
task-first. History and monitoring are supported but not the lead.

The name works on both levels: "check a drive" for active evaluation, "check in on
drives" for ongoing monitoring.

---

## What This Is Not

- Not a replacement for Scrutiny (drivecheck is task-first; monitoring is secondary)
- Not a user-facing SaaS product
- Not a complex multi-user system
- A personal/homelab tool intended for eventual public release on GitHub

---

## Terminology

| Term | Definition |
|---|---|
| **DriveDescriptor** | Minimal scan output — device path, access type, info name. Produced by scan probes. No GUID, no traits. |
| **DriveContext** | Collector-assembled identity object — GUID + DriveDescriptor + DriveTraits. Passed to traits probes, telemetry probes, operations, and jobs. |
| **DriveSnapshot** | Point-in-time capture of a single collector poll — telemetry + health + extras + probe log. Persisted to SQLite. |
| **DriveState** | Live in-memory view of a drive — DriveContext + DriveTraits + DriveAttachment + current DriveSnapshot. Lives in the registry. |
| **DCSignals** | Drivecheck-normalized health signals mapped from raw protocol data. Protocol-agnostic. |
| **Scan probe** | A configurable script that discovers attached drives and returns DriveDescriptors. |
| **Traits probe** | A configurable script that receives a DriveContext and returns DriveTraits. Run on drive discovery and at a reduced interval. |
| **Telemetry probe** | A configurable script that receives a DriveContext + DriveSnapshot, enriches the snapshot, and returns it. Run every collector cycle. |
| **Probe chain** | Ordered list of telemetry probes run per drive per collector cycle. Last probe has final authority over any field. |
| **Operation** | A user-initiated task performed on a drive (SMART test, badblocks scan, etc.). Distinct from probes. |
| **Job** | A running or completed instance of an operation against a specific drive. |
| **Drive Record** | The persistent SQLite entry for a known drive, keyed by GUID. |
| **Registry** | Module-level dict in collector.py holding the current DriveState for every attached drive. Source of truth for all live API responses. |

---

## Stack

### Backend
- **Language:** Python 3.x
- **Framework:** Flask (minimal, no async, no ORM)
- **Concurrency:** Python `threading` module (standard library)
  - Collector runs as a daemon thread, currently polling all drives sequentially each cycle
  - Per-drive ThreadPoolExecutor polling and the Operations/Jobs threading model are
    target design, not yet implemented (see Project Status)
- **Subprocess:** Standard `subprocess` module wraps all CLI tools
- **No external job queue** (no Celery, no Redis) — threading is sufficient for
  a handful of concurrent drive tests
- **No ORM** — raw `sqlite3` from the standard library

### Frontend
- **Language:** TypeScript
- **Framework:** React + Vite
- **Styling:** Minimal — hand-rolled CSS or single-file classless library (e.g. Pico.css)
- **No component library** (no MUI, no Chakra, etc.)
- **No state management library** (React built-in useState/useContext only)
- **HTTP:** Native `fetch` API only (no Axios)
- **Live updates:** Polling only — no SSE, no WebSockets
  - Currently a flat 30s interval in `App.tsx`. Adaptive interval (2s active / 10s idle)
    is target design, depends on Jobs (see Project Status)
  - Multiple concurrent fetches fired in useEffect; page sections update independently as they resolve
  - A page refresh always produces correct state — no reconnect or session-tracking logic needed

### Communication
- **REST only:** Flask serves JSON API endpoints for drive listing, job control, reports, and collector state
- No push mechanism of any kind — polling is the single update model throughout the UI

### Auth
- Single username/password configured in a config file (YAML)
- Flask session cookie after successful login — no re-entry per page
- Protects all routes; no roles, no registration, no password reset
- Pattern consistent with Transmission, OctoPrint, Jellyfin

### Storage
- **SQLite** is the primary persistent store (`data/drivecheck.db`)
  - Drive records, jobs, operation results, and all time-series data persist across restarts
  - Raw `sqlite3` module only — no ORM
  - **WAL mode is required** (`PRAGMA journal_mode=WAL`) — enables concurrent readers alongside
    the collector writer; set once at DB initialization
- **JSON/HTML report files** written to `data/reports/` on job completion
  - Byproduct of completion, not the source of truth
  - Self-contained HTML report is available as a download link from the UI
  ```
  data/
    drivecheck.db
    reports/
      <drive-guid>/
        <timestamp>.json
        <timestamp>.html
  ```

### Collector
A background thread that runs continuously alongside Flask, independent of any user
activity or job execution.

**Responsibilities:**
- Run the scan probe to discover attached drives, on the `scan` timer
- Deduplicate discovered drives by serial number, scoring candidate descriptors to
  pick the best access path (see Deduplication)
- For each newly discovered drive, assign a GUID (uuid5 of serial or device name),
  build a DriveContext, and upsert the Drive Record in SQLite
- Run the traits probe for newly discovered drives only, to populate DriveTraits
- Run the telemetry probe chain for each drive on its `telemetry` channel; update the
  in-memory DriveState registry and write drive_signals + drive_heartbeats to SQLite
- Persist the most recent telemetry run's raw probe output (`snapshot.extras`) to
  drive_raw_snapshots for each drive on its `snapshot` channel

**Threading:**
- Collector loop runs as a daemon thread started at Flask startup, ticking every
  `_TICK_INTERVAL` (1s) to check which drives/channels are due
- WAL mode ensures collector writes don't block API request threads (implemented in `db.py`)
- Per-drive ThreadPoolExecutor polling, probe chaining, traits refresh interval, and
  graceful shutdown are target design, not yet implemented (see Project Status)

**Polling intervals (per-channel, phase-staggered):**
- Configurable in `config.yaml` under `collector.poll_intervals` — currently
  `telemetry` (default 300s: signals + heartbeat) and `snapshot` (default 14400s/4h:
  raw smartctl JSON persistence). Drive discovery runs on its own
  `collector.scan_interval` (default 300s), unstaggered.
- Each drive is assigned a phase fraction from its position in the sorted GUID list
  (`index / drive_count`), so drives are spread evenly across each channel's interval
  instead of bursting all at once. Phase fractions are recomputed whenever the drive
  set changes.
- `next_due` is computed directly from the phase grid (`_compute_next_due` in
  `collector.py`) — no separate cooldown or `last_run_at` tracking. If the natural
  next slot would land less than half an interval away (e.g. right after a forced
  refresh), it's pushed out by one more interval — this is the only debounce.
- `POST /api/drives/refresh` marks every drive's `telemetry` channel as due now and
  ticks immediately; the normal due-check + debounce handles the rest, so a manual
  refresh can't destroy staggering or double-fire.
- New drives have both channels due immediately on registration, so they get
  telemetry and a baseline raw snapshot in the same tick they're discovered.

**Cold start (target, not yet enforced):** On Flask startup, the collector should run
one immediate poll before the server begins accepting requests, so the registry is
never empty when the first API call arrives. Currently `collector.start()` launches
the tick loop in a background thread without blocking, so `app.run()` may begin
serving before the first tick completes.

### Deployment
- Runs directly on Linux (no Docker required)
- Flask serves both the API and the built React static files
- Docker Compose can be added later if useful for distribution

---

## Project Layout

```
drivecheck/
├── backend/
│   ├── .venv/
│   ├── app.py                  (Flask entry point + API routes)
│   ├── collector.py            (background polling thread + registry)
│   ├── config.py               (loads config.yaml)
│   ├── db.py                   (SQLite schema + access)
│   ├── settings.py             (user settings, persisted to data/settings.json)
│   ├── models.py                (DriveDescriptor, DriveContext, DriveState, DriveSnapshot, DCSignals, etc.)
│   ├── analysis/
│   │   ├── descriptor_rank.py  (scores DriveDescriptor candidates for dedup)
│   │   ├── severity.py         (shared ok/warn/crit threshold helper)
│   │   ├── health.py           (DCSignals -> DriveHealth: signal_flags + health_status)
│   │   └── smart_attributes.py (raw smartctl data -> AttributeRow list for the SMART tab)
│   ├── probes/
│   │   ├── scan/smartctl_scan.py             (default scan probe)
│   │   ├── traits/smartctl_traits.py         (default traits probe)
│   │   └── telemetry/smartctl_telemetry.py   (default telemetry probe)
│   └── drive_tools/
│       └── smartctl.py         (raw subprocess wrapper around smartctl -j)
├── frontend/
│   └── src/
│       ├── App.tsx, App.css
│       ├── DriveCard.tsx, DriveCard.css
│       ├── WorkspacePanel.tsx, WorkspacePanel.css  (tab shells — Health implemented, others stubs)
│       ├── HealthTab.tsx, HealthTab.css            (Health sub-tabs: Overview/SMART/Report)
│       ├── SmartAttributesPanel.tsx                (SMART attributes sub-page)
│       ├── signals.ts          (signal descriptors + footer signal defaults)
│       ├── format.ts
│       ├── types.ts
│       └── main.tsx
├── data/
│   ├── drivecheck.db
│   ├── settings.json
│   └── reports/
│       └── <drive-guid>/
│           ├── <timestamp>.json
│           └── <timestamp>.html
└── config.yaml
```

`drive_tools/base.py`, `drive_tools/badblocks.py`, and `job_registry.py` aren't shown
above — they're part of the not-yet-built Operations/Jobs system (see Operation
Architecture and Project Status).

---

## Probe System

### Overview
The collector delegates data collection to a probe system, organized as
`probes/scan/`, `probes/traits/`, `probes/telemetry/` subpackages. Scan and traits
each run one hardcoded probe per stage. Telemetry runs a list of probes
(`_TELEMETRY_PROBES` in `collector.py`) chained in order — each probe receives and
returns the `DriveSnapshot`, enriching it before passing it to the next. Today
that list has a single hardcoded entry. The target design (see Probe config below)
is for all three stages' probe lists to be Python modules loaded by dotted path
from config, so users can write their own and add them to configured lists.

### Scan probes
Discover attached drives. Take no arguments. Return a list of `DriveDescriptor`s.
The default (`probes/scan/smartctl_scan.py`) runs `smartctl --scan -j` and parses
the result. Could be swapped for `lsblk`, a vendor tool, or any custom discovery logic.

```python
def run() -> list[DriveDescriptor]:
    ...
```

### Traits probes
Populate `DriveTraits` for a specific drive. Receive a `DriveDescriptor` — at this
point no GUID has been assigned yet — and return a `DriveTraits`. Run by the
collector only on first discovery of a drive; reduced-interval refresh for
already-known drives is target design (see Project Status).

```python
def run(descriptor: DriveDescriptor) -> DriveTraits:
    ...
```

### Telemetry probes
Receive and return the full `DriveSnapshot`, chained in `_TELEMETRY_PROBES` list
order with the last probe having final authority over any field. Each probe
enriches:
- `snapshot.telemetry` — a fresh `DriveTelemetry(signals, last_polled_at)`
  (normalized DCSignals fields)
- `snapshot.extras` — free-form dict for anything without a first-class field
  (e.g. `extras["smartctl"]` holds the full raw `smartctl -a -j` output)
- `snapshot.probe_log` — append a `ProbeRecord` on completion

```python
def run(snapshot: DriveSnapshot, context: DriveContext) -> DriveSnapshot:
    ...
```

The collector starts each poll with a fresh `DriveSnapshot()` and threads it
through `_TELEMETRY_PROBES` in order; the result becomes `state.snapshot`. Today
that list is a single hardcoded entry (`smartctl_telemetry`); dotted-path config
loading for multiple probes is target design (see Probe config below).

### Probe config (target design — see Project Status)
The dotted-path, list-based config loader below would replace the hardcoded
single-probe-per-stage imports described in Overview:

```yaml
scan_probes:
  - drivecheck.probes.scan.smartctl_scan

traits_probes:
  - drivecheck.probes.traits.smartctl_traits

telemetry_probes:
  - drivecheck.probes.telemetry.smartctl_telemetry
```

### Deduplication
Multiple scan probes or a single scan probe may return multiple descriptors for the
same physical drive (e.g. `/dev/sdb` and `/dev/bus/1 -d megaraid,0` for the same
drive behind a MegaRAID controller). The collector deduplicates by serial number
after the traits probe populates `DriveTraits`. All access paths are preserved
in `DriveState.attachment.descriptors`; the preferred path (first successful one)
is in `DriveState.attachment.device_path`.

If two access paths return different data for the same drive, both raw results are
stored in `extras` and merged at the dc_signals layer with defined precedence.

---

## Data Model

### Three-tier hierarchy

| Class | Created by | Contains | Passed to |
|---|---|---|---|
| `DriveDescriptor` | Scan probes | device path, access type, info name | Collector |
| `DriveContext` | Collector | GUID + DriveDescriptor + DriveTraits | Traits probes, Telemetry probes, Operations, Jobs |
| `DriveTraits` | Traits probes | serial, model, capacity, drive_type, etc. | DriveState, DriveContext, SQLite |
| `DriveSnapshot` | Telemetry probe chain | telemetry + health + extras + probe_log | SQLite (persisted per poll) |
| `DriveState` | Collector | DriveContext + DriveTraits + DriveAttachment + current DriveSnapshot | Registry, API |

### DriveDescriptor
Minimal scan output — just enough to identify and reach a drive.
- `device_name` — e.g. `/dev/sda` or `/dev/bus/1`
- `access_type` — e.g. `scsi`, `megaraid,0`, `ata` (passed as `-d` flag to smartctl)
- `info_name` — human-readable, e.g. `/dev/bus/1 [megaraid_disk_00]`

### DriveContext
Stable identity assembled by the collector after GUID lookup. Universal context
object passed to telemetry probes, operations, and jobs.
- `guid` — internal GUID (assigned on first detection, never changes)
- `descriptor` — the DriveDescriptor
- `traits` — DriveTraits (populated by traits probes)

### DriveTraits
Intrinsic physical characteristics. Stable across polls.
- `serial`, `model`, `capacity_bytes`
- `drive_type` — `"HDD"` | `"SSD"` | `"NVMe"` | `"SAS"` | `"Unknown"`
- `form_factor`, `rpm`, `bus`

### DriveAttachment
How the drive is attached right now — ephemeral.
- `device_path` — preferred access path
- `descriptors` — all DriveDescriptors that resolved to this serial
- `is_mounted`

### DCSignals
Drivecheck-normalized health signals. Protocol-agnostic. Mapped from raw data by
telemetry probes. These are what the card grid, overview tiles, and trend queries use.
Named without a `dc_` prefix — the `DCSignals` namespace makes them unambiguous.

| Signal | ATA source | SCSI/SAS source |
|---|---|---|
| `power_on_hours` | attr 09 raw | `power_on_time.hours` |
| `temp` | attr BE or C2 raw | `temperature.current` |
| `reallocated` | attr 05 raw | `scsi_grown_defect_list` |
| `pending` | attr C5 raw | read uncorrected errors (closest equivalent) |
| `uncorrected` | attr C6 raw | `scsi_error_counter_log` uncorrected |
| `crc_errors` | attr C7 raw | non-medium error count |
| `reallocated_events` | attr C4 raw | (ATA only; None for SAS) |
| `smart_passed` | ATA overall status | `smart_status.passed` |

Note: `pending` is an imperfect mapping for SAS — the UI surfaces this distinction.

### DriveSnapshot
Point-in-time capture of one collector poll. Persisted to SQLite; one row per poll per drive.
- `telemetry` — DriveTelemetry (contains DCSignals + last_polled_at)
- `health` — DriveHealth (health_pct, health_status)
- `extras` — free-form dict for arbitrary probe output; raw JSON blobs live here.
  Also holds `extras["smart_attributes"]` (`AttributeRow[]`) — per-attribute
  ok/warn/crit classification computed by `analysis/smart_attributes.py`,
  consumed by the SMART attributes sub-page
- `probe_log` — list of ProbeRecord (one per probe that ran)

### DriveState
Live in-memory view. Mutated by the collector across discovery and each poll
cycle as traits and telemetry probes return updated data. Lives in the
collector registry; read by API endpoints.
- `context` — DriveContext (stable identity)
- `traits` — DriveTraits (may be enriched by probes)
- `attachment` — DriveAttachment
- `snapshot` — current DriveSnapshot (replaced each poll)

---

## Drive Identity & SQLite Records

### GUID Assignment
A GUID is assigned the first time a drive is detected by the collector — on first
scan, not on first operation. Implemented as `uuid.uuid5(NAMESPACE, serial or
device_name)` in `collector.py`: deterministic and stable across restarts without
needing a SQLite lookup at assignment time. The collector then calls
`db.upsert_drive_record()`, which inserts the Drive Record on first sighting
(setting `first_seen`) or refreshes identity fields on later sightings while
preserving `first_seen`.

A DriveState in the registry always has a GUID by construction — it's assigned
before the DriveContext is created.

`conflict_flag` exists in the schema for the "multiple drives share a serial"
case from the original design, but no code path sets it yet (always 0).

### Drive Record fields
- `guid` TEXT PRIMARY KEY
- `serial` TEXT
- `model` TEXT
- `capacity_bytes` INTEGER
- `drive_type` TEXT
- `first_seen` TEXT (ISO timestamp)
- `conflict_flag` INTEGER (boolean)

---

## Operation Architecture

Distinct from probes. Operations are user-initiated tasks performed on a drive.
They are configured by the user in the Run Task tab and executed as Jobs.

### OperationBase
Each operation is a class inheriting from `OperationBase` (in `drive_tools/base.py`).

Every operation defines:
- `name` — human-readable string
- `category` — one of: Test, Scan, Maintenance
- `tool` — which CLI tool it uses
- `supports(context: DriveContext) -> bool` — can this operation run on this drive?
- `run(context: DriveContext, params: dict) -> dict` — execute and return result
- `get_progress() -> dict` — `{ percent, message, status }` for long-running ops

### Operation Registry
All operations collected into a single registry at startup (list of classes, not
instances). When a drive is selected, `supports(context)` is called on every
registered operation; those that pass are returned grouped by category. The UI
renders available operations from this list.

### Multiple tool implementations
If more than one tool implements the same operation (e.g. smartctl and nvme-cli both
implement a health read), both appear as options. The UI prompts the user to choose,
with notes surfacing constraints.

### Categories
- **Test** — drive-internal self-tests (SMART short, SMART extended, SMART conveyance)
- **Scan** — host-side scans (badblocks read-only, badblocks destructive)
- **Maintenance** — secure erase, etc. (v1 stretch)

---

## Job Lifecycle

```
Created → Running → Completed
                 ↘ Failed
                 ↘ Cancelled
```

- Jobs identified by UUID
- Active job state lives in memory (JobRegistry)
- On completion, result written to SQLite and report files generated
- Server restart mid-job loses the job — acceptable, user re-runs

### JobRegistry responsibilities
- Track status, progress, message, timestamps for active jobs
- Expose `is_cancelled(job_id)` for operation polling loops
- Progress read by frontend via REST endpoint on each poll cycle

---

## Storage: Time-Series Data

### Two-layer approach

**Layer 1 — dc_signals table (narrow, queryable)**
One row per signal per poll. Enables "what changed over X period" and trend queries.
Only the normalized DCSignals fields. Protocol differences are already resolved here.

```sql
CREATE TABLE drive_signals (
    id          INTEGER PRIMARY KEY,
    drive_guid  TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    signal      TEXT NOT NULL,   -- e.g. "reallocated", "temp"
    value       REAL
);
CREATE INDEX idx_drive_signals_lookup ON drive_signals (drive_guid, signal, captured_at);
```

Implemented in `backend/db.py`; written every poll via `db.record_signals()`.

**Layer 2 — raw snapshots (periodic JSON blobs)**
Full smartctl JSON output stored periodically. Enables "what were all attributes at
time T." Answers the raw SMART dump view in the UI.

```sql
CREATE TABLE drive_raw_snapshots (
    id          INTEGER PRIMARY KEY,
    drive_guid  TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    probe       TEXT NOT NULL,   -- which probe produced this
    raw_json    TEXT NOT NULL
);
CREATE INDEX idx_drive_raw_snapshots_lookup ON drive_raw_snapshots (drive_guid, captured_at);
```

Implemented in `backend/db.py`; written via `db.record_raw_snapshot()` from
`snapshot.extras` (currently `{"smartctl": <full -a -j output>}`), on each drive's
`snapshot` channel (default 14400s/4h) rather than every telemetry poll — this keeps
table growth bounded. `/api/drives/<guid>/raw/latest` (and `SmartAttributesPanel`)
can therefore lag the live signals by up to one `snapshot` interval. Splitting
`smart_attributes` persistence onto the `telemetry` cadence is a possible future
follow-up if that staleness proves annoying.

**Heartbeats** — one row per drive per collector cycle. Records presence, temperature,
and a reference to the current raw snapshot. Poll anchor for "was this drive visible
at time T" queries.

```sql
CREATE TABLE drive_heartbeats (
    id              INTEGER PRIMARY KEY,
    drive_guid      TEXT NOT NULL,
    captured_at     TEXT NOT NULL,
    temp_c          INTEGER,
    raw_snapshot_id INTEGER
);
CREATE INDEX idx_drive_heartbeats_lookup ON drive_heartbeats (drive_guid, captured_at);
```

Implemented in `backend/db.py`; written via `db.record_heartbeat()` on each drive's
`telemetry` channel. `raw_snapshot_id` is `NULL` for all new rows — heartbeats and
raw snapshots are written on independent channels/cadences now, so there's no
same-cycle snapshot to reference. The column stays in the schema (nullable) for
older rows; "what was the raw data near time T" queries should look up
`drive_raw_snapshots` by `captured_at` proximity instead.

### History retention
Configurable window (e.g. `keep_history_days: 90`). Old rows pruned by the collector.
Default TBD.

### Querying patterns

"What changed over 30 days":
```sql
SELECT captured_at, signal, value
FROM drive_signals
WHERE drive_guid = ? AND captured_at > ?
ORDER BY captured_at
```

"All attributes at time T":
```sql
SELECT raw_json FROM drive_raw_snapshots
WHERE drive_guid = ? AND captured_at <= ?
ORDER BY captured_at DESC LIMIT 1
```

"Temperature over 12 hours":
```sql
SELECT captured_at, temp_c FROM drive_heartbeats
WHERE drive_guid = ? AND captured_at > ?
ORDER BY captured_at
```

---

## Key Design Decisions & Rationale

| Decision | Rationale |
|---|---|
| Flask over FastAPI | Simpler, more stable, less magic. |
| Threads over asyncio | Jobs are subprocesses, not network I/O. Threading is the natural fit. GIL releases on subprocess I/O. |
| ThreadPoolExecutor for telemetry polling | Per-drive threads mean a hanging drive can't block others. Timeout is per-drive, not per-cycle. Target design — collector currently polls drives sequentially with no per-drive timeout (see Project Status). |
| Polling over SSE | Survives page refreshes and multi-hour jobs without session tracking. Adaptive interval is target design (see Live updates, Project Status). |
| SQLite from the start | Persistent storage needed to survive reconnects and restarts. Handles 20+ drives with time-series data at homelab scale. |
| SQLite WAL mode | Collector writes concurrently with API request readers. Required; set once at init. |
| No ORM | Raw sqlite3. No dependency, no learning cost, no magic at this scale. |
| Probe system for collection | User-configurable data collection without modifying core. Supports any tool (smartctl, lsblk, nvme-cli, vendor tools). Chain ordering gives clear authority. |
| Traits / Telemetry probe split | Traits are stable; polling them every cycle wastes I/O. Traits probes run on discovery + reduced interval. Telemetry probes run every cycle. Keeps probe signatures clean — telemetry probes never touch DriveTraits. |
| Operations separate from probes | Probes are passive collection. Operations are active user-initiated tasks. Different lifecycles, different ownership. |
| DriveContext as universal context | Single object passed to probes, operations, and jobs. Everyone gets the same view of what a drive is and where it is. |
| DCSignals as normalized layer | Protocol differences (ATA vs SAS) resolved once in the telemetry probe. Everything above the probe layer is protocol-agnostic. |
| Two-layer time-series storage | Narrow signals table for trend queries; JSON blob for full raw history. Neither alone is sufficient. |
| GUID assigned on first detection | Drive identity established as soon as the collector sees the drive, not deferred to first operation. Simpler lifecycle. |
| Serial as lookup key | Used for deduplication, not identity. Returns a list to handle rare duplicates. |
| extras dict on DriveSnapshot | Escape hatch for probe output that has no first-class field. Raw JSON, vendor data, lsblk output. Never discarded. |
| DriveSnapshot split from DriveState | DriveSnapshot is the persisted poll record; DriveState is the live registry entry. Enables historical trend queries without conflating mutable live state with immutable history. |
| Minimal dependencies | "Works in 10 years" is an explicit goal. Every dependency is a future maintenance burden. |
| JSON output from smartctl (-j) | More stable than text parsing. Schema-versioned. Defensive .get() calls handle missing keys gracefully. json_format_version checked at startup. |
| History retention configurable | Monitoring is supported but not the lead. User controls how much history to keep. |

---

## Explicitly Deferred (Do Not Add in v1)

- Historical trend chart UI (storage schema supports it; charts deferred)
- Email / push notifications
- Celery / Redis job queue
- Multi-user auth / roles
- NVMe-specific tool support (architecture accommodates it via probe system)
- RAID support
- Cross-platform (Windows/Mac) backend
- Community report upload
- Hub-and-spoke multi-node mode
- SMART retention policy UI
- Downsampling for long-range chart queries
- External probe directory (user probes live in project `probes/` for now)
- Controller-aware or thermal job scheduling
- Physical bay mapping / LED illumination

---

## Config File

Location: `config.yaml` at project root, loaded by `backend/config.py`.
(`docs/backend/designs/config.yaml.example` is an early draft and has drifted
from the fields below — `config.yaml` is the source of truth.)

Current fields:
```yaml
auth:
  username: admin
  password_hash: ""    # bcrypt hash — not yet enforced, see Auth in Project Status

collector:
  scan_interval: 300   # seconds — drive discovery (scan + reconciliation)
  poll_intervals:
    telemetry: 300     # seconds — signals + heartbeat, phase-staggered per drive
    snapshot: 14400    # seconds — raw smartctl JSON persistence, phase-staggered per drive

data:
  dir: ./data

server:
  host: 127.0.0.1
  port: 4343
  debug: false
```

Target fields, not yet present (see corresponding sections):
- `secret_key` — Flask session secret (Auth)
- `collector.telemetry_timeout`, `collector.keep_history_days` (Collector, History retention)
- `jobs.max_parallel` (Queue & Scheduler)
- `scan_probes` / `traits_probes` / `telemetry_probes` lists (Probe config)

---

## Future Architecture: Hub-and-Spoke

Post-v1. Each machine runs a drivecheck backend (a "spoke"). One instance is the hub,
serving the UI and proxying/aggregating spoke responses. GUIDs namespaced by node ID.

**Constraints to respect now (do not implement):**
- No hardcoded localhost assumptions
- API responses node-agnostic — hub adds node context at aggregation layer

---

## Project Status

### Done
[x] Stack and architecture decided
[x] Dev environment set up (Debian 13 VM)
[x] Project directory scaffolded at ~/projects/drivecheck
[x] Storage schema designed
[x] Data models designed (models.py written)
[x] Probe system architecture decided
[x] drive_tools/smartctl.py (raw subprocess wrapper)
[x] probes/scan/smartctl_scan.py
[x] probes/traits/smartctl_traits.py
[x] probes/telemetry/smartctl_telemetry.py
[x] collector.py (sequential polling — see gaps below)
[x] db.py (SQLite schema + access)
[x] app.py routes (drives, settings, refresh, collector status)
[x] User settings persistence (settings.py, data/settings.json)
[x] Frontend skeleton (Vite/React, drive card grid, workspace panel shell)
[x] Telemetry probe chain + extras/probe_log enrichment (raw JSON capture)
[x] drive_raw_snapshots persistence
[x] Per-channel, phase-staggered collector scheduler (telemetry/snapshot channels,
    tick-based loop, debounced forced refresh — see Collector / Polling intervals)

### Remaining — Collector / Probes
[ ] ThreadPoolExecutor + per-drive timeout for telemetry polling (currently sequential)
[ ] threading.Event for clean collector shutdown
[ ] Blocking initial poll before Flask starts serving (cold start guarantee)
[ ] Probe config loading by dotted path (currently hardcoded single-element list per stage)
[ ] History retention / pruning (keep_history_days)
[ ] Traits probe refresh on a reduced interval for already-known drives (currently runs once, on discovery only)
[ ] High-rate `vitals` channel for cheap temperature/IO reads (hwmon/drivetemp,
    /sys/class/block/<dev>/stat) — next step after the scheduler foundation
[ ] Frontend per-drive refresh controls + adaptive "last polled" display to match
    per-channel staggered polling (currently a single global header/refresh)

### Remaining — Operations / Jobs
[ ] drive_tools/base.py (OperationBase)
[ ] drive_tools/badblocks.py
[ ] job_registry.py
[ ] Operations / Jobs system end-to-end
[ ] Report generation (JSON + HTML)

### Remaining — Frontend
[x] Health tab: SMART attributes sub-page (SmartAttributesPanel.tsx)
[ ] Health tab: Overview / Report sub-pages (currently stubs)
[ ] History / Queue / Run Task tab implementations (currently stubs)
[ ] Adaptive poll interval (2s active / 10s idle) — currently flat 30s; depends on Jobs system

### Remaining — Auth
[ ] Login route + session cookie enforcement

---

## UI & Workflow

### Primary Use Case

Validating a batch of used drives before adding them to a storage pool — typically
4–15 drives in hot-swap bays simultaneously. The user identifies each drive, fires
off tests, monitors progress, and produces a per-drive report.

Task-first. History and monitoring are available but not the lead.

---

### Layout

**Drive card grid** — top, full width. Always visible. Identification and selection layer.

**Workspace panel** — bottom, full width. Context-sensitive. Responds to card selection.

Works in both landscape and portrait without special-casing.

---

### Drive Cards

Primary identification mechanism. Must provide enough information to confidently
identify a drive before targeting it with a destructive task.

**Each card displays (top to bottom):**
1. Header — selection ring · model · health badge · serial (monospace)
2. Identity row — drive type · capacity · bus · speed
3. Status row — temperature · `/dev/sdX` · mount status
4. Task zone — active task · progress bar · counters · ETA · queued count
5. Footer — key dc_signals (POH, reallocated, errors) · live IO (read/write MB/s)

**Card states:** Healthy · Degraded · Failing · Unrated/NEW · Idle · Active · Selected

**NEW badge:** Drive has no existing Drive Record in SQLite — first time seen by this
drivecheck instance. Not necessarily a new drive physically.

**Selection model:** Purple ring + dot on selection. Multiple cards selectable.
Selection is input to workspace panel. Does not clear between tab switches.

---

### Visual Design System

Dark theme throughout. Full palette in `drivecheck_card_reference.html`.

Key values:
- Page bg: `#191b20` · Card top: `#30323a` · Card bottom: `#272930` · Inset: `#1e2028`
- Borders: `#3e4050` / `#575b70`
- Text: `#f0f0f2` / `#c8ccd6` / `#a0a8b4` / `#888fa0`
- Healthy: `#14c050` / `#28ee84` · Degraded: `#ff9d2e` · Failing: `#ff7070`
- Task accent: `#18c4ee` / `#00eeff` · Selection: `#a855f7`
- IO read: `#48ccff` · IO write: `#b878ff`

Health color in left bar and badge only — never bleeds into card background.
Cyan reserved for task/interaction. Purple reserved for selection.

---

### Workspace Panel

Tabbed panel below card grid. Responds to current card selection.

**Tabs:** Health · History · Queue · Run task

---

### Health Tab (sub-pages)

**Overview** — stub. Target: 3×2 tile grid per selected drive:
health score · temperature sparkline · SMART flag count · POH · reallocated trend · last test
Below tiles: flagged dc_signals inline, or all-clear message.

**SMART attributes** — implemented (`SmartAttributesPanel.tsx`). Fetches
`/api/drives/<guid>/raw/latest` and renders `extras["smart_attributes"]`
(`AttributeRow[]`, computed by `analysis/smart_attributes.py` — see DriveSnapshot).
Rows are sorted client-side by severity (crit → warn → ok) so flagged attributes
float to top — the only "interpretation" left to the frontend, since reordering by
a backend-provided status doesn't require new thresholds. Drive switcher strip lists
all drives, defaulting to the most recently selected card, so the user can browse
any drive's SMART data without changing the card-grid selection.

**Report** — stub. Target: formatted summary: identity block · verdict · stat tiles ·
test history · flagged signals · export controls (Open in browser / Export HTML).

---

### History Tab

Past job executions per selected drive. Grouped by drive when multiple selected.
Columns: task name · result · duration · timestamp. Newest first.

---

### Queue Tab

Global job view — not filtered by drive selection. Running, queued, recently completed.
Expand toggle per row for detail and actions (Cancel / View report).

---

### Run Task Tab

Two-column: task category sidebar left, config form right.

Target drives from current card selection. Destructive operations show prominent
warning block. Confirmation step re-displays full drive identity before dispatch.

Action buttons: **Run now** · **Add to queue**

---

### Queue & Scheduler

- Max parallel jobs configurable (default 2, range 1–8)
- Excess jobs queue automatically; start as slots open
- No two jobs run concurrently on the same drive
