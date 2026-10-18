import { forwardRef, useEffect, useRef } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { Button, Text, Box, Group } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { histogramCsv } from '../export/pmarTools'
import { saveText } from '../export/download'
import { FloatingWindow } from './FloatingWindow'

// ── Histogram computation ─────────────────────────────────────────────────────

function computeHistogram(rasterValues, colMin, colMax, rowMin, rowMax, vmin, vmax, nBins = 20) {
  const logMin = Math.log10(Math.max(vmin, 1e-12))
  const logMax = Math.log10(Math.max(vmax, 1e-10))
  if (logMin >= logMax) return null
  const step = (logMax - logMin) / nBins
  const bins = Array(nBins).fill(0)
  let noData = 0, total = 0, sum = 0, valMin = Infinity, valMax = -Infinity

  for (let r = rowMin; r <= rowMax; r++) {
    for (let c = colMin; c <= colMax; c++) {
      const v = rasterValues[r]?.[c]
      if (!v || v <= 0 || !isFinite(v)) { noData++; continue }
      total++
      sum += v
      if (v < valMin) valMin = v
      if (v > valMax) valMax = v
      const idx = Math.min(nBins - 1, Math.max(0, Math.floor((Math.log10(v) - logMin) / step)))
      bins[idx]++
    }
  }

  return {
    bins, total, noData, nBins, logMin, logMax, step,
    valMin: total > 0 ? valMin : 0,
    valMax: total > 0 ? valMax : 0,
    mean:   total > 0 ? sum / total : 0,
  }
}

// ── Snap selection to raster cell grid ───────────────────────────────────────

function snapBounds(latStart, lonStart, latEnd, lonEnd, rd) {
  const { raster_lon_min, raster_lat_min, raster_res, raster_nx, raster_ny } = rd
  const lonMin = Math.min(lonStart, lonEnd)
  const lonMax = Math.max(lonStart, lonEnd)
  const latMin = Math.min(latStart, latEnd)
  const latMax = Math.max(latStart, latEnd)
  const half   = raster_res / 2

  const colMin = Math.max(0,          Math.floor((lonMin - raster_lon_min + half) / raster_res))
  const colMax = Math.min(raster_nx - 1, Math.floor((lonMax - raster_lon_min + half) / raster_res))
  const rowMin = Math.max(0,          Math.floor((latMin - raster_lat_min + half) / raster_res))
  const rowMax = Math.min(raster_ny - 1, Math.floor((latMax - raster_lat_min + half) / raster_res))

  return {
    colMin, colMax, rowMin, rowMax,
    snapLatMin: raster_lat_min + rowMin * raster_res - half,
    snapLatMax: raster_lat_min + rowMax * raster_res + half,
    snapLonMin: raster_lon_min + colMin * raster_res - half,
    snapLonMax: raster_lon_min + colMax * raster_res + half,
  }
}

// ── Drawing layer — goes inside MapContainer ──────────────────────────────────

