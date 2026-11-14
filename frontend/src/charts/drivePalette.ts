// Each charted drive's series color.
//
// Colors are --s1…--s12 in index.css: twelve hues kept clear of the app's
// reserved colors (cyan, amber, salmon, status green, selection purple), so a
// drive's line never reads as a status or a selection. Drives get them by their
// place among *all* known drives, ordered by when each was first seen (see
// driveColorOrder) — not by selection or grid sort — so a drive keeps its color
// whichever drives are selected, hidden or sorted, and across restarts; a newly
// attached drive goes on the end. A 13th drive reuses the first hue: the legend
// and tooltip chips name every line, so a repeat is never ambiguous.

export const SERIES_COLOR_COUNT = 12

export interface SeriesStyle {
  color: string
  dash?: string
}

export function seriesStyle(index: number): SeriesStyle {
  return { color: `var(--s${(index % SERIES_COLOR_COUNT) + 1})` }
}

/** Every drive's guid in color order: first seen earliest first (never-seen
 *  last), ties broken by guid — an order nothing in the UI can shuffle. */
export function driveColorOrder(drives: { guid: string; first_seen: string | null }[]): string[] {
  return [...drives]
    .sort((a, b) => (a.first_seen ?? "\uffff").localeCompare(b.first_seen ?? "\uffff") || a.guid.localeCompare(b.guid))
    .map(d => d.guid)
}

/** guid → its series style, by position in guids (from driveColorOrder). */
export function driveStyles(guids: string[]): Record<string, SeriesStyle> {
  return Object.fromEntries(guids.map((g, i) => [g, seriesStyle(i)]))
}
