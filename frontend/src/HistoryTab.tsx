import { useEffect, useMemo, useState } from "react"
import type { Drive, Job, JobStatus } from "./types"
import { mergeHistory } from "./jobHistory"
import { JobRow } from "./QueueTab"
import { DriveChipHeader } from "./DriveChip"
import { Control, FilterChip, Segmented } from "./Controls"
import { dayLabel, toLocalIso } from "./format"
import "./QueueTab.css"
import "./HistoryTab.css"

interface Props {
  drives: Drive[]
  selectedGuids: string[]
  jobs: Job[]  // App's live /api/jobs list (this session's jobs, polled)
  onCancel: (jobId: string) => void
}

type Range = "24h" | "7d" | "14d" | "30d" | "90d" | "all"
type Sort = "new" | "old" | "long" | "drive"
type FinishedStatus = Exclude<JobStatus, "queued" | "running">

const HOUR = 3600e3
const RANGE_MS: Record<Exclude<Range, "all">, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "14d": 14 * 24 * HOUR, "30d": 30 * 24 * HOUR, "90d": 90 * 24 * HOUR }
const RANGES: Range[] = ["24h", "7d", "14d", "30d", "90d", "all"]
// The statuses a finished job can have, in filter-chip order.
const FINISHED_STATUSES: { value: FinishedStatus; label: string }[] = [
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "interrupted", label: "Interrupted" },
]
const IS_FINISHED = new Set<string>(FINISHED_STATUSES.map(s => s.value))
// The history route caps a request at 500 jobs.
const FETCH_LIMIT = 500
const PAGE = 50

const finishedAt = (j: Job) => new Date(j.finished_at ?? j.created_at).getTime()
const duration = (j: Job) => j.started_at && j.finished_at ? new Date(j.finished_at).getTime() - new Date(j.started_at).getTime() : -1