export function HistogramDrawLayer({ active, rasterData, onResult }) {
  const map = useMap()

  const activeRef   = useRef(active)
  const rasterRef   = useRef(rasterData)
  const onResultRef = useRef(onResult)
  useEffect(() => { activeRef.current   = active     }, [active])
  useEffect(() => { rasterRef.current   = rasterData }, [rasterData])
  useEffect(() => { onResultRef.current = onResult   }, [onResult])

  const inProgressRef = useRef(null)
  const stateRef = useRef({ drawing: false, start: null })

  function clearInProgress() {
    inProgressRef.current?.remove()
    inProgressRef.current = null
  }

  useEffect(() => {
    if (active) {
      clearInProgress()
      stateRef.current = { drawing: false, start: null }
      map.getContainer().style.cursor = 'crosshair'
    } else {
      if (stateRef.current.drawing) {
        map.dragging.enable()
        stateRef.current.drawing = false
      }
      map.getContainer().style.cursor = ''
      clearInProgress()
    }
    return () => {
      map.dragging.enable()
      map.getContainer().style.cursor = ''
    }
  }, [active, map])

  useMapEvents({
    mousedown(e) {
      if (!activeRef.current) return
      map.dragging.disable()
      stateRef.current.drawing = true
      stateRef.current.start   = e.latlng
      clearInProgress()
    },

    mousemove(e) {
      if (!activeRef.current || !stateRef.current.drawing || !rasterRef.current) return
      const s = stateRef.current.start
      const { snapLatMin, snapLatMax, snapLonMin, snapLonMax } =
        snapBounds(s.lat, s.lng, e.latlng.lat, e.latlng.lng, rasterRef.current)
      const snappedBounds = [[snapLatMin, snapLonMin], [snapLatMax, snapLonMax]]
      if (inProgressRef.current) {
        inProgressRef.current.setBounds(snappedBounds)
      } else {
        inProgressRef.current = L.rectangle(snappedBounds, {
          color: '#0a84ff', fillColor: '#64d2ff',
          fillOpacity: 0.15, weight: 2, dashArray: '5 4',
        }).addTo(map)
      }
    },

    mouseup(e) {
      if (!activeRef.current || !stateRef.current.drawing) return
      map.dragging.enable()
      stateRef.current.drawing = false

      const rd = rasterRef.current
      if (!rd) return
      const s = stateRef.current.start
      stateRef.current.start = null

      const snap = snapBounds(s.lat, s.lng, e.latlng.lat, e.latlng.lng, rd)
      const { colMin, colMax, rowMin, rowMax } = snap

      if (colMax < colMin || rowMax < rowMin) { clearInProgress(); return }

      inProgressRef.current?.setStyle({ dashArray: null, fillOpacity: 0.10 })
      const confirmedLayer = inProgressRef.current
      inProgressRef.current = null

      const result = computeHistogram(rd.raster_values, colMin, colMax, rowMin, rowMax, rd.vmin, rd.vmax)
      if (result) {
        onResultRef.current(
          {
            ...result,
            snapLatMin: snap.snapLatMin, snapLatMax: snap.snapLatMax,
            snapLonMin: snap.snapLonMin, snapLonMax: snap.snapLonMax,
            nCellsTotal: (colMax - colMin + 1) * (rowMax - rowMin + 1),
          },
          confirmedLayer,
        )
      }
    },
  })

  return null
}

// ── SVG histogram chart ───────────────────────────────────────────────────────

