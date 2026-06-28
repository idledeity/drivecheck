import { IconChevronLeft, IconChevronRight, IconChevronUp, IconChevronDown } from "@tabler/icons-react"
import "./CollapseToggle.css"

interface Props {
  collapsed: boolean
  onToggle: () => void
  orientation: "horizontal" | "vertical"
  expandLabel: string
  collapseLabel: string
  className?: string
}

/* Shared collapse/expand chevron button (Settings nav, WorkspacePanel) — same
   icon-btn chrome and chip background everywhere, just the icon direction and
   surrounding layout differ by call site. Chevron points "forward" (right or
   down) while collapsed, since that's the direction the panel will grow into
   on expand; "backward" (left or up) while expanded, the direction it'll
   collapse back to. */
export default function CollapseToggle({ collapsed, onToggle, orientation, expandLabel, collapseLabel, className }: Props) {
  const Icon = orientation === "horizontal"
    ? (collapsed ? IconChevronRight : IconChevronLeft)
    : (collapsed ? IconChevronDown : IconChevronUp)
  return (
    <button
      className={`icon-btn collapse-toggle-btn${className ? ` ${className}` : ""}`}
      onClick={onToggle}
      title={collapsed ? expandLabel : collapseLabel}
    >
      <Icon size={14} />
    </button>
  )
}
