import { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconChevronRight, IconX } from '@tabler/icons-react'

/**
 * Interactive legend of the map: one section per visible layer (heatmap, connectivity
 * polygons, arrows), each row a class of values. Clicking a row switches it on or off;
 * the classes that are on keep full colours on the map, the others are dimmed by the
 * layer.
 *
 * The component is presentation only: classes, counts and selection come from App.
 *
 * @param {Array<{
 *   key: string, title: string,
 *   rows: Array<{ swatch: object, label: string, count: number, index?: number }>,
 *   selected: Set<number>, onToggle: (index: number) => void, onReset: () => void,
 * }>} sections  rows from top (high values) to bottom; without `index` a row is not clickable
 */
export default function MapLegend({ sections, labels, maxHeight }) {
  const [collapsed, setCollapsed] = useState({})

  // When a new section appears (e.g. a connectivity after the PPI) only that one stays
  // open: the space below the tools panel is not enough for three open sections.
  const seen = useRef(new Set())
  const keys = sections.map(s => s.key).join('|')
  useEffect(() => {
    const current = sections.map(s => s.key)
    const fresh = current.filter(k => !seen.current.has(k))
    seen.current = new Set(current)
    if (fresh.length && current.length > fresh.length) {
      setCollapsed(Object.fromEntries(current.map(k => [k, !fresh.includes(k)])))
    }
  }, [keys])

  if (!sections.length) return null

  return (
    <div className="map-legend" style={maxHeight ? { maxHeight } : undefined}>
      {sections.map(sec => {
        const closed = !!collapsed[sec.key]
        const anySelected = sec.selected.size > 0
        return (
          <section key={sec.key} className="map-legend-section">
            <div className="map-legend-head">
              <button
                type="button"
                className="map-legend-title"
                onClick={() => setCollapsed(c => ({ ...c, [sec.key]: !closed }))}
                aria-expanded={!closed}
              >
                {closed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                {sec.title}
              </button>
              {anySelected && (
                <button type="button" className="map-legend-reset" onClick={sec.onReset}
                        title={labels.showAll} aria-label={labels.showAll}>
                  <IconX size={12} />
                </button>
              )}
            </div>

            {!closed && sec.rows.map((row, k) => {
              const clickable = row.index !== undefined && row.count > 0
              const active    = clickable && sec.selected.has(row.index)
              const cls = ['map-legend-row',
                active ? 'is-active' : '',
                anySelected && !active ? 'is-dimmed' : '',
                clickable ? '' : 'is-static'].filter(Boolean).join(' ')
              return (
                <button
                  key={k}
                  type="button"
                  className={cls}
                  disabled={!clickable}
                  aria-pressed={clickable ? active : undefined}
                  onClick={() => clickable && sec.onToggle(row.index)}
                >
                  <Swatch {...row.swatch} />
                  <span className="map-legend-label">{row.label}</span>
                  <span className="map-legend-count">{row.count}</span>
                </button>
              )
            })}
          </section>
        )
      })}
      <div className="map-legend-hint">{labels.hint}</div>
    </div>
  )
}

/** Swatch: a filled square for cells and polygons, a line for arrows. */
function Swatch({ color, line, width = 2, dashed }) {
  if (line) {
    return (
      <span className="map-legend-swatch">
        <span style={{ display: 'block', width: 18, height: Math.max(1, width),
                       background: color, borderRadius: 2,
                       // the low bands are almost white: without an outline they would vanish
                       boxShadow: '0 0 0 0.5px rgba(0,0,0,0.3)' }} />
      </span>
    )
  }
  return (
    <span className="map-legend-swatch">
      <span style={{ display: 'block', width: 14, height: 12, borderRadius: 3, background: color,
                     border: dashed ? '1px dashed #64748b' : '1px solid rgba(0,0,0,0.12)' }} />
    </span>
  )
}
