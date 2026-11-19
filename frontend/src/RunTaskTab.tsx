import type { Drive } from "./types"
import { StubTab } from "./WorkspacePanel"
import RunTaskForm, { type RunOperation } from "./RunTaskForm"
import type { RunRecipe } from "./RecipeForm"

interface Props {
  drives: Drive[]
  selected: string[]
  onRun: RunOperation
  onRunRecipe: RunRecipe
}

export default function RunTaskTab({ drives, selected, onRun, onRunRecipe }: Props) {
  if (selected.length === 0) {
    return <StubTab label="Run Task" note="Select one or more drives to configure and launch operations." />
  }
  return <RunTaskForm drives={drives} guids={selected} onRun={onRun} onRunRecipe={onRunRecipe} />
}
