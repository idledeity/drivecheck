import type { ReactNode } from "react"
import "./ChartCard.css"

/** The frame around one chart in a dashboard: title, a subtitle saying what
 *  is plotted, optional controls (e.g. a view switch) and callout (the
 *  headline number) on the right, the
 *  chart, and an optional footnote under it. While newer data loads, `stale` dims the old chart rather than
 *  blanking it, so the layout never jumps. */
export default function ChartCard({ title, subtitle, controls, callout, stale = false, footer, children }: {
  title: string
  subtitle?: ReactNode
  controls?: ReactNode
  callout?: ReactNode
  stale?: boolean
  footer?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className={`chart-card${stale ? " stale" : ""}`} aria-busy={stale || undefined}>
      <header className={`chart-card-head${controls ? " with-controls" : ""}`}>
        <div className="chart-card-main">
          <h3 className="chart-card-title">{title}</h3>
          {subtitle && <div className="chart-card-sub">{subtitle}</div>}
        </div>
        {(controls || callout) && (
          <div className="chart-card-side">
            {controls}
            {callout && <div className="chart-card-callout">{callout}</div>}
          </div>
        )}
      </header>
      {children}
      {footer && <footer className="chart-card-foot">{footer}</footer>}
    </section>
  )
}
