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
| **DriveContext** | Collector-assembled identity object — GUID + DriveDescriptor + DriveTraits. Passed to scrape probes, operations, and jobs. |
| **DriveSnapshot** | Full in-memory view of a drive — DriveContext + live telemetry + health + extras + probe log. Lives in the registry. |
| **DCSignals** | Drivecheck-normalized health signals mapped from raw protocol data. Protocol-agnostic. |
| **Scan probe** | A configurable script that discovers attached drives and returns DriveDescriptors. |
| **Scrape probe** | A configurable script that receives a DriveContext + DriveSnapshot, enriches the snapshot, and returns it. |
| **Probe chain** | Ordered list of scrape probes run per drive per collector cycle. Last probe has final authority. |
| **Operation** | A user-initiated task performed on a drive (SMART test, badblocks scan, etc.). Distinct from probes. |
| **Job** | A running or completed instance of an operation against a specific drive. |
| **Drive Record** | The persistent SQLite entry for a known drive, keyed by GUID. |
| **Registry** | Module-level dict in collector.py holding the current DriveSnapshot for every attached drive. Source of truth for all live API responses. |

---

## Stack

### Backend
- **Language:** Python 3.x
- **Framework:** Flask (minimal, no async, no ORM)
- **Concurrency:** Python `threading` module (standard library)
  - Collector runs as a daemon thread; dispatches per-drive scrape threads via `ThreadPoolExecutor`
  - Long-running jobs (badblocks, SMART extended test) run in dedicated daemon threads
  - A shared in-memory job registry tracks all active jobs
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
  - Adaptive interval: 2s when any job is active, 10s when all drives are idle
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
- Run scan probes to discover attached drives
- Deduplicate discovered drives by serial number; prefer earlier access paths, fall
  back to later ones if the earlier path yields less data
- For each discovered drive, look up or assign a GUID in SQLite and build a DriveContext
- Dispatch one scrape thread per drive via ThreadPoolExecutor
- Each scrape thread runs the configured scrape probe chain in order, passing the
  evolving DriveSnapshot through each probe
- Commit the final DriveSnapshot to the in-memory registry
- Write dc_signals and periodic raw snapshots to SQLite

**Threading:**
- Collector loop runs as a daemon thread started at Flask startup
- Per-drive scrape threads run inside a ThreadPoolExecutor (max_workers configurable)
- Each scrape thread has its own timeout — a hanging drive does not block others
- Uses a `threading.Event` for clean shutdown signaling
- WAL mode ensures collector writes don't block API request threads

**Polling interval:**
- Configurable in `config.yaml` (default: 300 seconds)
- Single interval for all collection. No per-channel rates.

**Cold start:** On Flask startup, the collector runs one immediate poll before the
server begins accepting requests, so the registry is never empty when the first API
call arrives.

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
│   ├── app.py                  (Flask entry point)
│   ├── collector.py            (background polling thread + registry)
│   ├── job_registry.py         (in-memory job state)
│   ├── db.py                   (SQLite access)
│   ├── models.py               (DriveDescriptor, DriveContext, DriveSnapshot, DCSignals, etc.)
│   ├── probes/
│   │   ├── __init__.py         (probe loader — imports probe modules by dotted path from config)
│   │   ├── smartctl_scan.py    (default scan probe)
│   │   └── smartctl_scrape.py  (default scrape probe)
│   └── drive_tools/
│       ├── __init__.py
│       ├── base.py             (OperationBase class)
│       ├── smartctl.py         (raw subprocess wrapper + smartctl Operation classes)
│       └── badblocks.py        (badblocks Operation classes)
├── frontend/
│   └── ...                     (Vite/React scaffold)
├── data/
│   ├── drivecheck.db
│   └── reports/
│       └── <drive-guid>/
│           ├── <timestamp>.json
│           └── <timestamp>.html
└── config.yaml
```

---

## Probe System

### Overview
The collector delegates data collection to a configurable probe system. Probes are
Python modules loaded by dotted path from config. drivecheck ships default probes;
users can write their own and add them to the configured lists.

### Scan probes
Discover attached drives. Take no arguments. Return a list of `DriveDescriptor`s.
The default (`probes/smartctl_scan.py`) runs `smartctl --scan -j` and parses the
result. Could be swapped for `lsblk`, a vendor tool, or any custom discovery logic.

```python
def run() -> list[DriveDescriptor]:
    ...
