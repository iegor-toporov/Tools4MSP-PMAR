import { forwardRef, useRef } from 'react'
import { Button, Text, Box } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { cellCenter, cellId, profileCsv } from '../export/pmarTools'
import { saveText } from '../export/download'
import { FloatingWindow } from './FloatingWindow'

// ── Profile sampling ──────────────────────────────────────────────────────────

export function sampleProfile(latA, lonA, latB, lonB, rd, nSamples = 300) {
  const { raster_values, raster_lon_min, raster_lat_min, raster_res, raster_nx, raster_ny } = rd
  const cosLat = Math.cos(latA * Math.PI / 180)
  const pts    = []

  for (let i = 0; i <= nSamples; i++) {
    const t   = i / nSamples
    const lat = latA + t * (latB - latA)
    const lon = lonA + t * (lonB - lonA)
    const col = Math.round((lon - raster_lon_min) / raster_res)
    const row = Math.round((lat - raster_lat_min) / raster_res)
    if (col < 0 || col >= raster_nx || row < 0 || row >= raster_ny) continue
    const v    = raster_values[row]?.[col] ?? 0
    const dist = Math.hypot((lat - latA) * 111.32, (lon - lonA) * 111.32 * cosLat)
    // Posizione del campione e id della cella che lo contiene, per l'export.
    const centre = cellCenter(rd, row, col)
    pts.push({ dist, value: v, lat, lon, cellId: cellId(centre.lon, centre.lat, raster_res) })
  }

  return { pts, totalDist: pts.at(-1)?.dist ?? 0, latA, lonA, latB, lonB }
}

// ── SVG line chart ────────────────────────────────────────────────────────────

function ProfileSVG({ result, mapTheme, svgRef }) {
  const { pts, totalDist } = result
  const W = 380, H = 190
  const mx = { top: 14, right: 14, bottom: 36, left: 44 }
  const pw  = W - mx.left - mx.right
  const ph  = H - mx.top  - mx.bottom

  const textColor = mapTheme === 'light' ? '#1c1c1e' : 'rgba(235,235,245,0.86)'
  const gridColor = mapTheme === 'light' ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)'
  const bgColor   = mapTheme === 'light' ? '#f2f2f7' : '#2c2c2e'

  const posValues = pts.map(p => p.value).filter(v => v > 0 && isFinite(v))
  const logMin = posValues.length ? Math.log10(Math.min(...posValues)) : 0
  const logMax = posValues.length ? Math.log10(Math.max(...posValues)) : 1
  const logRange = logMax - logMin || 1

  let d = '', penDown = false
  for (const { dist, value } of pts) {
    if (value <= 0 || !isFinite(value)) { penDown = false; continue }
    const x = mx.left + (dist / Math.max(totalDist, 1e-9)) * pw
    const t = Math.max(0, Math.min(1, (Math.log10(value) - logMin) / logRange))
    const y = mx.top + ph - t * ph
    d += penDown
      ? ` L ${x.toFixed(1)} ${y.toFixed(1)}`
      : ` M ${x.toFixed(1)} ${y.toFixed(1)}`
    penDown = true
  }

  const yTicks = []
  for (let exp = Math.ceil(logMin); exp <= Math.floor(logMax); exp++) {
    const y     = mx.top + ph - ((exp - logMin) / logRange) * ph
    const val   = Math.round(10 ** exp)
    const label = val >= 1e6 ? `${val / 1e6}M` : val >= 1e3 ? `${val / 1e3}k` : String(val)
    yTicks.push({ y, label })
  }

  const xTicks = [0, 0.5, 1].map(f => ({
    x:     mx.left + f * pw,
    label: (f * totalDist).toFixed(1),
  }))

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
         xmlns="http://www.w3.org/2000/svg"
         style={{ display: 'block', background: bgColor, borderRadius: 4 }}>

      {[0.25, 0.5, 0.75, 1].map(f => {
        const y = mx.top + ph * (1 - f)
        return <line key={f} x1={mx.left} x2={mx.left + pw} y1={y} y2={y}
                     stroke={gridColor} strokeWidth={0.5} />
      })}

      {d && <path d={d} stroke="#0a84ff" strokeWidth={2} fill="none" />}

      <line x1={mx.left} x2={mx.left + pw} y1={mx.top + ph} y2={mx.top + ph}
            stroke={textColor} strokeWidth={1} />
      <line x1={mx.left} x2={mx.left} y1={mx.top} y2={mx.top + ph}
            stroke={textColor} strokeWidth={1} />

      {xTicks.map(({ x, label }) => (
        <g key={label}>
          <line x1={x} x2={x} y1={mx.top + ph} y2={mx.top + ph + 4}
                stroke={textColor} strokeWidth={1} />
          <text x={x} y={mx.top + ph + 14} textAnchor="middle"
                fontSize={9} fill={textColor}>{label}</text>
        </g>
      ))}

      {yTicks.map(({ y, label }) => (
        <g key={label}>
          <line x1={mx.left - 4} x2={mx.left} y1={y} y2={y}
                stroke={textColor} strokeWidth={1} />
          <text x={mx.left - 7} y={y + 3} textAnchor="end"
                fontSize={9} fill={textColor}>{label}</text>
        </g>
      ))}

      <text x={mx.left + pw / 2} y={H - 3} textAnchor="middle"
            fontSize={9} fill={textColor}>dist. (km)</text>
      <text x={10} y={mx.top + ph / 2} textAnchor="middle"
            fontSize={9} fill={textColor}
            transform={`rotate(-90 10 ${mx.top + ph / 2})`}>value (log&#x2081;&#x2080;)</text>
    </svg>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export const PmarProfileModal = forwardRef(function PmarProfileModal(
  { result, mapTheme, onClose, stackIndex = 0 }, ref
) {
  const { t } = useLang()
  const c      = t.toolsPanel
  const svgRef = useRef(null)

  const hasData = result.pts?.some(p => p.value > 0)

  // Un campione per riga: distanza, posizione, cella e valore lungo la linea.
  function downloadCsv() {
    saveText(profileCsv(result, result.meta), `pmar_profile_${Date.now()}.csv`)
  }

  return (
    <FloatingWindow ref={ref} title={c.profileTitle} onClose={onClose} stackIndex={stackIndex} width={360}>
      <Box px="sm" pt="xs" pb={6}>
        {!hasData ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.profileNoData}</Text>
        ) : (
          <>
            <ProfileSVG result={result} mapTheme={mapTheme} svgRef={svgRef} />
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
