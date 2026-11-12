import { useEffect, useState } from "react"
import { IconInfoCircle, IconPlayerPlay } from "@tabler/icons-react"
import type { Drive, OperationInfo, ParamSpec } from "./types"
import { StubTab } from "./WorkspacePanel"
import DestructiveConfirmDialog from "./DestructiveConfirmDialog"
import HoverReveal from "./HoverReveal"
import "./RunTaskTab.css"
import DriveChip from "./DriveChip"

const CATEGORY_ORDER = ["Test", "Scan", "Maintenance", "Debug"]

interface Props {
  drives: Drive[]
  selected: string[]
  onRun: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<unknown>
}

export default function RunTaskTab({ drives, selected, onRun }: Props) {
  const [operations, setOperations] = useState<OperationInfo[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({})
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (selected.length === 0) return
    const guids = selected.join(",")
    fetch(`/api/operations?guids=${encodeURIComponent(guids)}`)
      .then(r => r.json())
      .then((ops: OperationInfo[]) => {
        setOperations(ops)
        setActiveKey(prev => (prev && ops.some(o => o.key === prev)) ? prev : (ops[0]?.key ?? null))
      })
      .catch(() => setOperations([]))
  }, [selected])

  const activeOp = operations.find(o => o.key === activeKey) ?? null

  // Reset param values to defaults when the selected operation changes.
  // Adjusted during render (React's recommended pattern for derived state)
  // rather than in an effect, since this needs to happen before paint.
  const [paramsForKey, setParamsForKey] = useState<string | null>(null)
  if ((activeOp?.key ?? null) !== paramsForKey) {
    setParamsForKey(activeOp?.key ?? null)
    setParamValues(activeOp ? Object.fromEntries(activeOp.params.map(p => [p.name, p.default])) : {})
  }

  if (selected.length === 0) {
    return <StubTab label="Run Task" note="Select one or more drives to configure and launch operations." />
  }

  if (operations.length === 0) {
    return <StubTab label="Run Task" note="No operations available for the selected drives." />
  }

  const categories = Array.from(new Set(operations.map(o => o.category)))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a)
      const bi = CATEGORY_ORDER.indexOf(b)
      return (ai === -1 ? CATEGORY_ORDER.length : ai) - (bi === -1 ? CATEGORY_ORDER.length : bi)
    })


  const targets = selected
    .map(guid => drives.find(d => d.guid === guid))
    .filter((d): d is Drive => d !== undefined)

  const lockedSelected = activeOp?.destructive
    ? selected.filter(guid => drives.find(d => d.guid === guid)?.locked)
    : []
  const blockedByLock = lockedSelected.length > 0

  const dispatch = () => {
    if (!activeOp || blockedByLock) return
    setConfirming(false)
    setRunning(true)
    onRun(selected, activeOp.key, paramValues).finally(() => setRunning(false))
  }

  // Destructive operations never dispatch straight from the Run button.
  const handleRun = () => {
    if (!activeOp || blockedByLock) return
    if (activeOp.destructive) setConfirming(true)
    else dispatch()
  }


  return (
    <div className="run-task-tab">
      <nav className="rt-sidebar">
        {categories.map(cat => (
          <div key={cat} className="rt-category">
            <div className="rt-category-label">{cat}</div>
            {operations.filter(o => o.category === cat).map(op => (
              <button
                key={op.key}
                className={`rt-op${op.key === activeKey ? " active" : ""}`}
                onClick={() => setActiveKey(op.key)}
              >
                {op.name}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="rt-form">
        {activeOp && (
          <>
            <h3 className="rt-form-title">{activeOp.name}</h3>
            <div className="rt-form-targets">
              <span className="rt-form-targets-label">Runs on</span>
              <div className="drive-chip-list" aria-label="Target drives">
                {targets.map(d => (
                  <DriveChip key={d.guid} drive={d} blocked={blockedByLock && d.locked} />
                ))}
              </div>
            </div>
            {activeOp.params.map(spec => (
              <ParamInput
                key={spec.name}
                spec={spec}
                value={paramValues[spec.name]}
                onChange={value => setParamValues(prev => ({ ...prev, [spec.name]: value }))}
              />
            ))}
            {blockedByLock && (
              <div className="rt-lock-warning">
                {lockedSelected.length === 1 ? "1 drive is" : `${lockedSelected.length} drives are`} locked — unlock before running a destructive operation.
              </div>
            )}
            <button className="rt-run" onClick={handleRun} disabled={running || blockedByLock}>
              <IconPlayerPlay size={14} />
              Run
            </button>
            {confirming && activeOp.destructive && (
              <DestructiveConfirmDialog
                operation={activeOp}
                targets={targets}
                onConfirm={dispatch}
                onCancel={() => setConfirming(false)}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: unknown; onChange: (value: unknown) => void }) {
  if (spec.type === "boolean") {
    return (
      <label className="rt-param rt-param-bool">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={e => onChange(e.target.checked)}
        />
        {spec.label}
        <ParamTooltip spec={spec} />
      </label>
    )
  }

  if (spec.type === "number") {
    return (
      <label className="rt-param">
        <span className="rt-param-label">{spec.label}<ParamTooltip spec={spec} /></span>
        <input
          type="number"
          value={value as number}
          min={spec.min ?? undefined}
          max={spec.max ?? undefined}
          onChange={e => onChange(Number(e.target.value))}
        />
      </label>
    )
  }

  return (
    <label className="rt-param">
      <span className="rt-param-label">{spec.label}<ParamTooltip spec={spec} /></span>
      <input
        type="text"
        value={value as string}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}

function ParamTooltip({ spec }: { spec: ParamSpec }) {
  if (!spec.tooltip) return null
  return (
    <HoverReveal text={spec.tooltip}>
      <IconInfoCircle size={12} className="cfg-tooltip-icon" aria-label={`About ${spec.label}`} />
    </HoverReveal>
  )
}
