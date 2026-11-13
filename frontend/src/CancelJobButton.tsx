import { IconX } from "@tabler/icons-react"
import type { Drive, Job } from "./types"
import { useConfirm } from "./confirmContext"
import { jobCancelConfirmation } from "./jobCancelConfirmation"
import "./CancelJobButton.css"

// The × that cancels a job. A running job asks first, in the confirm pop-up,
// since ending it throws away however long it has been going; one still
// waiting to start loses nothing and goes at once.
export default function CancelJobButton({ job, drive, onCancel }: { job: Job; drive?: Drive; onCancel: (jobId: string) => void }) {
  const confirm = useConfirm()

  const handleClick = (e: React.MouseEvent) => {
    // These sit inside rows and cards with click handlers of their own
    // (expand the row, select the card, open a popover).
    e.stopPropagation()
    const request = jobCancelConfirmation([job], drive ? [drive] : [])
    if (!request) { onCancel(job.id); return }
    void confirm(request).then(ok => { if (ok) onCancel(job.id) })
  }

  return (
    <button className="queue-cancel" title="Cancel" aria-label={`Cancel: ${job.operation_name}`} onClick={handleClick}>
      <IconX size={13} />
    </button>
  )
}