```

### Scrape probes
Enrich a DriveSnapshot with data about a specific drive. Receive a `DriveContext`
and the current `DriveSnapshot`; return the enriched snapshot. The probe chain passes
the snapshot through each probe in config list order — last probe has final authority
over any field.

```python
def run(context: DriveContext, snapshot: DriveSnapshot) -> DriveSnapshot:
    ...
```

Probes write to:
- First-class fields (`snapshot.traits`, `snapshot.telemetry.signals`, etc.)
- `snapshot.extras` — free-form dict for anything without a first-class field
  (raw smartctl JSON, lsblk output, vendor data, etc.)
- `snapshot.probe_log` — append a `ProbeRecord` on completion

### Probe config
```yaml
scan_probes:
  - drivecheck.probes.smartctl_scan

scrape_probes:
  - drivecheck.probes.smartctl_scrape
```

### Deduplication
Multiple scan probes or a single scan probe may return multiple descriptors for the
same physical drive (e.g. `/dev/sdb` and `/dev/bus/1 -d megaraid,0` for the same
drive behind a MegaRAID controller). The collector deduplicates by serial number
after the first scrape probe that populates traits. All access paths are preserved
in `DriveContext.attachment.descriptors`; the preferred path (first successful one)
is in `DriveContext.attachment.device_path`.

If two access paths return different data for the same drive, both raw results are
stored in `extras` and merged at the dc_signals layer with defined precedence.

---

## Data Model

### Three-tier hierarchy

| Class | Created by | Contains | Passed to |
|---|---|---|---|
| `DriveDescriptor` | Scan probes | device path, access type, info name | Collector |
| `DriveContext` | Collector | GUID + DriveDescriptor + DriveTraits | Scrape probes, Operations, Jobs |
| `DriveSnapshot` | Scrape probe chain | DriveContext + telemetry + health + extras + probe_log | Registry, API, SQLite |

### DriveDescriptor
Minimal scan output — just enough to identify and reach a drive.
- `device_name` — e.g. `/dev/sda` or `/dev/bus/1`
- `access_type` — e.g. `scsi`, `megaraid,0`, `ata` (passed as `-d` flag to smartctl)
- `info_name` — human-readable, e.g. `/dev/bus/1 [megaraid_disk_00]`

### DriveContext
Stable identity assembled by the collector after GUID lookup. Universal context
object passed to scrape probes, operations, and jobs.
- `guid` — internal GUID (assigned on first detection, never changes)
- `descriptor` — the DriveDescriptor
- `traits` — DriveTraits (populated by scrape probes)

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
scrape probes. These are what the card grid, overview tiles, and trend queries use.
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
Full in-memory view. The probe chain passes this object through each scrape probe.
- `context` — DriveContext
- `traits` — DriveTraits (may be enriched by probes)
- `attachment` — DriveAttachment
- `telemetry` — DriveTelemetry (contains DCSignals + last_polled_at)
- `health` — DriveHealth (health_pct, health_status)
- `extras` — free-form dict for arbitrary probe output; raw JSON blobs live here
- `probe_log` — list of ProbeRecord (one per probe that ran)

---

## Drive Identity & SQLite Records

### GUID Assignment
A GUID is assigned the first time a drive is detected by the collector — on first
scan, not on first operation. The collector queries SQLite by serial number immediately
after a scrape probe populates traits:
1. Match found → attach existing GUID to DriveContext
2. No match → assign new GUID, write Drive Record to SQLite immediately
3. Multiple matches → compare traits (capacity, type, model); use the full match.
   If still ambiguous, assign new GUID and set `conflict_flag`. Do not prompt mid-scan.

A DriveSnapshot in the registry always has a GUID. The GUID may be absent only
transiently during the probe chain before the collector has done the SQLite lookup.

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
    id           INTEGER PRIMARY KEY,
    drive_guid   TEXT,
    captured_at  TEXT,
    signal       TEXT,   -- e.g. "reallocated", "temp"
    value        REAL,
    INDEX (drive_guid, signal, captured_at)
)
```

**Layer 2 — raw snapshots (periodic JSON blobs)**
Full smartctl JSON output stored periodically. Enables "what were all attributes at
time T." Written on every dc_signal change plus a periodic floor (e.g. every 12 polls).
Answers the raw SMART dump view in the UI.

```sql
CREATE TABLE drive_raw_snapshots (
    id           INTEGER PRIMARY KEY,
    drive_guid   TEXT,
    captured_at  TEXT,
    probe        TEXT,   -- which probe produced this
    raw_json     TEXT,
    INDEX (drive_guid, captured_at)
)
```

