import { createContext, useContext } from "react"

export type SmartReadContextValue = {
  /** Drives with a full SMART read asked for here and not yet back. */
  reading: ReadonlySet<string>
  /** Take a full SMART read of each drive now, idle or not; resolves once
   *  they're all read and the drive list reloaded (false if it failed). */
  readSmart: (guids: string[]) => Promise<boolean>
}

// The no-op default keeps components usable outside App (tests, previews).
export const SmartReadContext = createContext<SmartReadContextValue>({
  reading: new Set(),
  readSmart: () => Promise.resolve(false),
})

export function useSmartRead(): SmartReadContextValue {
  return useContext(SmartReadContext)
}
