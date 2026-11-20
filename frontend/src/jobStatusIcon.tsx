import { IconAlertTriangle, IconBan, IconCheck, IconClock, IconHelpCircle, IconLoader2, IconPlayerSkipForward } from "@tabler/icons-react"
import type { Job } from "./types"

// The icon a task row shows for each status (a job's, or a batch's derived one).
export const STATUS_ICON: Record<Job["status"], React.ReactNode> = {
  running:     <IconLoader2 size={13} className="spinning" />,
  queued:      <IconClock size={13} />,
  completed:   <IconCheck size={13} />,
  failed:      <IconAlertTriangle size={13} />,
  cancelled:   <IconBan size={13} />,
  interrupted: <IconHelpCircle size={13} />,
  skipped:     <IconPlayerSkipForward size={13} />,
}
