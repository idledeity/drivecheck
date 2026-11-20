import { useEffect, useState } from "react"
import { IconChevronRight, IconPlayerPlay } from "@tabler/icons-react"
import type { BatchPreview, BatchPreviewDrive, BatchPreviewStep, Drive, ParamSpec, RecipeInfo } from "./types"
import DestructiveConfirmDialog from "./DestructiveConfirmDialog"
import DriveChip from "./DriveChip"
import { STATUS_ICON } from "./jobStatusIcon"
import "./JobRow.css"
import { formatSettingValue, humanizeKey } from "./format"
import { LockWarning, ParamInput } from "./RunTaskParams"
import { paramDefaults, paramErrors } from "./paramValues"

/** Start a recipe on each drive; resolves to the server's reason if it refused, else null. */
export type RunRecipe = (
  guids: string[], recipe: string, params: Record<string, unknown>, stopOnFailure: boolean,
) => Promise<string | null>

// How long the plan waits for edits to settle before it is fetched again.
const PREVIEW_DELAY_MS = 250

interface Props {
  recipe: RecipeInfo
  drives: Drive[]
  guids: string[]
  onRun: RunRecipe
}

// A recipe's params, its stop-on-failure option, and its plan: what each drive
// would run, with the settings each step would use there, refetched as the
// params change. Run starts a batch on each drive the plan includes.
export default function RecipeForm({ recipe, drives, guids, onRun }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>(() => paramDefaults(recipe.params))
  const [stopOnFailure, setStopOnFailure] = useState(recipe.stop_on_failure)
  const [preview, setPreview] = useState<BatchPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const errors = paramErrors(recipe.params, values)
  const hasParamErrors = Object.values(errors).some(e => e !== null)
  const request = JSON.stringify({ guids, recipe: recipe.key, params: values, stop_on_failure: stopOnFailure })

  useEffect(() => {
    if (hasParamErrors) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      fetch("/api/batches/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request,
        signal: abort.signal,
      })
        .then(async r => {
          const body = await r.json().catch(() => null)
          if (!r.ok) throw new Error(body?.error ?? `Request failed (HTTP ${r.status})`)
          setPreview(body as BatchPreview)
          setPreviewError(null)
        })
        .catch((e: Error) => {
          if (abort.signal.aborted) return
          setPreviewError(e.message || "Couldn't plan the recipe")
        })
    }, PREVIEW_DELAY_MS)
    return () => { clearTimeout(timer); abort.abort() }
  }, [request, hasParamErrors])

  // The plan matches the form only once it has caught up with the latest edit.
  const current = preview !== null && !hasParamErrors
    && sameValues(preview.params, values) && preview.stop_on_failure === stopOnFailure
    && preview.drives.length === guids.length && preview.drives.every((d, i) => d.guid === guids[i])
  const included = current ? preview.drives.filter(d => d.excluded === null) : []
  const lockedCount = included.filter(d => d.locked).length
  const targets = included
    .map(p => drives.find(d => d.guid === p.guid))
    .filter((d): d is Drive => d !== undefined)
  const canRun = current && included.length > 0 && lockedCount === 0 && !running

  const dispatch = () => {
    if (!canRun) return
    setConfirming(false)
    setRunning(true)
    setRunError(null)
    onRun(included.map(d => d.guid), recipe.key, values, stopOnFailure)
      .then(err => setRunError(err))
      .finally(() => setRunning(false))
  }

  const handleRun = () => {
    if (!canRun) return
    if (recipe.destructive) setConfirming(true)
    else dispatch()
  }

  const stopSpec: ParamSpec = {
    name: "stop_on_failure", label: "Stop if a step fails", type: "boolean", default: recipe.stop_on_failure,
    min: null, max: null,
    tooltip: "If a step fails or is cancelled, skip the drive's remaining steps. "
      + "Off: every step runs whatever happened before it.",
  }

  return (
    <div className="rt-form">
      <h3 className="rt-form-title">{recipe.name}</h3>
      <p className="rt-form-description">{recipe.description}</p>
      {recipe.params.map(spec => (
        <ParamInput
          key={spec.name}
          spec={spec}
          value={values[spec.name]}
          error={errors[spec.name]}
          onChange={value => setValues(prev => ({ ...prev, [spec.name]: value }))}
        />
      ))}
      <ParamInput spec={stopSpec} value={stopOnFailure} error={null} onChange={v => setStopOnFailure(Boolean(v))} />

      <section className={`rt-plan${current ? "" : " stale"}`} aria-label="Plan" aria-busy={!current}>
        <h4 className="rt-plan-title">Plan</h4>
        {previewError && !hasParamErrors
          ? <div className="rt-run-error" role="alert">{previewError}</div>
          : preview === null
            ? <div className="rt-plan-note">Planning…</div>
            : <PlanGroups preview={preview} drives={drives} />}
      </section>

      {lockedCount > 0 && <LockWarning count={lockedCount} />}
      {current && included.length === 0 && (
        <div className="rt-lock-warning">None of the selected drives can run {recipe.name}.</div>
      )}
      <button className="rt-run" onClick={handleRun} disabled={!canRun}>
        <IconPlayerPlay size={14} />
        Run{current && included.length > 0 && included.length < guids.length ? ` on ${included.length} of ${guids.length} drives` : ""}
      </button>
      {runError && <div className="rt-run-error" role="alert">{runError}</div>}
      {confirming && recipe.destructive && (
        <DestructiveConfirmDialog
          name={recipe.name}
          targets={targets}
          onConfirm={dispatch}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

// The plan, with drives whose plans are the same shown together, each group
// drawn as the queued batch it will become: a task row with the drives'
// chips, the recipe's pill and its steps as lines inside, as in Activity and
// History. A step's settings show under it, open to start with; clicking the
// step folds them.
function PlanGroups({ preview, drives }: { preview: BatchPreview; drives: Drive[] }) {
  const groups = new Map<string, BatchPreviewDrive[]>()
  for (const d of preview.drives) {
    const key = JSON.stringify({ excluded: d.excluded, steps: d.steps })
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  // Drives that take part first, those left out after.
  const ordered = [...groups.values()].sort((a, b) => Number(a[0].excluded !== null) - Number(b[0].excluded !== null))
  return (
    <div className="rt-plan-groups">
      {ordered.map(group => {
        const plan = group[0]
        const steps = plan.steps ?? []
        const status = plan.excluded !== null ? "skipped" : "queued"
        return (
          <div key={group.map(d => d.guid).join(",")} role="group" aria-label={`Plan for ${group.length} drive${group.length === 1 ? "" : "s"}`}
            className={`queue-row batch-row rt-plan-row queue-row-${status}${plan.excluded !== null ? " excluded" : ""}`}>
            <div className="queue-row-main">
              <span className="queue-lead">
                <span className={`queue-status-icon queue-status-${status}`}>{STATUS_ICON[status]}</span>
              </span>
              {plan.excluded === null && (
                <span className="queue-op batch">{preview.recipe.name}<span className="queue-op-count">{steps.length} step{steps.length === 1 ? "" : "s"}</span></span>
              )}
              <span className="queue-outcome">
                {plan.excluded !== null ? `Left out: ${plan.excluded}` : preview.stop_on_failure ? "Stops on failure" : ""}
              </span>
              <div className="drive-chip-list" aria-label="Drives">
                {group.map(p => {
                  const drive = drives.find(d => d.guid === p.guid)
                  return drive
                    ? <DriveChip key={p.guid} drive={drive} blocked={p.locked && p.excluded === null} />
                    : <span key={p.guid} className="rt-plan-unknown">Unknown drive</span>
                })}
              </div>
            </div>
            {plan.excluded === null && (
              <>
                <div className="batch-strip" aria-hidden="true">
                  {steps.map((step, i) => <span key={i} className={`batch-seg${step.supported ? "" : " skipped"}`} />)}
                </div>
                <ol className="batch-steps rt-plan-steps">
                  {steps.map((step, i) => <PlanStep key={i} step={step} />)}
                </ol>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

// One step of a plan, as a batch's step line: its settings open beneath it
// until the line is clicked.
function PlanStep({ step }: { step: BatchPreviewStep }) {
  const [open, setOpen] = useState(true)
  const status = step.supported ? "queued" : "skipped"
  const foldable = step.supported && step.settings.length > 0
  const toggle = () => { if (foldable) setOpen(o => !o) }
  return (
    <li className={`queue-row step queue-row-${status}${foldable ? " foldable" : ""}`} onClick={toggle}>
      <div className="queue-row-main"
        {...(foldable ? { role: "button", tabIndex: 0, "aria-expanded": open, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle() } } } : {})}>
        <span className="queue-lead">
          <span className={`queue-status-icon queue-status-${status}`}>{STATUS_ICON[status]}</span>
        </span>
        <span className="queue-op">{step.operation_name}</span>
        <span className="queue-outcome">
          {!step.supported ? "Skipped: not supported on this drive" : step.check?.description ?? ""}
        </span>
        <span className="queue-right">
          {foldable && <IconChevronRight size={12} className={`rt-plan-caret${open ? " open" : ""}`} />}
        </span>
      </div>
      {foldable && open && (
        <dl className="rt-plan-step-settings">
          {step.settings.map(s => (
            <div key={s.name}>
              <dt>{s.label ?? humanizeKey(s.name)}</dt>
              <dd>{formatSettingValue(s.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

// Key by key: the server's JSON comes back with its keys sorted.
function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k])
}
