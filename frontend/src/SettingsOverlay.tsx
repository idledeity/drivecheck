import { useState, useEffect, useRef, useCallback } from "react"
import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { IconX, IconRefresh, IconPower, IconRotate2, IconInfoCircle, IconAdjustments, IconFileText, IconListNumbers, IconTextWrap, IconFilter, IconChevronUp, IconChevronDown, IconAlertTriangle, IconSettings } from "@tabler/icons-react"
import type { ConfigProp, LogRecord, ProbeWarning } from "./types"
import CollapseToggle from "./CollapseToggle"
import ManageProbesDialog from "./ManageProbesDialog"
import "./SettingsOverlay.css"

type SettingsTab = "config" | "logs" | "about"

function configValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => v === b[i])
  return a === b
}

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
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [configDirty, setConfigDirty] = useState(false)
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)

  // Routes every close trigger (X button, Escape, scrim click) through one
  // place — if Config has unsaved edits, ask first instead of letting any
  // of them silently discard the pending changes ConfigTab is now keeping
  // alive across tab switches.
  const requestClose = useCallback(() => {
    if (configDirty) setCloseConfirmOpen(true)
    else onClose()
  }, [configDirty, onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [requestClose])

  return (
    <div className="so-scrim" onClick={e => e.target === e.currentTarget && requestClose()}>
      <div className="so-panel">
        <div className="so-titlebar">
          <span className="so-title">Settings</span>
          <button className="icon-btn so-close" onClick={requestClose}><IconX size={14} /></button>
        </div>
        <div className="so-body">
          <nav className={`so-nav${navCollapsed ? " collapsed" : ""}`}>
            {TABS.map(t => (
              <button
                key={t.id}
                className={`so-nav-btn${tab === t.id ? " active" : ""}`}
                onClick={() => setTab(t.id)}
                title={navCollapsed ? t.label : undefined}
              >
                <t.icon size={14} className={t.iconClass} />
                {!navCollapsed && <span>{t.label}</span>}
              </button>
            ))}
            <CollapseToggle
              collapsed={navCollapsed}
              onToggle={() => setNavCollapsed(c => !c)}
              orientation="horizontal"
              expandLabel="Expand categories"
              collapseLabel="Collapse categories"
              className="so-nav-collapse-btn"
            />
          </nav>
          <div className="so-content">
            {/* Always mounted, just hidden — unlike Logs/About, Config has
                in-progress edits (`pending`) that switching tabs shouldn't
                silently discard the way unmounting it would. */}
            <div className={`so-tab-panel${tab === "config" ? "" : " so-tab-hidden"}`}>
              <ConfigTab onDirtyChange={setConfigDirty} />
            </div>
            {tab === "logs"   && <LogsTab />}
            {tab === "about"  && <AboutTab />}
          </div>
        </div>
      </div>
      {closeConfirmOpen && (
        <ConfirmModal
          message="Discard unsaved config changes?"
          detail="Closing Settings now will discard any edits that haven't been saved."
          confirmLabel="Discard & Close"
          onConfirm={() => { setCloseConfirmOpen(false); onClose() }}
          onCancel={() => setCloseConfirmOpen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Config tab
// ---------------------------------------------------------------------------

interface ConfigTabProps {
  onDirtyChange: (dirty: boolean) => void
}

function ConfigTab({ onDirtyChange }: ConfigTabProps) {
  const [configProps, setConfigProps] = useState<ConfigProp[]>([])
  const [pending, setPending] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [restartKeys, setRestartKeys] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const [probeWarnings, setProbeWarnings] = useState<Record<string, ProbeWarning[]>>({})

  useEffect(() => {
    fetch("/api/config").then(r => r.json()).then(setConfigProps).catch(() => {})
    // Reflects what loaded at the collector's last restart, not necessarily
    // the current (possibly unsaved or unrestarted) prop values — PropRow
    // filters each row's warnings against its own live value to avoid
    // showing a warning for an entry the user already removed.
    fetch("/api/probes/status").then(r => r.json()).then(setProbeWarnings).catch(() => {})
  }, [])

  // One rescan refreshes every module_list prop's suggested choices at
  // once (it walks all four probe categories), so a single button covers
  // all of them rather than one per row.
  const handleRescanProbes = async () => {
    setRescanning(true)
    try {
      const res = await fetch("/api/probes/rescan", { method: "POST" })
      if (res.ok) setConfigProps(await res.json())
    } catch {
      // Best-effort — the existing choices just stay stale until retried.
    } finally {
      setRescanning(false)
    }
  }

  const sections = [...new Set(configProps.map(p => p.section))]
  const pendingCount = Object.keys(pending).length

  // Lets SettingsOverlay guard its own close paths (X, Escape, scrim click)
  // without owning `pending` itself — ConfigTab stays the source of truth.
  useEffect(() => { onDirtyChange(pendingCount > 0) }, [pendingCount, onDirtyChange])

  // Reverts the "Confirm?" state automatically if the user doesn't follow
  // through with a second click, and also if pending changes are cleared
  // some other way (e.g. a successful save) while it's armed.
  useEffect(() => {
    if (!confirmingDiscard) return
    const id = window.setTimeout(() => setConfirmingDiscard(false), 3000)
    return () => window.clearTimeout(id)
  }, [confirmingDiscard])

  const getValue = (prop: ConfigProp): unknown =>
    prop.key in pending ? pending[prop.key] : prop.value

  const handleChange = (prop: ConfigProp, value: unknown) => {
    setSaveError(null)
    setPending(prev => {
      if (configValuesEqual(value, prop.value)) {
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
      setConfirmingDiscard(false)
    } catch {
      setSaveError("Network error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cfg-tab">
      {restartKeys.length > 0 && (
        <RestartPromptModal keys={restartKeys} onRestarted={() => setRestartKeys([])} onDismiss={() => setRestartKeys([])} />
      )}
      {saveError && (
        <div className="cfg-banner cfg-banner-error">{saveError}</div>
      )}
      <div className="cfg-sections">
        {sections.map(section => (
          <div key={section} className="cfg-section">
            <h3 className="cfg-section-title">
              {section}
              {section === "Collector" && (
                <button
                  className="icon-btn cfg-rescan-btn"
                  onClick={handleRescanProbes}
                  disabled={rescanning}
                  title="Rescan native + custom probe directories for newly added probes"
                >
                  <IconRefresh size={11} className={rescanning ? "spinning" : ""} />
                  Rescan probes
                </button>
              )}
            </h3>
            {configProps.filter(p => p.section === section).map(prop => (
              <PropRow
                key={prop.key}
                prop={prop}
                value={getValue(prop)}
                dirty={prop.key in pending}
                onChange={v => handleChange(prop, v)}
                onChoicesRefresh={setConfigProps}
                warnings={probeWarnings[prop.key] ?? []}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="cfg-footer">
        <button
          className="tinted-btn tint-cy cfg-save-btn"
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
          <button
            className={`tinted-btn tint-re cfg-discard-btn${confirmingDiscard ? " confirming" : ""}`}
            onClick={() => {
              if (confirmingDiscard) {
                setPending({})
                setConfirmingDiscard(false)
              } else {
                setConfirmingDiscard(true)
              }
            }}
          >
            {confirmingDiscard ? "Confirm?" : "Discard"}
          </button>
        )}
      </div>
    </div>
  )
}

// Hover-to-reveal on a real mouse; tap-to-reveal on touch, dismissed by
// tapping anywhere else. Used both for the (i) tooltip icon and for
// revealing a prop's raw config key off its display name.
//
// Pointer events filtered to pointerType "mouse", not plain onMouseEnter/
// onMouseLeave: touch devices synthesize a compatibility mouseenter *and* a
// later mouseleave around a tap (to mimic hover for code that only knows
// about mouse events), which would silently re-close a tooltip a tap had
// just opened. Pointer events carry the real input source, so touch never
// reaches this hover path at all — it relies solely on onClick below.
function HoverReveal({ text, className, mono, children }: { text: string; className?: string; mono?: boolean; children: ReactNode }) {
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
  const hide = () => setPos(null)

  useEffect(() => {
    if (!pos) return
    const onDocClick = (e: MouseEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) hide()
    }
    // Deferred via setTimeout, not attached immediately: React flushes this
    // effect synchronously within the same click that opened the tooltip,
    // before that click's native bubble phase has finished reaching
    // document — an immediately-attached listener would catch its own
    // opening click and close the tooltip right back up.
    const id = window.setTimeout(() => document.addEventListener("click", onDocClick, true), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener("click", onDocClick, true)
    }
  }, [pos])

  return (
    <span
      className={`cfg-tooltip-anchor${className ? ` ${className}` : ""}`}
      ref={anchorRef}
      onPointerEnter={e => { if (e.pointerType === "mouse") show() }}
      onPointerLeave={e => { if (e.pointerType === "mouse") hide() }}
      onClick={e => { e.stopPropagation(); show() }}
    >
      {children}
      {pos && createPortal(
        <span
          className={`cfg-tooltip-bubble cfg-tooltip-bubble-${pos.placement}${mono ? " cfg-tooltip-bubble-mono" : ""}`}
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}

// Shared by RestartButton and RestartPromptModal: POSTs /api/restart, then
// polls /api/config until the backend answers again (or 30s elapses).
function useBackendRestart(onRestarted?: () => void) {
  const [restarting, setRestarting] = useState(false)

  const doRestart = async () => {
    setRestarting(true)
    try {
      await fetch("/api/restart", { method: "POST" })
    } catch {
      // The connection dropping here is expected once the process exits.
    }

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        if ((await fetch("/api/config")).ok) break
      } catch {
        // Still down — keep polling until the deadline.
      }
    }
    setRestarting(false)
    onRestarted?.()
  }

  return { restarting, doRestart }
}

interface RestartButtonProps {
  label: string
  onRestarted?: () => void
}

// Click-triggered confirm popover, not the inline two-step "Confirm?"
// button used for Discard — restarting interrupts the live server for
// every connected client, not just an in-memory edit in this tab, so it
// gets a more deliberate confirm step with explicit warning text.
function RestartButton({ label, onRestarted }: RestartButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { restarting, doRestart } = useBackendRestart(onRestarted)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const openConfirm = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({ top: rect.bottom + 8, left: rect.left })
    setConfirmOpen(true)
  }

  useEffect(() => {
    if (!confirmOpen) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      // The popover is portaled to document.body, so it's not a DOM
      // descendant of btnRef — without also excluding it here, clicking
      // Cancel/Restart inside it would itself count as an "outside" click
      // and close the popover before its own onClick ever fires.
      if (btnRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setConfirmOpen(false)
    }
    const id = window.setTimeout(() => document.addEventListener("click", onDocClick, true), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener("click", onDocClick, true)
    }
  }, [confirmOpen])

  return (
    <>
      <button ref={btnRef} className="tinted-btn tint-re restart-trigger-btn" onClick={openConfirm} disabled={restarting}>
        <IconPower size={13} className={restarting ? "spinning" : ""} />
        {restarting ? "Restarting…" : label}
      </button>
      {confirmOpen && pos && createPortal(
        <div className="restart-confirm-popover" ref={popoverRef} style={{ top: pos.top, left: pos.left }}>
          <p>This restarts the backend service. Connected clients (including this one) will briefly disconnect while it comes back up.</p>
          <div className="restart-confirm-actions">
            <button className="restart-confirm-cancel" onClick={() => setConfirmOpen(false)}>Cancel</button>
            <button className="restart-confirm-yes" onClick={() => { setConfirmOpen(false); doRestart() }}>Restart</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

interface RestartPromptModalProps {
  keys: string[]
  onRestarted: () => void
  onDismiss: () => void
}

// Shown automatically right after a save whose changes need a backend
// restart to take effect — unlike RestartButton's popover (anchored to the
// button that opened it), this has no anchor to position against, so it's
// a centered scrim modal instead.
function RestartPromptModal({ keys, onRestarted, onDismiss }: RestartPromptModalProps) {
  const { restarting, doRestart } = useBackendRestart(onRestarted)
  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && !restarting && onDismiss()}>
      <div className="confirm-card">
        <p>Restart required to apply: {keys.join(", ")}</p>
        <p className="confirm-detail">This restarts the backend service. Connected clients (including this one) will briefly disconnect while it comes back up.</p>
        <div className="restart-confirm-actions">
          <button className="text-link-btn" onClick={onDismiss} disabled={restarting}>Later</button>
          <button className="tinted-btn tint-re restart-trigger-btn" onClick={doRestart} disabled={restarting}>
            <IconPower size={12} className={restarting ? "spinning" : ""} />
            {restarting ? "Restarting…" : "Restart Now"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

interface ConfirmModalProps {
  message: string
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

// Generic Cancel/Confirm scrim modal — same shape as RestartPromptModal
// above, minus the restart-specific loading state, for confirmations that
// resolve instantly (e.g. discarding unsaved changes).
function ConfirmModal({ message, detail, confirmLabel, cancelLabel = "Cancel", onConfirm, onCancel }: ConfirmModalProps) {
  return createPortal(
    <div className="confirm-scrim" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-card">
        <p>{message}</p>
        {detail && <p className="confirm-detail">{detail}</p>}
        <div className="restart-confirm-actions">
          <button className="text-link-btn" onClick={onCancel}>{cancelLabel}</button>
          <button className="tinted-btn tint-re" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

interface PropRowProps {
  prop: ConfigProp
  value: unknown
  dirty: boolean
  onChange: (value: unknown) => void
  onChoicesRefresh: (props: ConfigProp[]) => void
  warnings: ProbeWarning[]
}

function PropRow({ prop, value, dirty, onChange, onChoicesRefresh, warnings }: PropRowProps) {
  // Only entries still present in the row's current value are shown —
  // warnings reflect the last collector restart, so a path the user already
  // removed (or hasn't restarted into yet) shouldn't linger as a warning.
  const liveWarnings = Array.isArray(value) ? warnings.filter(w => value.includes(w.path)) : []
  return (
    <div className={`cfg-prop-row${dirty ? " dirty" : ""}${prop.type === "module_list" ? " cfg-prop-row-tall" : ""}`}>
      <div className="cfg-prop-left">
        <label className="cfg-prop-label">
          <HoverReveal text={prop.key} className="cfg-prop-name" mono>{prop.label}</HoverReveal>
          {prop.restart_required && dirty && <span className="cfg-restart-badge">Requires Restart</span>}
          {prop.tooltip && (
            <HoverReveal text={prop.tooltip}>
              <IconInfoCircle size={12} className="cfg-tooltip-icon" />
            </HoverReveal>
          )}
          {liveWarnings.length > 0 && (
            <HoverReveal text={liveWarnings.map(w => `${w.path}: ${w.reason}`).join("; ")}>
              <IconAlertTriangle size={11} className="cfg-warning-icon" />
            </HoverReveal>
          )}
          {/* Only on a clean row: while dirty, the existing pending value is
              already visible in the control, and reverting that is what the
              footer's Discard button is for — showing this too would raise
              "revert to what?" between the pending edit and the default. */}
          {!dirty && !configValuesEqual(value, prop.default) && (
            <button className="icon-btn cfg-reset-btn" onClick={() => onChange(prop.default)} title="Reset to default">
              <IconRotate2 size={14} />
            </button>
          )}
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
        {prop.type === "list" && (
          <textarea
            className="cfg-ctl-list"
            rows={Math.max(2, (value as string[]).length)}
            value={(value as string[]).join("\n")}
            onChange={e => onChange(e.target.value.split("\n").map(s => s.trim()).filter(Boolean))}
          />
        )}
        {prop.type === "module_list" && (
          <ModuleListControl
            value={value as string[]}
            choices={prop.choices}
            onChange={onChange}
            category={prop.key.replace(/^collector\./, "").replace(/_probes$/, "")}
            onChoicesRefresh={onChoicesRefresh}
          />
        )}
      </div>
    </div>
  )
}

interface ModuleListControlProps {
  value: string[]
  choices: string[] | null
  onChange: (value: string[]) => void
  category: string
  onChoicesRefresh: (props: ConfigProp[]) => void
}

// Full dotted paths (e.g. "drives.collector.probes.vitals.smartctl_vitals")
// are too long for this control to stay usable, especially on mobile — the
// row's own label already says which category this is ("Vitals probes"),
// so that segment is redundant here. Shows just the module name plus a
// native/custom tag; falls back to the full path untagged for anything
// that doesn't match either category-scoped shape (e.g. a hand-typed path
// from a different category, or one with no recognizable convention at
// all) so nothing is ever hidden, just not always shortened.
function shortProbeLabel(path: string, category: string): string {
  const nativePrefix = `drives.collector.probes.${category}.`
  if (path.startsWith(nativePrefix)) return `${path.slice(nativePrefix.length)} (native)`
  const customPrefix = `${category}.`
  if (path.startsWith(customPrefix)) return `${path.slice(customPrefix.length)} (custom)`
  return path
}

// Array editor for module_list props (the probe chains): reorder via
// up/down rather than drag-and-drop (no DnD library in this codebase, and
// these lists are short enough that it's not worth pulling one in), add
// from the discovered `choices` or via the Manage probes dialog, remove
// per item.
function ModuleListControl({ value, choices, onChange, category, onChoicesRefresh }: ModuleListControlProps) {
  const [manageOpen, setManageOpen] = useState(false)

  const availableChoices = (choices ?? []).filter(c => !value.includes(c))

  const addItem = (path: string) => {
    const trimmed = path.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
  }

  const removeItem = (index: number) => onChange(value.filter((_, i) => i !== index))

  const moveItem = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="cfg-ctl-module-list">
      <ul className="ml-items">
        {value.map((path, i) => (
          <li key={path} className="ml-item">
            <HoverReveal text={path} className="ml-item-path" mono>{shortProbeLabel(path, category)}</HoverReveal>
            <div className="ml-item-actions">
              <button className="icon-btn ml-move-btn" disabled={i === 0} onClick={() => moveItem(i, -1)} title="Move up">
                <IconChevronUp size={12} />
              </button>
              <button className="icon-btn ml-move-btn" disabled={i === value.length - 1} onClick={() => moveItem(i, 1)} title="Move down">
                <IconChevronDown size={12} />
              </button>
              <button className="icon-btn ml-remove-btn" onClick={() => removeItem(i)} title="Remove">
                <IconX size={12} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="ml-add-row">
        <select
          className="ml-add-select"
          value=""
          onChange={e => { if (e.target.value) addItem(e.target.value) }}
        >
          {/* hidden: shows as the select's resting label when closed, but
              isn't itself a choice — doesn't appear in the opened list. */}
          <option value="" hidden>+ Add probe</option>
          {availableChoices.map(c => (
            <option key={c} value={c} title={c}>{shortProbeLabel(c, category)}</option>
          ))}
        </select>
        <button className="icon-btn ml-manage-btn" onClick={() => setManageOpen(true)} title="Manage probes…">
          <IconSettings size={14} />
        </button>
      </div>
      {manageOpen && (
        <ManageProbesDialog
          category={category}
          value={value}
          choices={choices}
          onAdd={addItem}
          onChange={onChange}
          onChoicesRefresh={onChoicesRefresh}
          onClose={() => setManageOpen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

const LOG_ENTRY_LIMITS = [100, 250, 500, 1000, 2000]

// Mirrors logger.py's LogLevel enum — keep names aligned with the backend
// if either changes. Not fetched at runtime: these are a fixed taxonomy
// (not user data), and ConfigTab/LogsTab have independent fetch lifecycles,
// so reusing /api/config's choices would mean either a duplicate request
// or lifting state up, for protection against a change that's unlikely.
const LOG_LEVELS = ["debug", "info", "warning", "error", "critical"] as const
type LogLevelName = typeof LOG_LEVELS[number]

// CSS class per category — warning/error double up with their neighbors
// since there's no separate "notice" or "fatal" tier in the stylesheet.
const LEVEL_CLASS: Record<LogLevelName, string> = {
  debug: "ll-debug",
  info: "ll-info",
  warning: "ll-warn",
  error: "ll-error",
  critical: "ll-error",
}

// "all" is a frontend-only sentinel for "no filter", not a real severity.
// CRITICAL is excluded as a filter option — same reasoning as logger.py's
// cfg choices: not a sensible floor to filter down to, only a category
// individual log calls can reach.
type MinLevel = "all" | Exclude<LogLevelName, "critical">
const MIN_LEVEL_OPTIONS: MinLevel[] = ["all", ...LOG_LEVELS.filter((l): l is Exclude<LogLevelName, "critical"> => l !== "critical")]

const DEFAULT_ENTRY_LIMIT = 500

function LogsTab() {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entryLimit, setEntryLimit] = useState(DEFAULT_ENTRY_LIMIT)
  const [minLevel, setMinLevel] = useState<MinLevel>("all")
  const [showLineNumbers, setShowLineNumbers] = useState(false)
  const [lineWrap, setLineWrap] = useState(true)
  const [filterOpen, setFilterOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Entries deliberately doesn't count toward this — it reads more like
  // normal pagination than a filter, and unlike severity, capping it can't
  // make logs look like they've silently gone missing.
  const filterActive = minLevel !== "all"

  const load = useCallback(() => {
    fetch(`/api/logs?n=${entryLimit}&level=${minLevel}`)
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
  }, [entryLimit, minLevel])

  // Both are server-side params now — severity used to be filtered
  // client-side, but that only ever hid rows within the already-fetched
  // window, so a rare level (e.g. errors) could show "2 of 500" instead of
  // the last `entryLimit` matching entries. The backend has the full log
  // history available to search, the frontend doesn't.
  useEffect(() => { load() }, [load])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" })
  }, [records])

  const levelCls = (level: string) => LEVEL_CLASS[level as LogLevelName] ?? ""

  // Plain anchor click, not window.open — Content-Disposition: attachment
  // makes the browser download rather than navigate either way, but a real
  // anchor does it without a tab flashing open and closing. Uses the
  // current severity filter (not entryLimit) since the point of exporting
  // is getting the complete matching history, not just what's on screen.
  const handleExport = (format: "txt" | "csv") => {
    const params = new URLSearchParams({ level: minLevel, format })
    const a = document.createElement("a")
    a.href = `/api/logs/export?${params}`
    a.click()
  }

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        <button
          className={`so-toolbar-btn logs-filter-btn${filterOpen || filterActive ? " active" : ""}`}
          onClick={() => setFilterOpen(o => !o)}
          aria-expanded={filterOpen}
          title="Filter"
        >
          <IconFilter size={13} />
          <span className="control-text">Filter</span>
          {filterActive && <span className="logs-filter-dot" title="A filter is active" />}
        </button>
        <span className="logs-toolbar-sep" aria-hidden="true" />
        <button
          className={`so-toolbar-btn${showLineNumbers ? " active" : ""}`}
          onClick={() => setShowLineNumbers(v => !v)}
          aria-pressed={showLineNumbers}
          title="Line numbers"
        >
          <IconListNumbers size={14} />
          <span className="control-text">Line numbers</span>
        </button>
        <button
          className={`so-toolbar-btn${lineWrap ? " active" : ""}`}
          onClick={() => setLineWrap(v => !v)}
          aria-pressed={lineWrap}
          title="Line wrap"
        >
          <IconTextWrap size={14} />
          <span className="control-text">Line wrap</span>
        </button>
      </div>
      {filterOpen && (
        <div className="logs-filter-row">
          <label className="logs-field">
            Severity
            <select
              className="logs-select"
              value={minLevel}
              onChange={e => { setLoading(true); setError(null); setMinLevel(e.target.value as MinLevel) }}
              title="Minimum severity to show"
            >
              {MIN_LEVEL_OPTIONS.map(lvl => (
                <option key={lvl} value={lvl}>{lvl[0].toUpperCase() + lvl.slice(1)}</option>
              ))}
            </select>
          </label>
          <label className="logs-field">
            Entries
            <select
              className="logs-select"
              value={entryLimit}
              onChange={e => { setLoading(true); setError(null); setEntryLimit(Number(e.target.value)) }}
              title="Entries to fetch"
            >
              {LOG_ENTRY_LIMITS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      )}
      {error ? (
        <div className="logs-error">{error}</div>
      ) : (
        <div className={`logs-body${lineWrap ? "" : " logs-nowrap"}`}>
          {records.map((rec, i) => (
            <div key={i} className={`log-row${showLineNumbers ? " with-nums" : ""}`}>
              {showLineNumbers && <span className="log-num">{i + 1}</span>}
              <span className="log-ts">{rec.timestamp}</span>
              <span className={`log-level ${levelCls(rec.level)}`}>{rec.level.toUpperCase()}</span>
              <span className="log-logger">{rec.logger}</span>
              <span className="log-msg">{rec.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
      <div className="logs-footer">
        <div className="logs-footer-left">
          {records.length > 0 && (
            <span className="logs-count">{records.length} entries</span>
          )}
          <button className="icon-btn logs-refresh-btn" onClick={() => { setLoading(true); setError(null); load() }} disabled={loading} title="Refresh logs">
            <IconRefresh size={12} className={loading ? "spinning" : ""} />
          </button>
        </div>
        <label className="logs-field" title="Export the full matching log history">
          <select
            className="logs-select logs-export-select"
            value=""
            onChange={e => {
              if (e.target.value) handleExport(e.target.value as "txt" | "csv")
              e.target.value = ""
            }}
          >
            <option value="" disabled>Export as…</option>
            <option value="txt">.log</option>
            <option value="csv">.csv</option>
          </select>
        </label>
      </div>
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
      <div className="about-row">
        <span className="about-label">Backend</span>
        <RestartButton label="Restart Backend" />
      </div>
    </div>
  )
}
