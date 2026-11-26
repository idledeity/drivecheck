import type { Drive, SelfTestCoverage, SelfTestEntry } from "./types"
import AsOf from "./AsOf"
import { formatTimestamp } from "./format"
import "./SelfTestLights.css"

type LatestEntry = SelfTestCoverage["latest"]["short"]
type LightState = "fail" | "pass" | "idle" | "none" | "unknown"

/** A test kind's light: red when its latest finished test failed, green when
 *  it passed within the kind's "recent" window (Settings › Self-tests), dim
 *  when it passed longer ago (or its age is unknown), an empty ring when the
 *  drive has never logged one. An amber ring when the drive stopped returning
 *  its log (logMissing): a newer test may have run unseen. A known failure
 *  stays red. */
function lightState(entry: LatestEntry, logMissing = false): LightState {
  if (entry?.drive_report === "failed") return "fail"
  if (logMissing) return "unknown"
  if (!entry) return "none"
  return entry.recent ? "pass" : "idle"
}

const LIGHT_TITLE: Record<LightState, string> = {
  fail: "latest failed",
  pass: "passed recently",
  idle: "no recent test",
  none: "never run",
  unknown: "unknown, the drive isn't returning its log",
}

function Light({ state }: { state: LightState }) {
  return <span className={`stl-led stl-${state}`} />
}

/** The drive card's two status lights: S = Short self-test, L = Long (Extended). */
export default function SelfTestLights({ coverage }: { coverage: SelfTestCoverage }) {
  const lights = [
    { letter: "S", name: "Short", state: lightState(coverage.latest.short, coverage.log_missing) },
    { letter: "L", name: "Long (Extended)", state: lightState(coverage.latest.long, coverage.log_missing) },
  ]
  return (
    <span className="stl" aria-label={lights.map(l => `${l.name} self-test: ${LIGHT_TITLE[l.state]}`).join("; ")}>
      {lights.map(l => (
        <span key={l.letter} className="stl-item">
          <Light state={l.state} />
          {l.letter}
        </span>
      ))}
    </span>
  )
}

const KINDS = [
  { key: "short", label: "Short" },
  { key: "conveyance", label: "Conveyance" },
  { key: "long", label: "Long (Extended)" },
] as const

/** The card's self-test popover: each kind's latest finished test, then the
 *  age of the SMART read the card's values come from. */
export function SelfTestPopover({ drive, reading }: { drive: Drive; reading: boolean }) {
  return (
    <div className="stl-pop">
      <div className="stl-pop-title">Self-tests</div>
      <SelfTestCoverageRows coverage={drive.self_test_coverage} />
      <div className="stl-pop-read">
        <span>SMART read</span>
        {reading
          ? <span className="stl-reading">reading…</span>
          : drive.last_polled_at
            ? <AsOf at={drive.last_polled_at} staleAfterS={drive.stale_after_s.smart} />
            : <span>never</span>}
      </div>
    </div>
  )
}

/** Each kind's latest finished self-test, with a warning when the drive has
 *  stopped returning its log: the card's popover and Health › Analysis. */
export function SelfTestCoverageRows({ coverage }: { coverage: SelfTestCoverage }) {
  const { latest, hours_reset, log_missing, log_seen_at } = coverage
  return (
    <>
      {log_missing && log_seen_at && (
        <div className="stl-pop-warn">
          The drive hasn't returned its self-test log since {formatTimestamp(log_seen_at)}. Last known results shown.
        </div>
      )}
      {KINDS.map(({ key, label }) => <TestRow key={key} label={label} entry={latest[key]} logMissing={log_missing} />)}
      <div className="stl-pop-note">
        Ages in power-on hours.
        {hours_reset && " The drive's power-on hours were reset, so older tests' ages are unknown."}
      </div>
    </>
  )
}

function TestRow({ label, entry, logMissing }: { label: string; entry: LatestEntry; logMissing: boolean }) {
  return (
    <div className="stl-row">
      <Light state={lightState(entry, logMissing)} />
      <span className="stl-kind">{label}</span>
      <span className={`stl-result${entry?.drive_report === "failed" ? " failed" : ""}`}>
        {entry ? entry.result : "none recorded"}
      </span>
      <span className="stl-age">{entry && ageText(entry)}</span>
      {entry && !entry.in_drive_log && !logMissing && <span className="stl-kept">no longer in the drive's log</span>}
    </div>
  )
}

function ageText(entry: SelfTestEntry): string {
  return entry.age_hours === null ? "age unknown" : `${entry.age_hours.toLocaleString()} h ago`
}