// The finished-job log: one fetch per time range, with every other filter
// applied here so changing it is instant and the status counts stay complete.
export default function HistoryTab({ drives, selectedGuids, jobs: liveJobs, onCancel }: Props) {
  const [range, setRange] = useState<Range>("14d")
  const [scope, setScope] = useState<"all" | "selected">("all")
  // Which finished statuses the list shows (the Status filter chips).
  const [shownStatuses, setShownStatuses] = useState<Set<FinishedStatus>>(() => new Set(FINISHED_STATUSES.map(s => s.value)))
  const [operation, setOperation] = useState("all")
  const [sort, setSort] = useState<Sort>("new")
  const [grouped, setGrouped] = useState(false)
  const [includeDebug, setIncludeDebug] = useState(false)
  const [shown, setShown] = useState(PAGE)
  // Fetched rows, tagged with the range they were fetched for: a range change
  // shows nothing stale while the new fetch is in flight.
  // fetchedAt anchors the "Today"/"Yesterday" labels (render must stay pure).
  const [stored, setStored] = useState<{ range: Range; since: number | null; fetchedAt: number; jobs: Job[] } | null>(null)

  useEffect(() => {
    const since = range === "all" ? null : Date.now() - RANGE_MS[range]
    const url = `/api/jobs/history?limit=${FETCH_LIMIT}${since === null ? "" : `&since=${encodeURIComponent(toLocalIso(since))}`}`
    let current = true
    fetch(url)
      .then(r => r.json())
      .then((rows: Job[]) => { if (current) setStored({ range, since, fetchedAt: Date.now(), jobs: Array.isArray(rows) ? rows : [] }) })
      .catch(() => { if (current) setStored({ range, since, fetchedAt: Date.now(), jobs: [] }) })
    return () => { current = false }
  }, [range])

  const loaded = stored?.range === range ? stored : null

  // Stored rows plus live jobs that finished in range but may not be saved yet.
  const inRange = useMemo(() => {
    if (!loaded) return null
    const live = liveJobs.filter(j => IS_FINISHED.has(j.status) && (loaded.since === null || finishedAt(j) >= loaded.since))
    return mergeHistory(loaded.jobs, live).filter(j => IS_FINISHED.has(j.status))
  }, [loaded, liveJobs])

  const scoped = useMemo(() => (inRange ?? []).filter(j =>
    (scope === "all" || selectedGuids.includes(j.drive_guid)) && (includeDebug || j.category !== "Debug"),
  ), [inRange, scope, selectedGuids, includeDebug])

  const operations = useMemo(() => {
    const names = new Map<string, string>()
    scoped.forEach(j => names.set(j.operation, j.operation_name))
    return [...names].sort((a, b) => a[1].localeCompare(b[1]))
  }, [scoped])

  const byOperation = scoped.filter(j => operation === "all" || j.operation === operation)
  const driveName = (guid: string) => { const d = drives.find(x => x.guid === guid); return d ? `${d.label ?? d.model ?? d.device} ${d.serial ?? ""}` : "~" }
  const listed = byOperation.filter(j => shownStatuses.has(j.status as FinishedStatus)).sort((a, b) => {
    if (sort === "old") return finishedAt(a) - finishedAt(b)
    if (sort === "long") return duration(b) - duration(a)
    if (sort === "drive") return driveName(a.drive_guid).localeCompare(driveName(b.drive_guid)) || finishedAt(b) - finishedAt(a)
    return finishedAt(b) - finishedAt(a)
  })
  const visible = listed.slice(0, shown)
  const hiddenDebug = (inRange ?? []).filter(j => j.category === "Debug" && (scope === "all" || selectedGuids.includes(j.drive_guid))).length

  // Turns one status chip on or off; the last chip that's on stays on, so the
  // list never filters itself down to nothing by accident.
  const toggleShownStatus = (status: FinishedStatus) => setShownStatuses(prev => {
    const next = new Set(prev)
    if (next.has(status)) { if (next.size > 1) next.delete(status) } else next.add(status)
    return next
  })
  const reset = (fn: () => void) => { fn(); setShown(PAGE) }

  return (
    <div className="history-tab">
      <div className="filter-row">
        <Control label="Finished in">
          <Segmented label="Finished in" idPrefix="history-range" value={range} onChange={v => reset(() => setRange(v))}
            options={RANGES.map(r => ({ value: r, label: r === "all" ? "All" : r }))} />
        </Control>
        <Control label="Drives">
          <Segmented label="Drives" idPrefix="history-scope" value={scope} onChange={v => reset(() => setScope(v))} options={[
            { value: "all", label: "All" },
            { value: "selected", label: `Selected (${selectedGuids.length})`, disabled: selectedGuids.length === 0, title: selectedGuids.length ? undefined : "Select drives in the grid first" },
          ]} />
        </Control>
        <Control label="Status">
          <div className="filter-chips">
            {FINISHED_STATUSES.map(s => (
              <FilterChip key={s.value} pressed={shownStatuses.has(s.value)} onToggle={() => reset(() => toggleShownStatus(s.value))}>
                {s.label} <span className="filter-chip-count">{byOperation.filter(j => j.status === s.value).length}</span>
              </FilterChip>
            ))}
          </div>
        </Control>
        <Control label="Operation" htmlFor="history-operation">
          <select id="history-operation" className="ctl-select" value={operation} onChange={e => reset(() => setOperation(e.target.value))}>
            <option value="all">All operations</option>
            {operations.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            {operation !== "all" && !operations.some(([key]) => key === operation) && <option value={operation}>{operation}</option>}
          </select>
        </Control>
        <Control label="Sort" htmlFor="history-sort">
          <select id="history-sort" className="ctl-select" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
            <option value="long">Longest first</option>
            <option value="drive">By drive</option>
          </select>
        </Control>
        <label className="ctl-check"><input type="checkbox" id="history-group" checked={grouped} onChange={e => setGrouped(e.target.checked)} /> Group by drive</label>
        <label className="ctl-check"><input type="checkbox" id="history-debug" checked={includeDebug} onChange={e => reset(() => setIncludeDebug(e.target.checked))} /> Include debug jobs</label>
      </div>

      {inRange === null ? null : (
        <>
          <p className="history-count">
            {listed.length} job{listed.length === 1 ? "" : "s"}
            {!includeDebug && hiddenDebug > 0 && ` · ${hiddenDebug} debug job${hiddenDebug === 1 ? "" : "s"} hidden`}
            {loaded && loaded.jobs.length >= FETCH_LIMIT && ` · showing the latest ${FETCH_LIMIT} in this range`}
          </p>
          {listed.length === 0 ? (
            <p className="history-empty">
              {range === "all" ? "No jobs match these filters." : `No jobs finished in the last ${range} match these filters.`}
              {range !== "all" && <> <button className="history-link" onClick={() => reset(() => setRange("all"))}>Show all time</button></>}
            </p>
          ) : grouped ? (
            groupByDrive(visible).map(([guid, js]) => (
              <section key={guid} className="history-group">
                <DriveChipHeader drive={drives.find(d => d.guid === guid)} className="history-drive-header" />
                {js.map(job => <JobRow key={job.id} job={job} drive={drives.find(d => d.guid === job.drive_guid)} onCancel={onCancel} />)}
              </section>
            ))
          ) : (
            <div className="history-list">
              {visible.map((job, i) => {
                const now = loaded?.fetchedAt ?? finishedAt(job)
                const day = sort === "new" || sort === "old" ? dayLabel(finishedAt(job), now) : null
                const prev = i > 0 && day ? dayLabel(finishedAt(visible[i - 1]), now) : null
                return (
                  <div key={job.id} className="history-item">
                    {day && day !== prev && <h3 className="history-day">{day}</h3>}
                    <JobRow job={job} drive={drives.find(d => d.guid === job.drive_guid)} onCancel={onCancel} />
                  </div>
                )
              })}
            </div>
          )}
          {listed.length > shown && (
            <button className="history-link history-more" onClick={() => setShown(n => n + PAGE)}>
              Show {Math.min(PAGE, listed.length - shown)} more
            </button>
          )}
          {range !== "all" && listed.length > 0 && listed.length <= shown && (
            <button className="history-link history-more" onClick={() => reset(() => setRange("all"))}>Show older jobs</button>
          )}
          <p className="history-note">
            This is DriveCheck's own job log. For self-tests run outside DriveCheck (or that predate it),
            see the drive's native self-test log on the SMART attributes tab.
          </p>
        </>
      )}
    </div>
  )
}

function groupByDrive(jobs: Job[]): [string, Job[]][] {
  const groups = new Map<string, Job[]>()
  jobs.forEach(j => { const g = groups.get(j.drive_guid); if (g) g.push(j); else groups.set(j.drive_guid, [j]) })
  return [...groups]
}