function HistogramSVG({ result, mapTheme, svgRef }) {
  const { bins, nBins, logMin, logMax } = result
  const W = 360, H = 190
  const mx = { top: 14, right: 14, bottom: 36, left: 44 }
  const pw  = W - mx.left - mx.right
  const ph  = H - mx.top  - mx.bottom
  const barW = pw / nBins
  const maxBin = Math.max(...bins, 1)

  const textColor = mapTheme === 'light' ? '#1c1c1e' : 'rgba(235,235,245,0.86)'
  const gridColor = mapTheme === 'light' ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.08)'
  const bgColor   = mapTheme === 'light' ? '#f2f2f7' : '#2c2c2e'

  const xTicks = []
  for (let exp = Math.ceil(logMin); exp <= Math.floor(logMax); exp++) {
    const x = mx.left + ((exp - logMin) / (logMax - logMin)) * pw
    const val = Math.round(10 ** exp)
    const label = val >= 1e6 ? `${val / 1e6}M` : val >= 1e3 ? `${val / 1e3}k` : String(val)
    xTicks.push({ x, label })
  }

  function fmtCount(v) {
    if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(v % 1e3 === 0 ? 0 : 1)}k`
    return String(v)
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1]
    .map(f => Math.round(f * maxBin))
    .filter((v, i, a) => a.indexOf(v) === i && isFinite(v))

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
         xmlns="http://www.w3.org/2000/svg"
         style={{ display: 'block', background: bgColor, borderRadius: 4 }}>

      {/* horizontal grid */}
      {[0.25, 0.5, 0.75, 1].map(f => {
        const y = mx.top + ph * (1 - f)
        return <line key={f} x1={mx.left} x2={mx.left + pw} y1={y} y2={y}
                     stroke={gridColor} strokeWidth={0.5} />
      })}

      {/* bars */}
      {bins.map((count, i) => {
        const bh = (count / maxBin) * ph
        return (
          <rect key={i}
                x={mx.left + i * barW + 0.5}
                y={mx.top + ph - bh}
                width={Math.max(0, barW - 1)}
                height={bh}
                fill="#0a84ff" opacity="0.85" />
        )
      })}

      {/* axes */}
      <line x1={mx.left} x2={mx.left + pw} y1={mx.top + ph} y2={mx.top + ph}
            stroke={textColor} strokeWidth={1} />
      <line x1={mx.left} x2={mx.left} y1={mx.top} y2={mx.top + ph}
            stroke={textColor} strokeWidth={1} />

      {/* X ticks */}
      {xTicks.map(({ x, label }) => (
        <g key={label}>
          <line x1={x} x2={x} y1={mx.top + ph} y2={mx.top + ph + 4}
                stroke={textColor} strokeWidth={1} />
          <text x={x} y={mx.top + ph + 14} textAnchor="middle"
                fontSize={9} fill={textColor}>{label}</text>
        </g>
      ))}

      {/* Y ticks */}
      {yTicks.map(v => {
        const y = mx.top + ph - (v / maxBin) * ph
        return (
          <g key={v}>
            <line x1={mx.left - 4} x2={mx.left} y1={y} y2={y}
                  stroke={textColor} strokeWidth={1} />
            <text x={mx.left - 6} y={y + 3} textAnchor="end"
                  fontSize={9} fill={textColor}>{fmtCount(v)}</text>
          </g>
        )
      })}

      {/* axis labels */}
      <text x={mx.left + pw / 2} y={H - 3} textAnchor="middle"
            fontSize={9} fill={textColor}>value (log&#x2081;&#x2080;)</text>
      <text x={10} y={mx.top + ph / 2} textAnchor="middle"
            fontSize={9} fill={textColor}
            transform={`rotate(-90 10 ${mx.top + ph / 2})`}>cells</text>
    </svg>
  )
}

// ── Modal (outside MapContainer) ──────────────────────────────────────────────

function formatVal(v) {
  if (!isFinite(v) || v === 0) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  if (v >= 10)  return Math.round(v).toString()
  return v.toFixed(2)
}

export const PmarHistogramModal = forwardRef(function PmarHistogramModal({ result, mapTheme, onClose, stackIndex = 0 }, ref) {
  const { t } = useLang()
  const c      = t.pmarControls
  const svgRef = useRef(null)

  const dLat    = result.snapLatMax - result.snapLatMin
  const dLon    = result.snapLonMax - result.snapLonMin
  const latMid  = (result.snapLatMin + result.snapLatMax) / 2
  const areaKm2 = Math.abs(dLat * dLon * 111.32 * 111.32 * Math.cos(latMid * Math.PI / 180))
  const areaStr = areaKm2 >= 10 ? `~${Math.round(areaKm2)} km²` : `~${areaKm2.toFixed(1)} km²`

  // Classi con i loro limiti e conteggi, più il contesto: un dato riusabile, non un'immagine.
  function downloadCsv() {
    saveText(histogramCsv(result, result.meta), `pmar_histogram_${Date.now()}.csv`)
  }

  return (
    <FloatingWindow ref={ref} title={c.histogramTitle} onClose={onClose} stackIndex={stackIndex} width={392}>
      <Box px="sm" pt="xs" pb={6}>
        {result.total === 0 ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.histogramNoData}</Text>
        ) : (
          <>
            <Group gap={4} wrap="wrap" mb="xs" style={{ opacity: 0.65 }}>
              <Text size="10px">{result.total.toLocaleString()} {c.histogramCells}</Text>
              <Text size="10px" c="dimmed">·</Text>
              <Text size="10px">{areaStr}</Text>
              <Text size="10px" c="dimmed">·</Text>
              <Text size="10px">min {formatVal(result.valMin)}</Text>
              <Text size="10px" c="dimmed">·</Text>
              <Text size="10px">max {formatVal(result.valMax)}</Text>
              <Text size="10px" c="dimmed">·</Text>
              <Text size="10px">μ {formatVal(result.mean)}</Text>
            </Group>
            <HistogramSVG result={result} mapTheme={mapTheme} svgRef={svgRef} />
            <Button
              fullWidth size="xs" variant="light" color="blue" mt="xs"
              leftSection={<IconDownload size={12} />}
              onClick={downloadCsv}
            >
              {t.toolsPanel.downloadCsv}
            </Button>
          </>
        )}
      </Box>
    </FloatingWindow>
  )
})

// ── Connector line (outside MapContainer) ─────────────────────────────────────

export function MapRefSetter({ mapRef }) {
  const map = useMap()
  useEffect(() => { mapRef.current = map }, [map, mapRef])
  return null
}

export function ConnectorLine({ result, mapRef, modalRef }) {
  const svgRef  = useRef(null)
  const lineRef = useRef(null)
  const rafRef  = useRef(null)

  useEffect(() => {
    function tick() {
      const map   = mapRef.current
      const modal = modalRef.current
      const svg   = svgRef.current
      const line  = lineRef.current
      if (!map || !modal || !svg || !line) { rafRef.current = requestAnimationFrame(tick); return }

      const selCorners = [
        [result.snapLatMin, result.snapLonMin],
        [result.snapLatMin, result.snapLonMax],
        [result.snapLatMax, result.snapLonMin],
        [result.snapLatMax, result.snapLonMax],
      ].map(([lat, lng]) => map.latLngToContainerPoint([lat, lng]))

      const mapRect   = map.getContainer().getBoundingClientRect()
      const modalRect = modal.getBoundingClientRect()
      const modCorners = [
        { x: modalRect.left - mapRect.left,  y: modalRect.top - mapRect.top },
        { x: modalRect.right - mapRect.left, y: modalRect.top - mapRect.top },
        { x: modalRect.left - mapRect.left,  y: modalRect.bottom - mapRect.top },
        { x: modalRect.right - mapRect.left, y: modalRect.bottom - mapRect.top },
      ]

      let best = Infinity, bS, bM
      for (const sc of selCorners)
        for (const mc of modCorners) {
          const d = Math.hypot(sc.x - mc.x, sc.y - mc.y)
          if (d < best) { best = d; bS = sc; bM = mc }
        }

      const w = mapRect.width, h = mapRect.height
      svg.setAttribute('width',   w)
      svg.setAttribute('height',  h)
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
      line.setAttribute('x1', bS.x)
      line.setAttribute('y1', bS.y)
      line.setAttribute('x2', bM.x)
      line.setAttribute('y2', bM.y)

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [result, mapRef, modalRef])

  return (
    <svg ref={svgRef}
         xmlns="http://www.w3.org/2000/svg"
         style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 999 }}>
      <line ref={lineRef}
            stroke="#0a84ff" strokeWidth="1.5" strokeDasharray="5 4" opacity="0.5" />
    </svg>
  )
}

// ── Generic rectangle selection (no histogram computation) ────────────────────
// onResult(snapCoords, confirmedLayer)
// snapCoords = { colMin, colMax, rowMin, rowMax,
//                snapLatMin, snapLatMax, snapLonMin, snapLonMax, nCellsTotal }

export function RectSelectionLayer({ active, rasterData, onResult }) {
  const map = useMap()

  const activeRef   = useRef(active)
  const rasterRef   = useRef(rasterData)
  const onResultRef = useRef(onResult)
  useEffect(() => { activeRef.current   = active     }, [active])
  useEffect(() => { rasterRef.current   = rasterData }, [rasterData])
  useEffect(() => { onResultRef.current = onResult   }, [onResult])

  const inProgressRef = useRef(null)
  const stateRef = useRef({ drawing: false, start: null })

  function clearInProgress() {
    inProgressRef.current?.remove()
    inProgressRef.current = null
  }

  useEffect(() => {
    if (active) {
      clearInProgress()
      stateRef.current = { drawing: false, start: null }
      map.getContainer().style.cursor = 'crosshair'
    } else {
      if (stateRef.current.drawing) { map.dragging.enable(); stateRef.current.drawing = false }
      map.getContainer().style.cursor = ''
      clearInProgress()
    }
    return () => { map.dragging.enable(); map.getContainer().style.cursor = '' }
  }, [active, map])

  useMapEvents({
    mousedown(e) {
      if (!activeRef.current) return
      map.dragging.disable()
      stateRef.current.drawing = true
      stateRef.current.start   = e.latlng
      clearInProgress()
    },
    mousemove(e) {
      if (!activeRef.current || !stateRef.current.drawing || !rasterRef.current) return
      const s = stateRef.current.start
      const { snapLatMin, snapLatMax, snapLonMin, snapLonMax } =
        snapBounds(s.lat, s.lng, e.latlng.lat, e.latlng.lng, rasterRef.current)
      const bounds = [[snapLatMin, snapLonMin], [snapLatMax, snapLonMax]]
      if (inProgressRef.current) inProgressRef.current.setBounds(bounds)
      else inProgressRef.current = L.rectangle(bounds, {
        color: '#0a84ff', fillColor: '#64d2ff', fillOpacity: 0.15, weight: 2, dashArray: '5 4',
      }).addTo(map)
    },
    mouseup(e) {
      if (!activeRef.current || !stateRef.current.drawing) return
      map.dragging.enable()
      stateRef.current.drawing = false
      const rd = rasterRef.current
      if (!rd) return
      const s = stateRef.current.start
      stateRef.current.start = null
      const snap = snapBounds(s.lat, s.lng, e.latlng.lat, e.latlng.lng, rd)
      const { colMin, colMax, rowMin, rowMax } = snap
      if (colMax < colMin || rowMax < rowMin) { clearInProgress(); return }
      inProgressRef.current?.setStyle({ dashArray: null, fillOpacity: 0.10 })
      const confirmedLayer = inProgressRef.current
      inProgressRef.current = null
      onResultRef.current(
        { colMin, colMax, rowMin, rowMax,
          snapLatMin: snap.snapLatMin, snapLatMax: snap.snapLatMax,
          snapLonMin: snap.snapLonMin, snapLonMax: snap.snapLonMax,
          nCellsTotal: (colMax - colMin + 1) * (rowMax - rowMin + 1) },
        confirmedLayer,
      )
    },
  })

  return null
}

// ── Generic line selection (for profile tool) ─────────────────────────────────
// onResult({ latA, lonA, latB, lonB }, confirmedLayer)

export function LineSelectionLayer({ active, onResult }) {
  const map = useMap()

  const activeRef   = useRef(active)
  const onResultRef = useRef(onResult)
  useEffect(() => { activeRef.current   = active   }, [active])
  useEffect(() => { onResultRef.current = onResult }, [onResult])

  const inProgressRef = useRef(null)
  const stateRef = useRef({ drawing: false, latA: 0, lonA: 0 })

  function clearInProgress() {
    inProgressRef.current?.remove()
    inProgressRef.current = null
  }

  useEffect(() => {
    if (active) {
      clearInProgress()
      stateRef.current = { drawing: false, latA: 0, lonA: 0 }
      map.getContainer().style.cursor = 'crosshair'
    } else {
      if (stateRef.current.drawing) { map.dragging.enable(); stateRef.current.drawing = false }
      map.getContainer().style.cursor = ''
      clearInProgress()
    }
    return () => { map.dragging.enable(); map.getContainer().style.cursor = '' }
  }, [active, map])

  useMapEvents({
    mousedown(e) {
      if (!activeRef.current) return
      map.dragging.disable()
      stateRef.current.drawing = true
      stateRef.current.latA    = e.latlng.lat
      stateRef.current.lonA    = e.latlng.lng
      clearInProgress()
    },
    mousemove(e) {
      if (!activeRef.current || !stateRef.current.drawing) return
      const { latA, lonA } = stateRef.current
      const latlngs = [[latA, lonA], [e.latlng.lat, e.latlng.lng]]
      if (inProgressRef.current) inProgressRef.current.setLatLngs(latlngs)
      else inProgressRef.current = L.polyline(latlngs, {
        color: '#0a84ff', weight: 2.5, dashArray: '6 4',
      }).addTo(map)
    },
    mouseup(e) {
      if (!activeRef.current || !stateRef.current.drawing) return
      map.dragging.enable()
      stateRef.current.drawing = false
      const { latA, lonA } = stateRef.current
      const latB = e.latlng.lat, lonB = e.latlng.lng
      if (Math.abs(latA - latB) < 1e-9 && Math.abs(lonA - lonB) < 1e-9) {
        clearInProgress(); return
      }
      inProgressRef.current?.setStyle({ dashArray: null })
      const confirmedLayer = inProgressRef.current
      inProgressRef.current = null
      onResultRef.current({ latA, lonA, latB, lonB }, confirmedLayer)
    },
  })

  return null
}

// ── Helper: compute histogram from snap coords + rasterData ──────────────────
export function computeHistogramFromSnap(snap, rd) {
  return computeHistogram(
    rd.raster_values, snap.colMin, snap.colMax, snap.rowMin, snap.rowMax,
    rd.vmin, rd.vmax,
  )
}
