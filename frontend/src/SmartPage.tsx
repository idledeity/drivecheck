import { useState, type ReactNode } from "react"
import type { Drive, SmartAttribute, SmartAttributeRow, SmartDetail, SmartDetailResponse, SmartField, SmartLeaf, SmartTable } from "./types"
import { DriveChipHeader } from "./DriveChip"
import { formatFieldValue, hasNewerRead, hasSmartData, useSmartDetail } from "./smartDetail"
import { formatClock } from "./format"
import AsOf from "./AsOf"
import "./SmartPage.css"

/*
 * Health -> SMART: everything smartctl reported for each selected drive, and
 * nothing from elsewhere (no vitals, no other probes). Values come from the
 * drive's latest stored full read (/api/drives/<guid>/smart/detail), as one
 * point in time. The page holds still while it's read: a newer full read
 * shows "New values from HH:MM · Refresh" by its date instead.
 */
export default function SmartPanel({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  if (selectedGuids.length === 0) {
    return <p className="health-empty">Select one or more drives to view their SMART data.</p>
  }
  return (
    <div className="smart-page">
      {selectedGuids.map(guid => {
        const drive = drives.find(d => d.guid === guid)
        return (
          <section key={guid} className="smart-drive-section">
            <DriveChipHeader drive={drive} className="smart-drive-header" />
            <DriveSmart key={guid} guid={guid} drive={drive} />
          </section>
        )
      })}
    </div>
  )
}

function DriveSmart({ guid, drive }: { guid: string; drive?: Drive }) {
  const loaded = useSmartDetail(guid)
  if (loaded.state === "loading") return <p className="smart-empty">Loading SMART data…</p>
  if (loaded.state === "none" || !loaded.data.detail || !hasSmartData(loaded.data.detail)) {
    return <p className="smart-empty">No SMART data for this drive.</p>
  }
  const detail = loaded.data.detail
  const { self_test_log } = loaded.data

  return (
    <>
      <SmartReadLine data={loaded.data} drive={drive} onRefresh={loaded.reload} />

      <div className="smart-groups">
        {detail.groups.map(group => (
          <div key={group.key} className="smart-group">
            <h3 className="smart-group-title">{group.label}</h3>
            {group.fields.map(field => (
              <FieldRow key={field.key} field={field} attribute={attributeFor(detail, field)} />
            ))}
          </div>
        ))}
      </div>

      {detail.attributes && detail.attributes.length > 0 && (
        <>
          <h3 className="smart-section-title">All SMART attributes ({detail.attributes.length})</h3>
          <AttributeTable attributes={detail.attributes} />
        </>
      )}

      {detail.scsi_error_counters && detail.scsi_error_counters.rows.length > 0 && (
        <>
          <h3 className="smart-section-title">Error counter log</h3>
          <ScsiCounterTable counters={detail.scsi_error_counters} />
        </>
      )}

      {detail.nvme_health_log && detail.nvme_health_log.length > 0 && (
        <>
          <h3 className="smart-section-title">SMART / Health Information log</h3>
          <LeafList leaves={detail.nvme_health_log} />
        </>
      )}

      {self_test_log.length > 0 && (
        <>
          {/* The drive's own onboard log; may predate any test DriveCheck has run. */}
          <h3 className="smart-section-title">Self-test history (drive log)</h3>
          <AttrList rows={self_test_log} />
        </>
      )}

      {detail.other_fields.length > 0 && (
        <details className="smart-other">
          <summary className="smart-section-title">Everything else smartctl reported ({detail.other_fields.length})</summary>
          <LeafList leaves={detail.other_fields} />
        </details>
      )}

      {/* Appendix: the extended logs (-x), after everything the page summarises above. */}
      {detail.tables.filter(t => t.rows.length > 0).map(table => (
        // A long table (e.g. 100+ background scan results) starts closed.
        table.rows.length > LONG_TABLE_ROWS ? (
          <LazyDetails key={table.key} title={`${table.title} (${table.rows.length})`}>
            <GenericTable table={table} />
          </LazyDetails>
        ) : (
          <div key={table.key}>
            <h3 className="smart-section-title">{table.title} ({table.rows.length})</h3>
            <GenericTable table={table} />
          </div>
        )
      ))}

      {detail.raw_sections.map(section => (
        <LazyDetails key={section.key} title={`${section.label} (${section.leaves.length})`}>
          <LeafList leaves={section.leaves} />
        </LazyDetails>
      ))}
    </>
  )
}

/** When the full read shown was taken, and a way to a newer one once the drive is read again. */
export function SmartReadLine({ data, drive, onRefresh }: {
  data: SmartDetailResponse; drive?: Drive; onRefresh: () => void
}) {
  const newer = drive?.last_full_read_at
  return (
    <p className="smart-asof">
      Full SMART read <AsOf at={data.captured_at} staleAfterS={drive?.stale_after_s.smart} />
      {newer && hasNewerRead(data, newer) && (
        <span className="smart-newer">
          New values from {formatClock(newer)} · <button className="smart-refresh-btn" onClick={onRefresh}>Refresh</button>
        </span>
      )}
    </p>
  )
}

function attributeFor(detail: SmartDetail, field: SmartField): SmartAttribute | undefined {
  return field.attribute_id === null ? undefined : detail.attributes?.find(a => a.id === field.attribute_id)
}

// ── named fields ─────────────────────────────────────────────────────────────

function FieldRow({ field, attribute }: { field: SmartField; attribute?: SmartAttribute }) {
  const extra = [field.detail, hoursInYears(field)].filter(Boolean).join(" · ")
  return (
    <div className="smart-field">
      <div className="smart-field-main">
        <span className="smart-field-label">{field.label}</span>
        <span className={`smart-field-value smart-${field.status}`}>
          {formatFieldValue(field)}
          {field.limit && <span className="smart-field-limit"> {formatLimit(field)}</span>}
        </span>
      </div>
      {(attribute || field.source || extra) && (
        <div className="smart-field-meta">
          {field.source && <span className="smart-source">{field.source}</span>}
          {attribute && (
            <span>value {attribute.value ?? "—"} · worst {attribute.worst ?? "—"} · thresh {attribute.thresh ?? "—"}</span>
          )}
          {extra && <span>{extra}</span>}
        </div>
      )}
    </div>
  )
}

function formatLimit(field: SmartField): string {
  const limit = field.limit!
  const shown = formatFieldValue({ value: limit.value, unit: field.unit })
  if (limit.kind === "rated") return `/ ${shown} rated`
  if (limit.kind === "trip") return `· trip ${shown}`
  return `· threshold ${shown}`
}

function hoursInYears(field: SmartField): string | null {
  if (field.unit !== "hours" || typeof field.value !== "number" || field.value < 24 * 30) return null
  return `${(field.value / (24 * 365)).toFixed(1)} years`
}

// ── tables ───────────────────────────────────────────────────────────────────

const ATTRIBUTE_COLUMNS: { label: string; cell: (a: SmartAttribute) => string | number | null; className?: string }[] = [
  { label: "ID",          cell: a => a.id, className: "num" },
  { label: "Attribute",   cell: a => a.name.replace(/_/g, " "), className: "name" },
  { label: "Value",       cell: a => a.value, className: "num" },
  { label: "Worst",       cell: a => a.worst, className: "num" },
  { label: "Thresh",      cell: a => a.thresh, className: "num" },
  { label: "Margin",      cell: a => a.margin, className: "num" },
  { label: "Type",        cell: a => a.type },
  { label: "Updated",     cell: a => a.updated },
  { label: "Flags",       cell: a => a.flags, className: "mono" },
  { label: "Raw",         cell: a => a.raw_string ?? a.raw_value, className: "raw" },
  { label: "When failed", cell: a => a.when_failed },
]

/* A table on wide screens; each row stacks into a labelled card on a phone
   (SmartPage.css), so nothing scrolls sideways. */
function AttributeTable({ attributes }: { attributes: SmartAttribute[] }) {
  return (
    <table className="smart-table smart-attr-table">
      <thead>
        <tr>{ATTRIBUTE_COLUMNS.map(c => <th key={c.label} className={c.className}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {attributes.map(a => (
          <tr key={a.id} className={`smart-row-${a.status}`}>
            {ATTRIBUTE_COLUMNS.map(c => (
              <td key={c.label} data-label={c.label} className={c.className}>{c.cell(a) ?? "—"}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const LONG_TABLE_ROWS = 40

/* A further log as a table; like the attribute table, each row stacks into a
   labelled card on a phone, text columns full width. */
function GenericTable({ table }: { table: SmartTable }) {
  return (
    <table className="smart-table smart-generic-table">
      <thead>
        <tr>{table.columns.map(c => <th key={c.key} className={c.numeric ? "num" : undefined}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={i} className={`smart-row-${row.status}`}>
            {table.columns.map(c => (
              <td key={c.key} data-label={c.label} className={c.numeric ? "num" : "text"}>
                {formatCounter(row.cells[c.key] ?? null)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* A closed disclosure whose content is only rendered once opened (some hold hundreds of values). */
function LazyDetails({ title, children }: { title: string; children: ReactNode }) {
  const [opened, setOpened] = useState(false)
  return (
    <details className="smart-other" onToggle={e => { if ((e.target as HTMLDetailsElement).open) setOpened(true) }}>
      <summary className="smart-section-title">{title}</summary>
      {opened && children}
    </details>
  )
}

function ScsiCounterTable({ counters }: { counters: NonNullable<SmartDetail["scsi_error_counters"]> }) {
  return (
    <table className="smart-table smart-counter-table">
      <thead>
        <tr>
          <th />
          {counters.columns.map(c => <th key={c.key} className="num">{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {counters.rows.map(row => (
          <tr key={row.direction}>
            <th scope="row" className="name">{row.direction[0].toUpperCase() + row.direction.slice(1)}</th>
            {counters.columns.map(c => (
              // Corrected errors are routine; only uncorrected ones are a problem.
              <td key={c.key} data-label={c.label}
                  className={c.key === "total_uncorrected_errors" && Number(row[c.key]) > 0 ? "num smart-crit" : "num"}>
                {formatCounter(row[c.key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function formatCounter(value: number | string | null): string {
  return typeof value === "number" ? value.toLocaleString() : value ?? "—"
}

function LeafList({ leaves }: { leaves: SmartLeaf[] }) {
  return (
    <dl className="smart-leaves">
      {leaves.map(leaf => (
        <div key={leaf.path} className="smart-leaf">
          <dt>{leaf.path}</dt>
          <dd>{leaf.value === null ? "null" : String(leaf.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The drive's self-test log entries. */
function AttrList({ rows }: { rows: SmartAttributeRow[] }) {
  return (
    <div className="attr-list">
      {rows.map(row => (
        <div key={row.key} className="attr-row">
          <div className="attr-main">
            <span className="attr-label">{row.label}</span>
            <span className={`attr-value attr-${row.status}`}>{row.value}</span>
          </div>
          {row.detail && <div className="attr-detail">{row.detail}</div>}
        </div>
      ))}
    </div>
  )
}

// ── Report summary ───────────────────────────────────────────────────────────

/** For the Report: only what isn't ok, with a way to the full SMART page. */
export function SmartSummary({ data, onOpenSmart }: { data: SmartDetailResponse; onOpenSmart: () => void }) {
  if (!data.detail || !hasSmartData(data.detail)) {
    return <p className="smart-empty">No SMART data for this drive.</p>
  }
  const detail = data.detail

  const fields = detail.groups.flatMap(g => g.fields).filter(f => f.status !== "ok")
  const shownIds = new Set(fields.map(f => f.attribute_id))
  // Attributes not already behind a listed field (e.g. a vendor-specific one).
  const attributes = (detail.attributes ?? []).filter(a => a.status !== "ok" && !shownIds.has(a.id))
  // Further logs with flagged rows, unless a field above already counts them.
  const shownKeys = new Set(fields.map(f => f.key))
  const tables = detail.tables
    .map(t => ({ table: t, flagged: t.rows.filter(r => r.status !== "ok") }))
    .filter(({ table, flagged }) => flagged.length > 0 && !(table.summarized_by && shownKeys.has(table.summarized_by)))

  return (
    <div className="smart-summary">
      {fields.length === 0 && attributes.length === 0 && tables.length === 0 ? (
        <p className="smart-summary-ok">Every SMART value is within limits.</p>
      ) : (
        <div className="smart-group">
          {fields.map(f => <FieldRow key={f.key} field={f} attribute={attributeFor(detail, f)} />)}
          {attributes.map(a => (
            <div key={a.id} className="smart-field">
              <div className="smart-field-main">
                <span className="smart-field-label">{a.name.replace(/_/g, " ")}</span>
                <span className={`smart-field-value smart-${a.status}`}>{a.raw_string ?? a.raw_value ?? "—"}</span>
              </div>
              <div className="smart-field-meta">
                <span className="smart-source">ATA {a.id}</span>
                <span>value {a.value ?? "—"} · worst {a.worst ?? "—"} · thresh {a.thresh ?? "—"}</span>
              </div>
            </div>
          ))}
          {tables.map(({ table, flagged }) => (
            <div key={table.key} className="smart-field">
              <div className="smart-field-main">
                <span className="smart-field-label">{table.title}</span>
                <span className={`smart-field-value smart-${flagged.some(r => r.status === "crit") ? "crit" : "warn"}`}>
                  {flagged.length.toLocaleString()} flagged
                </span>
              </div>
              <div className="smart-field-meta">
                <span className="smart-source">{table.key}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button className="smart-open-btn" onClick={onOpenSmart}>All SMART data →</button>
    </div>
  )
}
