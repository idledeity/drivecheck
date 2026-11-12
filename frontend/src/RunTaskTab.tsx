import type { Drive } from "./types"
import { StubTab } from "./WorkspacePanel"
import RunTaskForm from "./RunTaskForm"

interface Props {
  drives: Drive[]
  selected: string[]
  onRun: (guids: string[], operation: string, params: Record<string, unknown>) => Promise<string | null>
}

export default function RunTaskTab({ drives, selected, onRun }: Props) {
  if (selected.length === 0) {
    return <StubTab label="Run Task" note="Select one or more drives to configure and launch operations." />
  }
  return <RunTaskForm drives={drives} guids={selected} onRun={onRun} />
}
