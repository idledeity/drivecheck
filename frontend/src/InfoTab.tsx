import type { Drive } from "./types"
import AsOf from "./AsOf"
import { DriveChipHeader } from "./DriveChip"
import { formatInfoValue, unionLayout, useDriveInfo } from "./driveInfo"
import type { DriveInfo, DriveInfoRow } from "./driveInfo"
import "./InfoTab.css"

/* Workspace → Info: what the selected drives are and how they're connected —
   identity, media, interface, controller. Not health. One drive: grouped
   boxes. Several: one table, a column per drive, for comparing. */
export default function InfoTab({ drives, selectedGuids }: { drives: Drive[]; selectedGuids: string[] }) {
  const loaded = useDriveInfo(selectedGuids)

  if (selectedGuids.length === 0) {
    return <p className="info-empty">Select one or more drives to see their details.</p>
  }
  if (loaded.state === "loading") return <p className="info-empty">Loading drive details…</p>
  if (loaded.state === "error") return <p className="info-empty">Couldn't load drive details.</p>

  const shown = selectedGuids
    .map(guid => ({ guid, drive: drives.find(d => d.guid === guid), info: loaded.data[guid] }))
    .filter((d): d is { guid: string; drive: Drive | undefined; info: DriveInfo } => !!d.info)
  if (shown.length === 0) return <p className="info-empty">Loading drive details…</p>

  if (shown.length === 1) {
    return (
      <div className="info-tab">
        <DriveChipHeader drive={shown[0].drive} className="info-drive-header" />
        <DriveInfoGroups info={shown[0].info} />
      </div>
    )
  }
  return <DriveInfoTable shown={shown} />
}

/** One drive's groups as boxes; also the Report's drive section. */
export function DriveInfoGroups({ info, compact }: { info: DriveInfo; compact?: boolean }) {
  return (
    <div className={`info-groups${compact ? " info-groups-compact" : ""}`}>
      {info.groups.map(group => (
        <section key={group.id} className="info-group">
          <h3 className="info-group-title">
            {group.title}
            {group.as_of && <AsOf at={group.as_of} className="info-asof" />}
          </h3>
          {group.rows.map(row => (
            <div key={row.key} className="info-row">
              <span className="info-row-label">{row.label}</span>
              <InfoValue row={row} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function InfoValue({ row }: { row: DriveInfoRow }) {
  return (
    <span className="info-row-value">
      {formatInfoValue(row)}
      {row.as_of && <AsOf at={row.as_of} className="info-asof info-row-asof" />}
    </span>
  )
}

function DriveInfoTable({ shown }: { shown: { guid: string; drive: Drive | undefined; info: DriveInfo }[] }) {
  const layout = unionLayout(shown.map(s => s.info))
  return (
    <div className="info-table-wrap">
      <table className="info-table">
        <thead>
          <tr>
            <th className="info-table-corner" />
            {shown.map(s => (
              <th key={s.guid} scope="col"><DriveChipHeader drive={s.drive} /></th>
            ))}
          </tr>
        </thead>
        {layout.map(group => (
          <tbody key={group.id}>
            <tr className="info-table-group">
              <th scope="rowgroup">{group.title}</th>
              {shown.map(s => {
                const at = s.info.groups.find(g => g.id === group.id)?.as_of
                return <td key={s.guid}>{at && <AsOf at={at} className="info-asof" />}</td>
              })}
            </tr>
            {group.rows.map(({ key, label }) => (
              <tr key={key}>
                <th scope="row" className="info-row-label">{label}</th>
                {shown.map(s => {
                  const row = s.info.groups.find(g => g.id === group.id)?.rows.find(r => r.key === key)
                  return <td key={s.guid}>{row ? <InfoValue row={row} /> : <span className="info-missing">—</span>}</td>
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}
