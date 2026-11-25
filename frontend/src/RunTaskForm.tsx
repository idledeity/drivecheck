import { useEffect, useState } from "react"
import { IconPlayerPlay } from "@tabler/icons-react"
import type { Drive, OperationInfo, RecipeInfo } from "./types"
import { StubTab } from "./WorkspacePanel"
import DestructiveConfirmDialog from "./DestructiveConfirmDialog"
import { LockWarning, ParamInput } from "./RunTaskParams"
import { paramDefaults, paramErrors } from "./paramValues"
import RecipeForm, { type RunRecipe } from "./RecipeForm"
import "./RunTaskForm.css"
import DriveChip from "./DriveChip"

const CATEGORY_ORDER = ["Test", "Scan", "Maintenance", "Debug"]

export type RunOperation = (guids: string[], operation: string, params: Record<string, unknown>) => Promise<string | null>

interface Props {
  drives: Drive[]
  // The drives the task runs on; must not be empty.
  guids: string[]
  onRun: RunOperation
  onRunRecipe: RunRecipe
}

// What the sidebar has picked: an operation or a recipe (their keys could clash).
type Active = { kind: "operation" | "recipe"; key: string }

// Pick an operation or a recipe for the given drives, set its params and run it.
// Recipes are listed first, under "Recipes"; operations by category.
export default function RunTaskForm({ drives, guids, onRun, onRunRecipe }: Props) {
  const [operations, setOperations] = useState<OperationInfo[]>([])
  const [recipes, setRecipes] = useState<RecipeInfo[]>([])
  const [active, setActive] = useState<Active | null>(null)
  // Guids the operations were last fetched for, and whether recipes have loaded:
  // the default pick waits for both, so it doesn't depend on which came first.
  const [opsFor, setOpsFor] = useState<string[] | null>(null)
  const [recipesLoaded, setRecipesLoaded] = useState(false)

  useEffect(() => {
    fetch(`/api/operations?guids=${encodeURIComponent(guids.join(","))}`)
      .then(r => r.json())
      .then((ops: OperationInfo[]) => setOperations(ops))
      .catch(() => setOperations([]))
      .finally(() => setOpsFor(guids))
  }, [guids])

  // Every recipe is offered: which drives it suits shows in its plan.
  useEffect(() => {
    fetch("/api/recipes")
      .then(r => r.json())
      .then((list: RecipeInfo[]) => setRecipes(Array.isArray(list) ? list : []))
      .catch(() => setRecipes([]))
      .finally(() => setRecipesLoaded(true))
  }, [])

  const activeOp = active?.kind === "operation" ? operations.find(o => o.key === active.key) ?? null : null
  const activeRecipe = active?.kind === "recipe" ? recipes.find(r => r.key === active.key) ?? null : null
  // Default to the first operation (operations are what most runs are), else the first recipe.
  const fallback: Active | null = operations[0]
    ? { kind: "operation", key: operations[0].key }
    : recipes[0] ? { kind: "recipe", key: recipes[0].key } : null
  if (opsFor === guids && recipesLoaded && !activeOp && !activeRecipe && fallback && (active?.kind !== fallback.kind || active.key !== fallback.key)) {
    setActive(fallback)
  }

  if (operations.length === 0 && recipes.length === 0) {
    return <StubTab label="Run Task" note="No operations available for the selected drives." />
  }

  const categories = Array.from(new Set(operations.map(o => o.category)))
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a)
      const bi = CATEGORY_ORDER.indexOf(b)
      return (ai === -1 ? CATEGORY_ORDER.length : ai) - (bi === -1 ? CATEGORY_ORDER.length : bi)
    })

  const isActive = (kind: Active["kind"], key: string) => active?.kind === kind && active.key === key

  return (
    <div className="run-task-form">
      {/* Phones get this instead of the sidebar (RunTaskForm.css), so the form keeps the full width. */}
      <select
        className="rt-select"
        aria-label="Task"
        value={active ? `${active.kind}:${active.key}` : ""}
        onChange={e => {
          const [kind, ...rest] = e.target.value.split(":")
          setActive({ kind: kind as Active["kind"], key: rest.join(":") })
        }}
      >
        {recipes.length > 0 && (
          <optgroup label="Recipes">
            {recipes.map(recipe => <option key={recipe.key} value={`recipe:${recipe.key}`}>{recipe.name}</option>)}
          </optgroup>
        )}
        {categories.map(cat => (
          <optgroup key={cat} label={cat}>
            {operations.filter(o => o.category === cat).map(op => (
              <option key={op.key} value={`operation:${op.key}`}>{op.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <nav className="rt-sidebar">
        {recipes.length > 0 && (
          <div className="rt-category">
            <div className="rt-category-label">Recipes</div>
            {recipes.map(recipe => (
              <button
                key={recipe.key}
                className={`rt-op${isActive("recipe", recipe.key) ? " active" : ""}`}
                onClick={() => setActive({ kind: "recipe", key: recipe.key })}
              >
                {recipe.name}
              </button>
            ))}
          </div>
        )}
        {categories.map(cat => (
          <div key={cat} className="rt-category">
            <div className="rt-category-label">{cat}</div>
            {operations.filter(o => o.category === cat).map(op => (
              <button
                key={op.key}
                className={`rt-op${isActive("operation", op.key) ? " active" : ""}`}
                onClick={() => setActive({ kind: "operation", key: op.key })}
              >
                {op.name}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {/* Keyed, so picking another one starts its form over from its defaults. */}
      {activeOp && <OperationForm key={`operation:${activeOp.key}`} operation={activeOp} drives={drives} guids={guids} onRun={onRun} />}
      {activeRecipe && <RecipeForm key={`recipe:${activeRecipe.key}`} recipe={activeRecipe} drives={drives} guids={guids} onRun={onRunRecipe} />}
    </div>
  )
}

// One operation's params and Run button. Destructive operations go through
// DestructiveConfirmDialog first.
function OperationForm({ operation, drives, guids, onRun }: { operation: OperationInfo; drives: Drive[]; guids: string[]; onRun: RunOperation }) {
  const [paramValues, setParamValues] = useState<Record<string, unknown>>(() => paramDefaults(operation.params))
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const targets = guids
    .map(guid => drives.find(d => d.guid === guid))
    .filter((d): d is Drive => d !== undefined)

  const lockedTargets = operation.destructive
    ? guids.filter(guid => drives.find(d => d.guid === guid)?.locked)
    : []
  const blockedByLock = lockedTargets.length > 0
  const errors = paramErrors(operation.params, paramValues)
  const hasParamErrors = Object.values(errors).some(e => e !== null)

  const dispatch = () => {
    if (blockedByLock || hasParamErrors) return
    setConfirming(false)
    setRunning(true)
    setRunError(null)
    onRun(guids, operation.key, paramValues)
      .then(err => setRunError(err))
      .finally(() => setRunning(false))
  }

  // Destructive operations never dispatch straight from the Run button.
  const handleRun = () => {
    if (blockedByLock || hasParamErrors) return
    if (operation.destructive) setConfirming(true)
    else dispatch()
  }

  return (
    <div className="rt-form">
      <h3 className="rt-form-title">{operation.name}</h3>
      <div className="rt-form-targets">
        <span className="rt-form-targets-label">Runs on</span>
        <div className="drive-chip-list" aria-label="Target drives">
          {targets.map(d => (
            <DriveChip key={d.guid} drive={d} blocked={blockedByLock && d.locked} />
          ))}
        </div>
      </div>
      {operation.params.map(spec => (
        <ParamInput
          key={spec.name}
          spec={spec}
          value={paramValues[spec.name]}
          error={errors[spec.name]}
          onChange={value => setParamValues(prev => ({ ...prev, [spec.name]: value }))}
        />
      ))}
      {blockedByLock && <LockWarning count={lockedTargets.length} />}
      <button className="rt-run" onClick={handleRun} disabled={running || blockedByLock || hasParamErrors}>
        <IconPlayerPlay size={14} />
        Run
      </button>
      {runError && <div className="rt-run-error" role="alert">{runError}</div>}
      {confirming && operation.destructive && (
        <DestructiveConfirmDialog
          name={operation.name}
          targets={targets}
          onConfirm={dispatch}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
