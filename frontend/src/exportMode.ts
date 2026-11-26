import { createContext, useContext } from "react"

/* True while a view is rendered for export (print / PDF, HTML download):
   collapsible sections render open, and times show as dates rather than
   "3h ago", which would be wrong by the time anyone reads the file. */
export const ExportModeContext = createContext(false)

export function useExportMode(): boolean {
  return useContext(ExportModeContext)
}