**Heartbeats** — one row per drive per collector cycle. Records presence, temperature,
and a reference to the current raw snapshot. Poll anchor for "was this drive visible
at time T" queries.

```sql
CREATE TABLE drive_heartbeats (
    id               INTEGER PRIMARY KEY,
    drive_guid       TEXT,
    captured_at      TEXT,
    temp_c           INTEGER,
    raw_snapshot_id  INTEGER,
    INDEX (drive_guid, captured_at)
)
```

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
| ThreadPoolExecutor for scrape | Per-drive threads mean a hanging drive can't block others. Timeout is per-drive, not per-cycle. |
| Polling over SSE | Survives page refreshes and multi-hour jobs without session tracking. Adaptive interval (2s active / 10s idle). |
| SQLite from the start | Persistent storage needed to survive reconnects and restarts. Handles 20+ drives with time-series data at homelab scale. |
| SQLite WAL mode | Collector writes concurrently with API request readers. Required; set once at init. |
| No ORM | Raw sqlite3. No dependency, no learning cost, no magic at this scale. |
| Probe system for collection | User-configurable data collection without modifying core. Supports any tool (smartctl, lsblk, nvme-cli, vendor tools). Chain ordering gives clear authority. |
| Operations separate from probes | Probes are passive collection. Operations are active user-initiated tasks. Different lifecycles, different ownership. |
| DriveContext as universal context | Single object passed to probes, operations, and jobs. Everyone gets the same view of what a drive is and where it is. |
| DCSignals as normalized layer | Protocol differences (ATA vs SAS) resolved once in the scrape probe. Everything above the probe layer is protocol-agnostic. |
| Two-layer time-series storage | Narrow signals table for trend queries; JSON blob for full raw history. Neither alone is sufficient. |
| GUID assigned on first detection | Drive identity established as soon as the collector sees the drive, not deferred to first operation. Simpler lifecycle. |
| Serial as lookup key | Used for deduplication, not identity. Returns a list to handle rare duplicates. |
| extras dict on DriveSnapshot | Escape hatch for probe output that has no first-class field. Raw JSON, vendor data, lsblk output. Never discarded. |
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

Location: `config.yaml` at project root.

```yaml
auth:
  username: admin
  password_sha256: <hex digest>

data_dir: ./data

flask:
  host: 0.0.0.0
  port: 5000
  debug: false
  secret_key: <random string>

collector:
  poll_interval: 300        # seconds
  scrape_timeout: 120       # per-drive timeout in seconds
  keep_history_days: 90

jobs:
  max_parallel: 2           # range 1–8

scan_probes:
  - drivecheck.probes.smartctl_scan

scrape_probes:
  - drivecheck.probes.smartctl_scrape
```

---

## Future Architecture: Hub-and-Spoke

Post-v1. Each machine runs a drivecheck backend (a "spoke"). One instance is the hub,
serving the UI and proxying/aggregating spoke responses. GUIDs namespaced by node ID.

**Constraints to respect now (do not implement):**
- No hardcoded localhost assumptions
- API responses node-agnostic — hub adds node context at aggregation layer

---

## Project Status

[x] Stack and architecture decided
[x] Dev environment set up (Debian 13 VM)
[x] Project directory scaffolded at ~/projects/drivecheck
[x] Storage schema designed
[x] Data models designed (models.py written)
[x] Probe system architecture decided
[ ] drive_tools/smartctl.py (raw subprocess wrapper)
[ ] probes/smartctl_scan.py
[ ] probes/smartctl_scrape.py
[ ] drive_tools/base.py (OperationBase)
[ ] drive_tools/badblocks.py
[ ] db.py (SQLite schema + access)
[ ] collector.py
[ ] job_registry.py
[ ] app.py routes
[ ] Report generation (JSON + HTML)
[ ] Frontend skeleton (Vite/React, basic routing)
[ ] Auth

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

**Overview** — 3×2 tile grid per selected drive:
health score · temperature sparkline · SMART flag count · POH · reallocated trend · last test
Below tiles: flagged dc_signals inline, or all-clear message.

**SMART attributes** — full raw attribute dump from `extras`. Flagged attributes float
to top. Drive switcher strip for multi-drive selection.

**Report** — formatted summary: identity block · verdict · stat tiles · test history ·
flagged signals · export controls (Open in browser / Export HTML).

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
