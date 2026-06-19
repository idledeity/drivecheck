import { IconBarcode } from "@tabler/icons-react"
import "./Serial.css"

export default function Serial({ value, className }: { value: string; className?: string }) {
  return (
    <span className={`serial-tag${className ? ` ${className}` : ""}`}>
      <IconBarcode size={13} />{value}
    </span>
  )
}
