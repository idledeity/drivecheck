import { memo, useMemo, useState } from "react"
import { HEALTH_CLASS } from "../healthBands"
import { formatPoints } from "../HealthFactors"
import { IconChevronRight } from "@tabler/icons-react"
import { SIGNALS } from "../signals"
import ChartDriveChip from "./ChartDriveChip"
import { healthChanges, isFirstReading } from "./healthChanges"
import type { HealthChange } from "./healthChanges"
import type { ChartDrive } from "./historySeries"
import { momentLabel } from "./scales"
import type { DriveHistoryData } from "./useDriveHistory"
import "./HealthChangeLog.css"

// Entries shown before "Show all".
const SHOWN = 5

/** Under the health chart: each time a charted drive's score changed in the
 *  range, newest first, with what changed it. An entry opens to the score's
 *  factors as of then (re-scored from the values stored then). Also the
 *  chart's data in text, for anyone not using the hover readout. */
function HealthChangeLog({ data, drives }: { data: DriveHistoryData; drives: ChartDrive[] }) {
  const changes = useMemo(() => healthChanges(data, drives), [data, drives])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  if (!changes.length) return <p className="hcl-none">No score changes in this range</p>

  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const shown = showAll ? changes : changes.slice(0, SHOWN)
  return (
    <div className="hcl">
      <div className="hcl-head">
        <h4 className="hcl-title">Score changes</h4>
        <span className="hcl-note">Newest first · open one for the score's factors then</span>
      </div>
      <ul className="hcl-list" aria-label="Health score changes">
        {shown.map(c => {
          const key = `${c.drive.guid}-${c.t}`
          const isOpen = open.has(key)
          return (
            <li key={key} className={`hcl-entry${isOpen ? " open" : ""}`}>
              <button type="button" className={`hcl-main${drives.length > 1 ? "" : " one-drive"}`} aria-expanded={isOpen} onClick={() => toggle(key)}>
                <span className="hcl-when">{momentLabel(c.t)}</span>
                {/* One drive charted: the chips above already say whose. */}
                {drives.length > 1 && <ChartDriveChip drive={c.drive} />}
                <span className="hcl-score">
                  {c.from?.pct ?? "—"} → {c.to.pct}
                  {c.to.status && <span className={`hcl-status tone-${HEALTH_CLASS[c.to.status] ?? "none"}`}>{c.to.status}</span>}
                </span>
                <span className="hcl-why">
                  {c.why.text}
                  {isFirstReading(c) && <FirstTag />}
                </span>
                <IconChevronRight size={12} className="hcl-caret" aria-hidden />
              </button>
              {isOpen && <AsOfThen data={data} change={c} />}
            </li>
          )
        })}
      </ul>
      {changes.length > SHOWN && (
        <button type="button" className="hcl-more" onClick={() => setShowAll(v => !v)}>
          {showAll ? "Show fewer" : `Show all ${changes.length}`}
        </button>
      )}
    </div>
  )
}

function FirstTag({ short = false }: { short?: boolean }) {
  return (
    <span className="hcl-first" title="The first value read for this drive: not a change in the drive">
      <span aria-hidden>◇</span> {short ? "first" : "first reading"}
    </span>
  )
}

/** A change's score as of then: each factor, what it would score alone, and
 *  what it did to the score; plus any signal first read then that isn't
 *  scored, so everything new at that moment is in one place. */
function AsOfThen({ data, change }: { data: DriveHistoryData; change: HealthChange }) {
  const { to, from, firsts } = change
  const wasStart = from?.factors.find(f => f.role === "start")?.key
  const scored = new Set(to.factors.flatMap(f => (f.signal ? [f.signal] : [])))
  const unscored = [...firsts].filter(name => !scored.has(name) && SIGNALS[name] && name !== "temp" && name !== "power_on_hours")
  const signalValue = (name: string) =>
    data.drives[change.drive.guid]?.signals[name]?.findLast(p => p.t <= change.t)?.value ?? null
  return (
    <div className="hcl-asof">
      <div className="hcl-asof-head">Health <b>as of {momentLabel(change.t)}</b>, scored from the values stored then</div>
      {to.factors.length === 0 && unscored.length === 0 ? (
        <p className="hcl-asof-none">Nothing lowered the score</p>
      ) : (
        <div className="hcl-scroll">
          <table className="hcl-table">
            <thead>
              <tr><th>Factor</th><th className="num">Value</th><th className="num">On its own</th><th>Role</th><th className="num">Points</th></tr>
            </thead>
            <tbody>
              {to.factors.map(f => (
                <tr key={f.key}>
                  <td className={f.role === "start" ? "hcl-sets" : undefined}>{f.label}</td>
                  <td className="num">
                    {f.value}
                    {f.signal && firsts.has(f.signal) && <FirstTag short />}
                  </td>
                  <td className="num">{Math.round(f.standalone)}</td>
                  <td>
                    <span className={`hcl-role${f.role === "start" ? " start" : ""}`}>{f.role === "start" ? "sets the score" : "lowers it"}</span>
                    {f.role !== "start" && f.key === wasStart && <span className="hcl-was"> (set it before)</span>}
                  </td>
                  <td className="num">{formatPoints(f)}</td>
                </tr>
              ))}
              {unscored.map(name => {
                const v = signalValue(name)
                return (
                  <tr key={name} className="hcl-unscored">
                    <td>{SIGNALS[name].name}</td>
                    <td className="num">{v === null ? "—" : SIGNALS[name].format(v)}<FirstTag short /></td>
                    <td className="num">—</td>
                    <td><span className="hcl-role">not scored</span></td>
                    <td className="num" />
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {to.floor !== null && <p className="hcl-asof-floor">Held at {to.floor}: age, wear and heat alone don't lower it further</p>}
    </div>
  )
}

// Memoized: the panel re-renders on every 2s poll; the log only changes with
// the history data or the drives charted.
export default memo(HealthChangeLog)
