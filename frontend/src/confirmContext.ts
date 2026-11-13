import { createContext, useContext } from "react"

export type ConfirmRequest = {
  /** The question, e.g. "Cancel Bad Block Scan?" */
  title: string
  /** What happens if confirmed, in a sentence. */
  detail?: string
  /** The red button, naming the action: "Cancel task", never just "OK". */
  confirmLabel: string
  /** The way out; defaults to "Cancel". */
  cancelLabel?: string
}

/** Opens the confirm pop-up; resolves true if the action was confirmed. */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

// No silent default: confirming nothing would let a destructive action
// through, so a missing ConfirmProvider fails loudly instead.
export const ConfirmContext = createContext<Confirm>(() => Promise.reject(new Error("useConfirm() needs a ConfirmProvider")))

export function useConfirm(): Confirm {
  return useContext(ConfirmContext)
}
