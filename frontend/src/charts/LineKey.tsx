/** A short stroke in a series' color (dashed if the series is): identifies a
 *  line wherever it's named — tooltips, legend chips — without a filled
 *  swatch, which would be data-weight ink doing a label's job. */
export default function LineKey({ color, dash, width = 14 }: { color: string; dash?: string; width?: number }) {
  return (
    <svg className="line-key" width={width} height="2" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <line x1="0" x2={width} y1="1" y2="1" stroke={color} strokeWidth="2" strokeDasharray={dash ? "3 2" : undefined} />
    </svg>
  )
}
