import { useEffect, useState } from "react"
import { IconPlayerPlay } from "@tabler/icons-react"
import type { Drive, OperationInfo, ParamSpec } from "./types"
import { StubTab } from "./WorkspacePanel"
import "./RunTaskTab.css"

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

  const driveNames = selected
    .map(guid => drives.find(d => d.guid === guid))
    .map(d => d ? (d.label ?? d.model ?? d.device) : null)
    .filter((s): s is string => s !== null)

  const handleRun = () => {
    if (!activeOp) return
    setRunning(true)
    onRun(selected, activeOp.key, paramValues).finally(() => setRunning(false))
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
              Target: {driveNames.length === 1 ? driveNames[0] : `${driveNames.length} drives`}
            </div>
            {activeOp.params.map(spec => (
              <ParamInput
                key={spec.name}
                spec={spec}
                value={paramValues[spec.name]}
                onChange={value => setParamValues(prev => ({ ...prev, [spec.name]: value }))}
              />
            ))}
            <button className="rt-run" onClick={handleRun} disabled={running}>
              <IconPlayerPlay size={14} />
              Run
            </button>
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
      </label>
    )
  }

  if (spec.type === "number") {
    return (
      <label className="rt-param">
        <span className="rt-param-label">{spec.label}</span>
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
      <span className="rt-param-label">{spec.label}</span>
      <input
        type="text"
        value={value as string}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  )
}
