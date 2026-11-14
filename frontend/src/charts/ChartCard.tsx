import type { ReactNode } from "react"
import "./ChartCard.css"

/** The frame around one chart in a dashboard: title, a subtitle saying what
 *  is plotted, an optional callout (the headline number) on the right, the
 *  chart, and an optional footnote under it. While newer data loads, `stale` dims the old chart rather than
 *  blanking it, so the layout never jumps. */
export default function ChartCard({ title, subtitle, callout, stale = false, footer, children }: {
  title: string
  subtitle?: ReactNode
  callout?: ReactNode
  stale?: boolean
  footer?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className={`chart-card${stale ? " stale" : ""}`} aria-busy={stale || undefined}>
      <header className="chart-card-head">
        <div>
          <h3 className="chart-card-title">{title}</h3>
          {subtitle && <div className="chart-card-sub">{subtitle}</div>}
        </div>
        {callout && <div className="chart-card-callout">{callout}</div>}
      </header>
      {children}
      {footer && <footer className="chart-card-foot">{footer}</footer>}
    </section>
  )
}
