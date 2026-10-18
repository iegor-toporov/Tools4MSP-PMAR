import { forwardRef, useEffect, useRef, useState } from 'react'
import { Button, Text, Box, Group, ActionIcon, ColorSwatch } from '@mantine/core'
import { IconX, IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { comparisonCsv } from '../export/pmarTools'
import { saveText } from '../export/download'
import { FloatingWindow } from './FloatingWindow'

export const AREA_COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff453a', '#64d2ff', '#ffd60a', '#ff375f']

// ── Multi-area grouped histogram SVG ─────────────────────────────────────────

function ComparisonSVG({ results, mapTheme, svgRef }) {
  const nBins = results[0]?.nBins ?? 20
  const N     = results.length
  const H     = 200
  const mx    = { top: 14, right: 14, bottom: 38, left: 44 }
  const minPw = nBins * N * 8
  const W     = Math.max(420, mx.left + mx.right + minPw)
  const pw    = W - mx.left - mx.right
  const ph    = H - mx.top  - mx.bottom

  const globalLogMin = Math.min(...results.map(r => r.logMin))
  const globalLogMax = Math.max(...results.map(r => r.logMax))
  const logRange     = globalLogMax - globalLogMin

  const textColor = mapTheme === 'light' ? '#1c1c1e' : 'rgba(235,235,245,0.86)'
  const gridColor = mapTheme === 'light' ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)'
  const bgColor   = mapTheme === 'light' ? '#f2f2f7' : '#2c2c2e'

  const bars = []
  results.forEach((result, aIdx) => {
    const { bins, logMin, step } = result
    const maxBin = Math.max(...bins, 1)
    bins.forEach((count, bIdx) => {
      const binX = mx.left + (logMin + bIdx * step - globalLogMin) / logRange * pw
      const binW = step / logRange * pw
      const subW = binW / N
      const bh   = (count / maxBin) * ph
      if (bh <= 0) return
      bars.push(
        <rect key={`${aIdx}-${bIdx}`}
              x={binX + aIdx * subW + 0.5}
              y={mx.top + ph - bh}
              width={Math.max(0, subW - 1)}
              height={bh}
              fill={AREA_COLORS[aIdx % AREA_COLORS.length]}
              opacity="0.85" />
      )
    })
  })

  const xTicks = []
  for (let exp = Math.ceil(globalLogMin); exp <= Math.floor(globalLogMax); exp++) {
    const x   = mx.left + ((exp - globalLogMin) / logRange) * pw
    const val = Math.round(10 ** exp)
    const label = val >= 1e6 ? `${val / 1e6}M` : val >= 1e3 ? `${val / 1e3}k` : String(val)
    xTicks.push({ x, label })
  }

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
         xmlns="http://www.w3.org/2000/svg"
         style={{ display: 'block', background: bgColor, borderRadius: 4 }}>

      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const y = mx.top + ph * (1 - f)
        return <line key={f} x1={mx.left} x2={mx.left + pw} y1={y} y2={y}
                     stroke={f === 0 ? textColor : gridColor}
                     strokeWidth={f === 0 ? 1 : 0.5} />
      })}

      {bars}

      <line x1={mx.left} x2={mx.left} y1={mx.top} y2={mx.top + ph}
            stroke={textColor} strokeWidth={1} />

      {[0, 25, 50, 75, 100].map(pct => {
        const y = mx.top + ph * (1 - pct / 100)
        return (
          <g key={pct}>
            <line x1={mx.left - 4} x2={mx.left} y1={y} y2={y}
                  stroke={textColor} strokeWidth={1} />
            <text x={mx.left - 6} y={y + 3} textAnchor="end"
                  fontSize={9} fill={textColor}>{pct}%</text>
          </g>
        )
      })}

      <text x={10} y={mx.top + ph / 2} textAnchor="middle"
            fontSize={9} fill={textColor}
            transform={`rotate(-90 10 ${mx.top + ph / 2})`}>% of peak</text>

      {xTicks.map(({ x, label }) => (
        <g key={label}>
          <line x1={x} x2={x} y1={mx.top + ph} y2={mx.top + ph + 4}
                stroke={textColor} strokeWidth={1} />
          <text x={x} y={mx.top + ph + 14} textAnchor="middle"
                fontSize={9} fill={textColor}>{label}</text>
        </g>
      ))}

      <text x={mx.left + pw / 2} y={H - 3} textAnchor="middle"
            fontSize={9} fill={textColor}>value (log&#x2081;&#x2080;)</text>

      {results.map((_, i) => {
        const lx = W - mx.right - 24
        const ly = mx.top + 2 + i * 13
        return (
          <g key={i}>
            <rect x={lx} y={ly} width={10} height={10}
                  fill={AREA_COLORS[i % AREA_COLORS.length]} opacity="0.75" rx={2} />
            <text x={lx + 13} y={ly + 9} fontSize={9} fill={textColor}>
              {String.fromCharCode(65 + i)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export const PmarComparisonModal = forwardRef(function PmarComparisonModal(
  { results, mapTheme, onClose, onRemoveArea, stackIndex = 0 }, ref
) {
  const { t } = useLang()
  const c      = t.toolsPanel
  const svgRef = useRef(null)

  const [names, setNames] = useState(() =>
    results.map((_, i) => String.fromCharCode(65 + i))
  )

  // keep names in sync when new areas are added
  useEffect(() => {
    setNames(prev => {
      if (results.length <= prev.length) return prev
      return [
        ...prev,
        ...results.slice(prev.length).map((_, i) => String.fromCharCode(65 + prev.length + i)),
      ]
    })
  }, [results.length])

  function handleRemoveArea(i) {
    setNames(prev => prev.filter((_, j) => j !== i))
    onRemoveArea(i)
  }

  function handleRename(i, val) {
    setNames(prev => prev.map((n, j) => j === i ? val : n))
  }

  function fmtArea(r) {
    const dLat   = r.snapLatMax - r.snapLatMin
    const dLon   = r.snapLonMax - r.snapLonMin
    const latMid = (r.snapLatMin + r.snapLatMax) / 2
    const km2    = Math.abs(dLat * dLon * 111.32 * 111.32 * Math.cos(latMid * Math.PI / 180))
    return km2 >= 10 ? `~${Math.round(km2)} km²` : `~${km2.toFixed(1)} km²`
  }

  // Tabella lunga (area, classe): stessi dati del grafico, pronti per pandas o R.
  function downloadCsv() {
    if (!results.length) return
    saveText(comparisonCsv(results, names, results[0].meta), `pmar_comparison_${Date.now()}.csv`)
  }

  const hasChart = results.length >= 2

  return (
    <FloatingWindow ref={ref} title={c.comparisonTitle} onClose={onClose} stackIndex={stackIndex} width={440}>
      <Box px="sm" pt="xs" pb={6}>
        {results.length === 0 ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.comparisonAddHint}</Text>
        ) : (
          <Box mb="xs">
            {results.map((r, i) => (
              <Group key={i} gap={6} mb={4} wrap="nowrap" align="center">
                <ColorSwatch color={AREA_COLORS[i % AREA_COLORS.length]} size={10} style={{ flexShrink: 0 }} />
                <input
                  className="fw-cancel"
                  value={names[i] ?? String.fromCharCode(65 + i)}
                  onChange={e => handleRename(i, e.target.value)}
                  style={{
                    flex: '1 1 60px',
                    minWidth: 60,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--modal-divider)',
                    color: 'var(--text-primary)',
                    fontSize: 10,
                    padding: '1px 3px',
                    outline: 'none',
                    cursor: 'text',
                  }}
                />
                <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>
                  {r.total.toLocaleString()} · {fmtArea(r)}
                </Text>
                <ActionIcon
                  className="fw-cancel"
                  size="xs" variant="subtle" c="dimmed"
                  onClick={() => handleRemoveArea(i)}
                >
                  <IconX size={11} />
                </ActionIcon>
              </Group>
            ))}
          </Box>
        )}

        {results.length === 1 && (
          <Text size="xs" c="dimmed" ta="center" mb="xs">{c.comparisonNeedMore}</Text>
        )}

        {hasChart && (
          <>
            <ComparisonSVG results={results} mapTheme={mapTheme} svgRef={svgRef} />
            <Button
              fullWidth size="xs" variant="light" color="blue" mt="xs"
              leftSection={<IconDownload size={12} />}
              onClick={downloadCsv}
            >
              {c.downloadCsv}
            </Button>
          </>
        )}
      </Box>
    </FloatingWindow>
  )
})
