import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { IconX, IconRefresh, IconInfoCircle, IconAdjustments, IconFileText } from "@tabler/icons-react"
import type { ConfigProp, LogRecord } from "./types"
import "./SettingsOverlay.css"

type SettingsTab = "config" | "logs" | "about"

const TABS: { id: SettingsTab; label: string; icon: typeof IconAdjustments; iconClass: string }[] = [
  { id: "config", label: "Config", icon: IconAdjustments, iconClass: "so-nav-icon-config" },
  { id: "logs",   label: "Logs",   icon: IconFileText,    iconClass: "so-nav-icon-logs"   },
  { id: "about",  label: "About",  icon: IconInfoCircle,  iconClass: "so-nav-icon-about"  },
]

interface Props {
  onClose: () => void
}

export default function SettingsOverlay({ onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>("config")

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <div className="so-scrim" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="so-panel">
        <div className="so-titlebar">
          <span className="so-title">Settings</span>
          <button className="so-close" onClick={onClose}><IconX size={14} /></button>
        </div>
        <div className="so-body">
          <nav className="so-nav">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`so-nav-btn${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={14} className={t.iconClass} />
                {t.label}
              </button>
            ))}
          </nav>
          <div className="so-content">
            {tab === "config" && <ConfigTab />}
            {tab === "logs"   && <LogsTab />}
            {tab === "about"  && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Config tab
// ---------------------------------------------------------------------------

function ConfigTab() {
  const [configProps, setConfigProps] = useState<ConfigProp[]>([])
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [restartKeys, setRestartKeys] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/config").then(r => r.json()).then(setConfigProps).catch(() => {})
  }, [])

  const sections = [...new Set(configProps.map(p => p.section))]
  const pendingCount = Object.keys(pending).length

  const getValue = (prop: ConfigProp): unknown =>
    prop.key in pending ? pending[prop.key] : prop.value

  const handleChange = (prop: ConfigProp, value: unknown) => {
    setSaveError(null)
    setPending(prev => {
      if (value === prop.value) {
        const next = { ...prev }
        delete next[prop.key]
        return next
      }
      return { ...prev, [prop.key]: value }
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      })
      const data = await res.json() as { restart_required?: string[]; error?: string }
      if (!res.ok) {
        setSaveError(data.error ?? "Save failed")
        return
      }
      setRestartKeys(data.restart_required ?? [])
      setConfigProps(prev => prev.map(p => p.key in pending ? { ...p, value: pending[p.key] } : p))
      setPending({})
    } catch {
      setSaveError("Network error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cfg-tab">
      {restartKeys.length > 0 && (
        <div className="cfg-banner cfg-banner-warn">
          Restart required to apply: {restartKeys.join(", ")}
        </div>
      )}
      {saveError && (
        <div className="cfg-banner cfg-banner-error">{saveError}</div>
      )}
      <div className="cfg-sections">
        {sections.map(section => (
          <div key={section} className="cfg-section">
            <h3 className="cfg-section-title">{section}</h3>
            {configProps.filter(p => p.section === section).map(prop => (
              <PropRow
                key={prop.key}
                prop={prop}
                value={getValue(prop)}
                dirty={prop.key in pending}
                onChange={v => handleChange(prop, v)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="cfg-footer">
        <button
          className="cfg-save-btn"
          onClick={handleSave}
          disabled={pendingCount === 0 || saving}
        >
          {saving
            ? "Saving…"
            : pendingCount > 0
              ? `Save (${pendingCount} change${pendingCount > 1 ? "s" : ""})`
              : "No Changes"}
        </button>
        {pendingCount > 0 && (
          <button className="cfg-discard-btn" onClick={() => setPending({})}>Discard</button>
        )}
      </div>
    </div>
  )
}

function InfoTooltip({ text }: { text: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; placement: "above" | "below" } | null>(null)

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const margin = 12
    const halfWidth = 120
    const above = rect.top > 80
    setPos({
      top: above ? rect.top - 8 : rect.bottom + 8,
      left: Math.min(Math.max(rect.left + rect.width / 2, halfWidth + margin), window.innerWidth - halfWidth - margin),
      placement: above ? "above" : "below",
    })
  }

  return (
    <span className="cfg-tooltip-anchor" ref={anchorRef} onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      <IconInfoCircle size={12} className="cfg-tooltip-icon" />
      {pos && createPortal(
        <span
          className={`cfg-tooltip-bubble cfg-tooltip-bubble-${pos.placement}`}
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}

interface PropRowProps {
  prop: ConfigProp
  value: unknown
  dirty: boolean
  onChange: (value: unknown) => void
}

function PropRow({ prop, value, dirty, onChange }: PropRowProps) {
  return (
    <div className={`cfg-prop-row${dirty ? " dirty" : ""}`}>
      <div className="cfg-prop-meta">
        <label className="cfg-prop-label">
          {prop.label}
          <span className="cfg-prop-key">({prop.key})</span>
          {prop.restart_required && <span className="cfg-restart-badge">restart</span>}
          {prop.tooltip && <InfoTooltip text={prop.tooltip} />}
        </label>
        <span className="cfg-prop-description">{prop.description}</span>
      </div>
      <div className="cfg-prop-control">
        {prop.type === "enum" && (
          <select className="cfg-ctl-enum" value={String(value)} onChange={e => onChange(e.target.value)}>
            {prop.choices!.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {(prop.type === "int" || prop.type === "float") && (
          <input
            className="cfg-ctl-num"
            type="number"
            step={prop.type === "int" ? 1 : "any"}
            min={prop.min ?? undefined}
            max={prop.max ?? undefined}
            value={String(value)}
            onChange={e => {
              const n = prop.type === "int" ? parseInt(e.target.value) : parseFloat(e.target.value)
              if (!isNaN(n)) onChange(n)
            }}
          />
        )}
        {prop.type === "bool" && (
          <input
            className="cfg-ctl-bool"
            type="checkbox"
            checked={Boolean(value)}
            onChange={e => onChange(e.target.checked)}
          />
        )}
        {prop.type === "str" && (
          <input
            className="cfg-ctl-str"
            type="text"
            value={String(value ?? "")}
            onChange={e => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

function LogsTab() {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    fetch("/api/logs?n=500")
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setRecords(data as LogRecord[])
        } else {
          setError((data as { error?: string }).error ?? "Failed to load logs")
        }
      })
      .catch(() => setError("Network error"))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" })
  }, [records])

  const levelCls = (level: string) => {
    switch (level) {
      case "debug": return "ll-debug"
      case "info":  return "ll-info"
      case "warn":
      case "warning": return "ll-warn"
      case "error":
      case "critical": return "ll-error"
      default: return ""
    }
  }

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        <button className="so-toolbar-btn" onClick={load} disabled={loading} title="Refresh logs">
          <IconRefresh size={13} className={loading ? "spinning" : ""} />
          <span>Refresh</span>
        </button>
        {records.length > 0 && <span className="logs-count">{records.length} entries</span>}
      </div>
      {error ? (
        <div className="logs-error">{error}</div>
      ) : (
        <div className="logs-body">
          {records.map((rec, i) => (
            <div key={i} className="log-row">
              <span className="log-ts">{rec.timestamp}</span>
              <span className={`log-level ${levelCls(rec.level)}`}>{rec.level.toUpperCase()}</span>
              <span className="log-logger">{rec.logger}</span>
              <span className="log-msg">{rec.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// About tab
// ---------------------------------------------------------------------------

function AboutTab() {
  return (
    <div className="about-tab">
      <div className="about-row">
        <span className="about-label">Application</span>
        <span className="about-value">drivecheck</span>
      </div>
      <div className="about-row">
        <span className="about-label">Version</span>
        <span className="about-value about-mono">dev</span>
      </div>
    </div>
  )
}
