import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Modal, ActionIcon, Text, Button, Group, useMantineColorScheme } from '@mantine/core'
import { IconSun, IconMoon } from '@tabler/icons-react'
import { MODEL_STYLES } from './constants'
import { useLang } from './LanguageContext'
import Panel from './components/Panel'
import SeedDrawer from './components/SeedDrawer'
import AnimationControls from './components/AnimationControls'
import PmarControls from './components/PmarControls'
import ToolsPanel from './components/ToolsPanel'
import { HistogramDrawLayer, PmarHistogramModal, MapRefSetter, ConnectorLine,
         RectSelectionLayer, LineSelectionLayer, computeHistogramFromSnap } from './components/PmarHistogram'
import { computeStats, PmarStatsModal } from './components/PmarStats'
import { PmarThresholdModal } from './components/PmarThreshold'
import { PmarComparisonModal } from './components/PmarComparison'
import { sampleProfile, PmarProfileModal } from './components/PmarProfile'
import 'leaflet/dist/leaflet.css'
import './App.css'

const STRANDED_STYLE = { color: '#ef4444', fillColor: '#fca5a5', weight: 2 }

// ── PMAR colormap helpers (replica di Spectral_r + LogNorm di matplotlib) ──────
const SPECTRAL_R = [
  [94,  79,  162], // 0.0  #5e4fa2
  [50,  136, 189], // 0.1  #3288bd
  [102, 194, 165], // 0.2  #66c2a5
  [171, 221, 164], // 0.3  #abdda4
  [230, 245, 152], // 0.4  #e6f598
  [255, 255, 191], // 0.5  #ffffbf
  [254, 224, 139], // 0.6  #fee08b
  [253, 174, 97],  // 0.7  #fdae61
  [244, 109, 67],  // 0.8  #f46d43
  [213, 62,  79],  // 0.9  #d53e4f
  [158, 1,   66],  // 1.0  #9e0142
]

function spectralR(t) {
  const n = SPECTRAL_R.length - 1
  const i = Math.min(Math.floor(t * n), n - 1)
  const f = t * n - i
  const c0 = SPECTRAL_R[i], c1 = SPECTRAL_R[i + 1]
  return [
    Math.round(c0[0] + f * (c1[0] - c0[0])),
    Math.round(c0[1] + f * (c1[1] - c0[1])),
    Math.round(c0[2] + f * (c1[2] - c0[2])),
  ]
}

function logNorm(val, vmin, vmax) {
  if (val <= 0 || !isFinite(val)) return null
  const logMin = Math.log10(Math.max(vmin, 1e-12))
  const logMax = Math.log10(vmax)
  return Math.max(0, Math.min(1, (Math.log10(val) - logMin) / (logMax - logMin)))
}

// ── Standard map-pin icon (reusable for all anthropogenic layers) ──────────────
function createPinIcon(fillColor, strokeColor) {
  const svg = `<svg width="14" height="21" viewBox="0 0 14 21" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 0C3.13 0 0 3.13 0 7c0 5.25 7 14 7 14S14 12.25 14 7c0-3.87-3.13-7-7-7z"
          fill="${fillColor}" stroke="${strokeColor}" stroke-width="1.5"/>
    <circle cx="7" cy="7" r="2.5" fill="${strokeColor}" opacity="0.6"/>
  </svg>`
  return L.divIcon({ html: svg, className: '', iconSize: [14, 21], iconAnchor: [7, 21] })
}

// ── OpenDrift trajectory layer ────────────────────────────────────────────────
function SimLayer({ simData, currentStep }) {
  const map         = useMap()
  const markersRef  = useRef([])
  const trajsRef    = useRef([])
  const rendererRef = useRef(L.canvas({ padding: 0.5 }))
  const styleRef    = useRef(MODEL_STYLES.OceanDrift)

  useEffect(() => {
    if (!simData) return

    markersRef.current.forEach(({ marker }) => marker.remove())
    trajsRef.current.forEach(l => l.remove())
    markersRef.current = []
    trajsRef.current   = []

    const { steps } = simData
    const style      = MODEL_STYLES[simData.model] ?? MODEL_STYLES.OceanDrift
    styleRef.current = style
    const nParticles = steps[0].length
    const nTime      = steps.length
    const renderer   = rendererRef.current

    for (let p = 0; p < nParticles; p++) {
      const coords = []
      for (let t = 0; t < nTime; t++) {
        const pos = steps[t][p]
        if (pos) coords.push([pos[1], pos[0]])
      }
      if (coords.length > 1)
        trajsRef.current.push(
          L.polyline(coords, { color: style.traj, opacity: 0.18, weight: 1, renderer }).addTo(map)
        )
    }

    for (let p = 0; p < nParticles; p++) {
      const pos      = steps[0][p]
      const latlng   = pos ? [pos[1], pos[0]] : [0, 0]
      const stranded = pos && pos[2] === true
      const marker   = L.circleMarker(latlng, {
        radius:      4,
        color:       stranded ? STRANDED_STYLE.color     : style.color,
        fillColor:   stranded ? STRANDED_STYLE.fillColor : style.fill,
        fillOpacity: pos ? 0.9 : 0,
        opacity:     pos ? 1   : 0,
        weight:      stranded ? STRANDED_STYLE.weight    : 1,
        renderer,
      }).addTo(map)
      markersRef.current.push({ marker, idx: p })
    }

    const allCoords = steps.flat().filter(Boolean).map(p => [p[1], p[0]])
    if (allCoords.length > 0)
      map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] })

    return () => {
      markersRef.current.forEach(({ marker }) => marker.remove())
      trajsRef.current.forEach(l => l.remove())
    }
  }, [simData, map])

  useEffect(() => {
    if (!simData || markersRef.current.length === 0) return
    const positions = simData.steps[currentStep]
    const style     = styleRef.current
    markersRef.current.forEach(({ marker, idx }) => {
      const pos = positions[idx]
      if (pos) {
        const stranded = pos[2] === true
        marker.setLatLng([pos[1], pos[0]])
        marker.setStyle({
          fillOpacity: 0.9,
          opacity:     1,
          color:       stranded ? STRANDED_STYLE.color     : style.color,
          fillColor:   stranded ? STRANDED_STYLE.fillColor : style.fill,
          weight:      stranded ? STRANDED_STYLE.weight    : 1,
        })
      } else {
        marker.setStyle({ fillOpacity: 0, opacity: 0 })
      }
    })
  }, [simData, currentStep])

  return null
}

// ── EMODnet offshore installations overlay ────────────────────────────────────
function OffshoreInstallationsLayer({ geojson, visible }) {
  const map        = useMap()
  const layerRef   = useRef(null)
  const markersRef = useRef([])

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    if (!geojson?.features?.length) return

    const icon = createPinIcon('#fed7aa', '#ea580c')

    layerRef.current = L.geoJSON(geojson, {
      style: {
        color:       '#f97316',
        fillColor:   '#fed7aa',
        fillOpacity: 0.25,
        weight:      1.5,
        opacity:     0.85,
      },
      pointToLayer: (_feature, latlng) => {
        const m = L.marker(latlng, { icon, interactive: false, zIndexOffset: 500 })
        markersRef.current.push(m)
        return m
      },
    }).addTo(map)

    geojson.features.forEach(feature => {
      const type = feature.geometry?.type
      if (type === 'Point' || type === 'MultiPoint') return
      try {
        const bounds = L.geoJSON(feature).getBounds()
        if (!bounds.isValid()) return
        const m = L.marker(bounds.getCenter(), { icon, interactive: false, zIndexOffset: 500 }).addTo(map)
        markersRef.current.push(m)
      } catch { /* geometria non valida, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, map])

  useEffect(() => {
    if (!layerRef.current) return
    layerRef.current.setStyle({ opacity: visible ? 0.85 : 0, fillOpacity: visible ? 0.25 : 0 })
    markersRef.current.forEach(m => {
      const el = m.getElement()
      if (el) el.style.opacity = visible ? '1' : '0'
    })
  }, [visible])

  return null
}

// ── EMODnet wind farms overlay ────────────────────────────────────────────────
function WindFarmsLayer({ geojson, visible }) {
  const map        = useMap()
  const layerRef   = useRef(null)
  const markersRef = useRef([])

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    if (!geojson?.features?.length) return

    const icon = createPinIcon('#fef08a', '#ca8a04')

    layerRef.current = L.geoJSON(geojson, {
      style: {
        color:       '#facc15',
        fillColor:   '#fef08a',
        fillOpacity: 0.18,
        weight:      1.5,
        opacity:     0.75,
        dashArray:   '5 4',
      },
      pointToLayer: (_feature, latlng) => {
        const m = L.marker(latlng, { icon, interactive: false, zIndexOffset: 500 })
        markersRef.current.push(m)
        return m
      },
    }).addTo(map)

    geojson.features.forEach(feature => {
      const type = feature.geometry?.type
      if (type === 'Point' || type === 'MultiPoint') return
      try {
        const bounds = L.geoJSON(feature).getBounds()
        if (!bounds.isValid()) return
        const marker = L.marker(bounds.getCenter(), {
          icon,
          interactive:  false,
          zIndexOffset: 500,
        }).addTo(map)
        markersRef.current.push(marker)
      } catch { /* geometria non valida, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, map])

  useEffect(() => {
    if (!layerRef.current) return
    layerRef.current.setStyle({
      opacity:     visible ? 0.75 : 0,
      fillOpacity: visible ? 0.18 : 0,
    })
    markersRef.current.forEach(m => {
      const el = m.getElement()
      if (el) el.style.opacity = visible ? '1' : '0'
    })
  }, [visible])

  return null
}

// ── EMODnet MSP aquaculture zones overlay ─────────────────────────────────────
function MspZonesLayer({ geojson, visible }) {
  const map        = useMap()
  const layerRef   = useRef(null)
  const markersRef = useRef([])

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []
    if (!geojson?.features?.length) return

    const icon = createPinIcon('#a5f3fc', '#0891b2')

    layerRef.current = L.geoJSON(geojson, {
      style: {
        color:       '#06b6d4',
        fillColor:   '#cffafe',
        fillOpacity: 0.25,
        weight:      1.5,
        opacity:     0.85,
        dashArray:   '6 3',
      },
      pointToLayer: (_feature, latlng) => {
        const m = L.marker(latlng, { icon, interactive: false, zIndexOffset: 500 })
        markersRef.current.push(m)
        return m
      },
    }).addTo(map)

    geojson.features.forEach(feature => {
      const type = feature.geometry?.type
      if (type === 'Point' || type === 'MultiPoint') return
      try {
        const bounds = L.geoJSON(feature).getBounds()
        if (!bounds.isValid()) return
        const m = L.marker(bounds.getCenter(), { icon, interactive: false, zIndexOffset: 500 }).addTo(map)
        markersRef.current.push(m)
      } catch { /* geometria non valida, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, map])

  useEffect(() => {
    if (!layerRef.current) return
    layerRef.current.setStyle({ opacity: visible ? 0.85 : 0, fillOpacity: visible ? 0.25 : 0 })
    markersRef.current.forEach(m => {
      const el = m.getElement()
      if (el) el.style.opacity = visible ? '1' : '0'
    })
  }, [visible])

  return null
}

// ── EMODnet Natura 2000 sites overlay ────────────────────────────────────────
function Natura2000Layer({ geojson, visible }) {
  const map      = useMap()
  const layerRef = useRef(null)

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    if (!geojson?.features?.length) return
    layerRef.current = L.geoJSON(geojson, {
      style: {
        color:       '#16a34a',
        fillColor:   '#86efac',
        fillOpacity: 0.20,
        weight:      1.5,
        opacity:     0.85,
        dashArray:   '4 3',
      },
    }).addTo(map)
    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [geojson, map])

  useEffect(() => {
    if (!layerRef.current) return
    layerRef.current.setStyle({
      opacity:     visible ? 0.85 : 0,
      fillOpacity: visible ? 0.20 : 0,
    })
  }, [visible])

  return null
}

// ── PMAR seeding area polygon layer ─────────────────────────────────────────
function SeedingAreaLayer({ geojson, visible }) {
  const map      = useMap()
  const layerRef = useRef(null)

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    if (!geojson || !visible) return
    layerRef.current = L.geoJSON(geojson, {
      style: {
        color:       '#0a84ff',
        fillColor:   '#64d2ff',
        fillOpacity: 0.12,
        weight:      2,
        opacity:     0.85,
        dashArray:   '6 4',
      },
    }).addTo(map)
    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [geojson, visible, map])

  return null
}

// ── PMAR raster overlay (canvas layer con hover per cella) ───────────────────
function PmarLayer({ pmarData, visible, passagesLabel }) {
  const map          = useMap()
  const canvasRef    = useRef(null)
  const tooltipRef   = useRef(null)
  const labelRef     = useRef(passagesLabel)
  labelRef.current   = passagesLabel
  const visibleRef   = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    if (!pmarData?.raster_values || !pmarData.bounds) return

    const {
      raster_values, vmin, vmax,
      raster_lon_min, raster_lat_min, raster_res,
      raster_nx, raster_ny,
    } = pmarData

    const canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide')
    canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane.appendChild(canvas)
    canvasRef.current = canvas

    const tooltip = document.createElement('div')
    tooltip.className = 'pmar-cell-tooltip'
    tooltip.style.display = 'none'
    map.getContainer().appendChild(tooltip)
    tooltipRef.current = tooltip

    function draw() {
      const size   = map.getSize()
      canvas.width  = size.x
      canvas.height = size.y
      const origin = map.containerPointToLayerPoint([0, 0])
      L.DomUtil.setPosition(canvas, origin)

      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, size.x, size.y)
      const ox = origin.x, oy = origin.y

      for (let row = 0; row < raster_ny; row++) {
        const rowData = raster_values[row]
        for (let col = 0; col < raster_nx; col++) {
          const val = rowData[col]
          if (!val || val <= 0) continue

          const lat = raster_lat_min + row * raster_res
          const lon = raster_lon_min + col * raster_res
          const half = raster_res / 2

          const sw = map.latLngToLayerPoint([lat - half, lon - half])
          const ne = map.latLngToLayerPoint([lat + half, lon + half])

          const x = ne.x - ox, y = ne.y - oy
          const w = sw.x - ne.x, h = sw.y - ne.y
          if (x + w < 0 || y + h < 0 || x > size.x || y > size.y) continue

          const t = logNorm(val, vmin, vmax)
          if (t === null) continue
          const [r, g, b] = spectralR(t)
          ctx.fillStyle = `rgba(${r},${g},${b},0.82)`
          ctx.fillRect(x, y, w, h)
        }
      }
    }

    function onMouseMove(e) {
      const { lat, lng } = e.latlng
      const col = Math.floor((lng - raster_lon_min + raster_res / 2) / raster_res)
      const row = Math.floor((lat - raster_lat_min + raster_res / 2) / raster_res)

      if (col >= 0 && col < raster_nx && row >= 0 && row < raster_ny) {
        const val = raster_values[row][col]
        if (val > 0) {
          const latC = (raster_lat_min + row * raster_res).toFixed(3)
          const lonC = (raster_lon_min + col * raster_res).toFixed(3)
          const dispVal = val >= 1 ? Math.round(val) : val.toFixed(3)
          const decimals = Math.max(0, Math.ceil(-Math.log10(raster_res)) + 1)
          const latID = (raster_lat_min + row * raster_res).toFixed(decimals)
          const lonID = (raster_lon_min + col * raster_res).toFixed(decimals)
          const cellId = `${lonID}E_${latID}N`
          tooltip.innerHTML =
            `<b>${dispVal}</b> ${labelRef.current}` +
            `<br><span>${latC}° N · ${lonC}° E</span>` +
            `<br><span class="pmar-cell-id">ID: ${cellId}</span>`
          tooltip.style.display = 'block'
          tooltip.style.left = (e.containerPoint.x + 14) + 'px'
          tooltip.style.top  = (e.containerPoint.y - 44) + 'px'
          return
        }
      }
      tooltip.style.display = 'none'
    }

    map.on('moveend zoomend resize', draw)
    map.on('mousemove', onMouseMove)
    map.on('mouseout',  () => { tooltip.style.display = 'none' })
    draw()
    canvas.style.display = visibleRef.current ? '' : 'none'

    return () => {
      map.getPanes().overlayPane.removeChild(canvas)
      map.getContainer().removeChild(tooltip)
      map.off('moveend zoomend resize', draw)
      map.off('mousemove', onMouseMove)
      canvasRef.current  = null
      tooltipRef.current = null
    }
  }, [pmarData, map])

  useEffect(() => {
    if (canvasRef.current)
      canvasRef.current.style.display = visible ? '' : 'none'
    if (!visible && tooltipRef.current)
      tooltipRef.current.style.display = 'none'
  }, [visible])

  return null
}

// ── Seed shape → GeoJSON ──────────────────────────────────────────────────────
function seedShapeToGeoJSON(shape) {
  if (!shape) return null
  if (shape.type === 'circle') {
    const { lon, lat, radius } = shape
    const N      = 64
    const coords = []
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * 2 * Math.PI
      const dLat  = (radius / 111320) * Math.cos(angle)
      const dLon  = (radius / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle)
      coords.push([lon + dLon, lat + dLat])
    }
    coords.push(coords[0])
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {},
      }],
    }
  }
  const { lon_min, lat_min, lon_max, lat_max } = shape
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon_min, lat_min], [lon_max, lat_min],
          [lon_max, lat_max], [lon_min, lat_max],
          [lon_min, lat_min],
        ]],
      },
      properties: {},
    }],
  }
}

function seedShapeBounds(shape) {
  if (!shape) return null
  if (shape.type === 'circle') {
    const { lon, lat, radius } = shape
    const dLat = radius / 111320
    const dLon = radius / (111320 * Math.cos(lat * Math.PI / 180))
    return { lon_min: lon - dLon, lat_min: lat - dLat, lon_max: lon + dLon, lat_max: lat + dLat }
  }
  const { lon_min, lat_min, lon_max, lat_max } = shape
  return { lon_min, lat_min, lon_max, lat_max }
}

// ── Histogram instance (one per drawn selection) ─────────────────────────────
function HistogramEntry({ histogram, mapRef, mapTheme, onClose, stackIndex }) {
  const modalRef = useRef(null)
  return (
    <>
      <ConnectorLine result={histogram.result} mapRef={mapRef} modalRef={modalRef} />
      <PmarHistogramModal
        ref={modalRef}
        result={histogram.result}
        mapTheme={mapTheme}
        onClose={onClose}
        stackIndex={stackIndex}
      />
    </>
  )
}

function StatsEntry({ entry, mapRef, mapTheme, onClose, stackIndex }) {
  const modalRef = useRef(null)
  return (
    <>
      <ConnectorLine result={entry.result} mapRef={mapRef} modalRef={modalRef} />
      <PmarStatsModal ref={modalRef} result={entry.result}
                      mapTheme={mapTheme} onClose={onClose} stackIndex={stackIndex} />
    </>
  )
}

function ThresholdEntry({ entry, mapRef, mapTheme, onClose, stackIndex }) {
  const modalRef = useRef(null)
  return (
    <>
      <ConnectorLine result={entry.result} mapRef={mapRef} modalRef={modalRef} />
      <PmarThresholdModal ref={modalRef} result={entry.result}
                          mapTheme={mapTheme} onClose={onClose} stackIndex={stackIndex} />
    </>
  )
}

function ProfileEntry({ entry, mapRef, mapTheme, onClose, stackIndex }) {
  const modalRef = useRef(null)
  return (
    <>
      <ConnectorLine result={entry.result} mapRef={mapRef} modalRef={modalRef} />
      <PmarProfileModal ref={modalRef} result={entry.result}
                        mapTheme={mapTheme} onClose={onClose} stackIndex={stackIndex} />
    </>
  )
}

function ComparisonView({ areas, mapRef, mapTheme, onRemoveArea, onClose }) {
  const modalRef = useRef(null)
  if (!areas.length) return null
  return (
    <>
      {areas.map(a => (
        <ConnectorLine key={a.id} result={a.result} mapRef={mapRef} modalRef={modalRef} />
      ))}
      <PmarComparisonModal
        ref={modalRef}
        results={areas.map(a => a.result)}
        mapTheme={mapTheme}
        onRemoveArea={onRemoveArea}
        onClose={onClose}
      />
    </>
  )
}

// ── Pure helper (outside component so reference is stable for useMemo) ───────
function getActivePmarData(data, indicator) {
  if (!data) return null
  if (!indicator || indicator === 'ppi') return data
  if (indicator === 'std') {
    if (!data.std_raster_values) return data
    return {
      ...data,
      raster_values:      data.std_raster_values,
      raster_lon_min:     data.std_raster_lon_min,
      raster_lat_min:     data.std_raster_lat_min,
      raster_res:         data.std_raster_res,
      raster_nx:          data.std_raster_nx,
      raster_ny:          data.std_raster_ny,
      colorbar_b64:       data.std_colorbar_b64,
      colorbar_light_b64: data.std_colorbar_light_b64,
      vmin:               data.std_vmin,
      vmax:               data.std_vmax,
    }
  }
  const k = indicator
  if (!data[`${k}_raster_values`]) return data
  return {
    ...data,
    raster_values:       data[`${k}_raster_values`],
    raster_lon_min:      data[`${k}_raster_lon_min`],
    raster_lat_min:      data[`${k}_raster_lat_min`],
    raster_res:          data[`${k}_raster_res`],
    raster_nx:           data[`${k}_raster_nx`],
    raster_ny:           data[`${k}_raster_ny`],
    colorbar_b64:        data[`${k}_colorbar_b64`],
    colorbar_light_b64:  data[`${k}_colorbar_light_b64`],
    vmin:                data[`${k}_vmin`],
    vmax:                data[`${k}_vmax`],
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const { t, lang, toggle } = useLang()
  const { setColorScheme } = useMantineColorScheme()

  const [activeTool, setActiveTool] = useState('opendrift')
  const [mapTheme,   setMapTheme]   = useState('light')

  const [drawMode,            setDrawMode]            = useState(null)
  const [seedShape,           setSeedShape]           = useState(null)
  const [showSeedShape,       setShowSeedShape]       = useState(true)
  const [t4mspPreviewGeoJSON, setT4mspPreviewGeoJSON] = useState(null)

  const [simData,     setSimData]     = useState(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isPlaying,   setIsPlaying]   = useState(false)
  const [speed,       setSpeed]       = useState(5)
  const [loading,            setLoading]            = useState(false)
  const [openDriftJobId,     setOpenDriftJobId]     = useState(null)
  const [openDriftStopping,  setOpenDriftStopping]  = useState(false)
  const [status,             setStatus]             = useState('')
  const [statusType,         setStatusType]         = useState('')

  const [pmarData,        setPmarData]        = useState(null)
  const [pmarLoading,     setPmarLoading]     = useState(false)
  const [pmarJobId,       setPmarJobId]       = useState(null)
  const [pmarStopping,    setPmarStopping]    = useState(false)
  const [pmarStatus,      setPmarStatus]      = useState('')
  const [pmarStatusType,  setPmarStatusType]  = useState('')
  const [pmarErrorMsg,    setPmarErrorMsg]    = useState(null)
  const [showPmarRaster,   setShowPmarRaster]   = useState(true)
  const [showWindFarms,    setShowWindFarms]    = useState(true)
  const [mspZonesPreview, setMspZonesPreview] = useState(null)
  const [mspZonesLoading, setMspZonesLoading] = useState(false)
  const [mspZonesEmpty,   setMspZonesEmpty]   = useState(false)
  const [showMspZones,    setShowMspZones]    = useState(true)
  const [activeIndicator,  setActiveIndicator]  = useState('ppi')
  const [activeMapTool,     setActiveMapTool]     = useState(null)
  const [histograms,        setHistograms]        = useState([])
  const [statsEntries,      setStatsEntries]      = useState([])
  const [profileEntries,    setProfileEntries]    = useState([])
  const [thresholdEntries,  setThresholdEntries]  = useState([])
  const [comparisonAreas,   setComparisonAreas]   = useState([])
  const mapRef = useRef(null)

  const toggleTool = (tool) =>
    setActiveMapTool(prev => prev === tool ? null : tool)

  const [useSource,        setUseSource]        = useState('none')
  const [windfarmsPreview, setWindfarmsPreview] = useState(null)
  const [windfarmsLoading, setWindfarmsLoading] = useState(false)
  const [windfarmsEmpty,   setWindfarmsEmpty]   = useState(false)
  const [offshorePreview,  setOffshorePreview]  = useState(null)
  const [offshoreLoading,  setOffshoreLoading]  = useState(false)
  const [offshoreEmpty,    setOffshoreEmpty]    = useState(false)
  const [showOffshoreInstallations, setShowOffshoreInstallations] = useState(true)

  const [natura2000Geojson, setNatura2000Geojson] = useState(null)
  const [showNatura2000,    setShowNatura2000]    = useState(true)
  const [natura2000Loading, setNatura2000Loading] = useState(false)
  const [natura2000Empty,   setNatura2000Empty]   = useState(false)

  const windfarmsGeoJSON = pmarData?.windfarms_geojson ?? windfarmsPreview
  const offshoreGeoJSON  = pmarData?.offshore_geojson  ?? offshorePreview
  const mspZonesGeoJSON  = pmarData?.msp_zones_geojson ?? mspZonesPreview

  const timerRef = useRef(null)

  // ── Wind farms preview fetch ───────────────────────────────────────────────
  useEffect(() => {
    if (useSource !== 'windfarms' || !seedShape) {
      setWindfarmsPreview(null)
      return
    }
    const bounds = seedShapeBounds(seedShape)
    if (!bounds) return

    setWindfarmsPreview(null)
    setWindfarmsEmpty(false)
    setWindfarmsLoading(true)
    fetch('/processes/windfarms/execution', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ inputs: bounds }),
    })
      .then(r => r.json())
      .then(raw => {
        const data = raw.result ?? raw
        if (data?.features?.length > 0) {
          setWindfarmsPreview(data)
        } else {
          setWindfarmsEmpty(true)
        }
      })
      .catch(() => { setWindfarmsEmpty(true) })
      .finally(() => setWindfarmsLoading(false))
  }, [useSource, seedShape])

  // ── Offshore installations preview fetch ───────────────────────────────────
  useEffect(() => {
    if (useSource !== 'offshore_installations' || !seedShape) {
      setOffshorePreview(null)
      return
    }
    const bounds = seedShapeBounds(seedShape)
    if (!bounds) return

    setOffshorePreview(null)
    setOffshoreEmpty(false)
    setOffshoreLoading(true)
    fetch('/processes/offshore_installations/execution', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ inputs: bounds }),
    })
      .then(r => r.json())
      .then(raw => {
        const data = raw.result ?? raw
        if (data?.features?.length > 0) {
          setOffshorePreview(data)
        } else {
          setOffshoreEmpty(true)
        }
      })
      .catch(() => { setOffshoreEmpty(true) })
      .finally(() => setOffshoreLoading(false))
  }, [useSource, seedShape])

  // ── MSP zones preview fetch ────────────────────────────────────────────────
  useEffect(() => {
    if (useSource !== 'msp_zones' || !seedShape) {
      setMspZonesPreview(null)
      return
    }
    const bounds = seedShapeBounds(seedShape)
    if (!bounds) return

    setMspZonesPreview(null)
    setMspZonesEmpty(false)
    setMspZonesLoading(true)
    fetch('/processes/msp_zones/execution', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ inputs: bounds }),
    })
      .then(r => r.json())
      .then(raw => {
        const data = raw.result ?? raw
        if (data?.features?.length > 0) {
          setMspZonesPreview(data)
        } else {
          setMspZonesEmpty(true)
        }
      })
      .catch(() => { setMspZonesEmpty(true) })
      .finally(() => setMspZonesLoading(false))
  }, [useSource, seedShape])

  function handleToolChange(tool) {
    setActiveTool(tool)
    setDrawMode(null)
  }

  function handleStartDraw(mode) {
    setDrawMode(mode)
    setSeedShape(null)
  }

  function handleShapeDone(shape) {
    setSeedShape(shape)
    setDrawMode(null)
  }

  function handleClearSeedShape() {
    setSeedShape(null)
    setDrawMode(null)
  }

  const tick = useCallback(() => {
    setCurrentStep(prev => {
      if (prev >= (simData?.steps.length ?? 1) - 1) {
        setIsPlaying(false)
        return prev
      }
      return prev + 1
    })
  }, [simData])

  useEffect(() => {
    if (!isPlaying) { clearTimeout(timerRef.current); return }
    const delay = Math.max(40, 1000 / speed)
    timerRef.current = setTimeout(tick, delay)
    return () => clearTimeout(timerRef.current)
  }, [isPlaying, currentStep, speed, tick])

  function togglePlay() {
    if (!simData) return
    if (isPlaying) {
      setIsPlaying(false)
    } else {
      if (currentStep >= simData.steps.length - 1) setCurrentStep(0)
      setIsPlaying(true)
    }
  }

  async function handleRun({ model, start_time, number, duration_hours }) {
    if (!seedShape) {
      setStatus(t.status.noShape)
      setStatusType('error')
      return
    }

    const seedParams = seedShape.type === 'circle'
      ? { seeding_type: 'circle', lon: seedShape.lon, lat: seedShape.lat, radius: seedShape.radius }
      : { seeding_type: 'rectangle', lon_min: seedShape.lon_min, lat_min: seedShape.lat_min,
          lon_max: seedShape.lon_max, lat_max: seedShape.lat_max }

    setLoading(true)
    setStatus(t.status.running(t.modelLabels?.[model] ?? model))
    setStatusType('')
    setSimData(null)
    setIsPlaying(false)
    setCurrentStep(0)

    try {
      const resp = await fetch('/processes/opendrift/execution', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'respond-async' },
        body:    JSON.stringify({ inputs: { model, start_time, number, duration_hours, ...seedParams } }),
      })

      if (!resp.ok) {
        const text = await resp.text()
        let message = t.status.httpError(resp.status)
        try {
          const json = JSON.parse(text)
          if (json.description) message = json.description
        } catch { message = text.slice(0, 300) }
        throw new Error(message)
      }

      const { jobID } = await resp.json()
      setOpenDriftJobId(jobID)

      const jsonHeaders = { 'Accept': 'application/json' }

      await new Promise((resolve, reject) => {
        const iv = setInterval(async () => {
          try {
            const jobResp = await fetch(`/jobs/${jobID}`, { headers: jsonHeaders })
            const job     = await jobResp.json()
            if (job.status === 'successful') {
              clearInterval(iv)
              resolve()
            } else if (job.status === 'failed') {
              clearInterval(iv)
              reject(new Error(job.message || t.status.badResponse))
            } else if (job.status === 'dismissed') {
              clearInterval(iv)
              reject(new Error('__dismissed__'))
            }
          } catch (e) { clearInterval(iv); reject(e) }
        }, 3000)
      })

      const resResp = await fetch(`/jobs/${jobID}/results`, { headers: jsonHeaders })
      const raw     = await resResp.json()
      const data    = (raw.steps && raw.times) ? raw : (raw.trajectory ?? raw)
      if (!data.steps || !data.times) throw new Error(t.status.badResponse)

      const nParticles = data.steps[0].filter(Boolean).length
      setStatus(t.status.done(nParticles, data.times.length))
      setStatusType('ok')
      setSimData(data)
      setCurrentStep(0)
      setIsPlaying(true)

    } catch (err) {
      if (err.message !== '__dismissed__') {
        setStatus(t.status.error(err.message))
        setStatusType('error')
      }
    } finally {
      setLoading(false)
      setOpenDriftJobId(null)
      setOpenDriftStopping(false)
    }
  }

  async function handleRunPmar({ scenario_id, pressure, start_time, duration_days, pnum, res, margin, time_step_hours, shapefile_b64, geotiff_b64, geotiff_url }) {
    let inputs

    if (scenario_id) {
      inputs = { scenario_id, use_source: useSource, res, margin,
        ...(useSource === 'geotiff' && geotiff_b64  ? { geotiff_b64 }  : {}),
        ...(useSource === 'geotiff' && geotiff_url  ? { geotiff_url }  : {}),
      }
    } else {
      const geojson = shapefile_b64 ? null : seedShapeToGeoJSON(seedShape)
      if (!geojson && !shapefile_b64) {
        setPmarStatus(t.status.noShape)
        setPmarStatusType('error')
        return
      }
      inputs = {
        pressure,
        use_source: useSource,
        start_time,
        duration_days,
        pnum,
        res,
        time_step_hours,
        ...(geojson       ? { geojson: JSON.stringify(geojson) } : {}),
        ...(shapefile_b64 ? { shapefile_b64 }                    : {}),
        ...(useSource === 'geotiff' && geotiff_b64  ? { geotiff_b64 }  : {}),
        ...(useSource === 'geotiff' && geotiff_url  ? { geotiff_url }  : {}),
      }
    }

    setPmarLoading(true)
    setPmarData(null)
    setPmarStatus(t.pmar.btnRunning)
    setPmarStatusType('')

    try {

      const resp = await fetch('/processes/pmar/execution', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Prefer': 'respond-async' },
        body:    JSON.stringify({ inputs }),
      })

      if (!resp.ok) {
        const text = await resp.text()
        let message = t.status.httpError(resp.status)
        try {
          const json = JSON.parse(text)
          if (json.description) message = json.description
        } catch { message = text.slice(0, 300) }
        throw new Error(message)
      }

      const { jobID } = await resp.json()
      setPmarJobId(jobID)
      const jsonHeaders = { 'Accept': 'application/json' }

      await new Promise((resolve, reject) => {
        const iv = setInterval(async () => {
          try {
            const jobResp = await fetch(`/jobs/${jobID}`, { headers: jsonHeaders })
            const job     = await jobResp.json()
            if (job.status === 'successful') {
              clearInterval(iv)
              resolve()
            } else if (job.status === 'failed') {
              clearInterval(iv)
              reject(new Error(job.message || t.status.badResponse))
            } else if (job.status === 'dismissed') {
              clearInterval(iv)
              reject(new Error('__dismissed__'))
            }
          } catch (e) { clearInterval(iv); reject(e) }
        }, 3000)
      })

      const resResp = await fetch(`/jobs/${jobID}/results`, { headers: jsonHeaders })
      const raw     = await resResp.json()
      const data    = raw.result ?? raw

      if (!data.raster_values || !data.bounds) throw new Error(t.status.badResponse)

      const label = lang === 'it' ? data.label_it : data.label_en
      setPmarData(data)
      if (data.bounds && mapRef.current)
        mapRef.current.fitBounds(L.latLngBounds(data.bounds), { padding: [50, 50] })
      setActiveIndicator('ppi')
      setActiveMapTool(null)
      setHistograms(prev        => { prev.forEach(h => h.layer?.remove()); return [] })
      setStatsEntries(prev      => { prev.forEach(h => h.layer?.remove()); return [] })
      setProfileEntries(prev    => { prev.forEach(h => h.layer?.remove()); return [] })
      setThresholdEntries(prev  => { prev.forEach(h => h.layer?.remove()); return [] })
      setComparisonAreas(prev => { prev.forEach(a => a.layer?.remove()); return [] })
      setPmarStatus(`✓ PMAR — ${label}`)
      setPmarStatusType('ok')

    } catch (err) {
      if (err.message !== '__dismissed__') {
        const clean = err.message
          .replace(/^Error executing process:\s*/i, '')
          .replace(/^Errore:\s*/i, '')
          .replace(/^Error:\s*/i, '')
          .trim()
        setPmarErrorMsg(clean)
        setPmarStatus('')
        setPmarStatusType('error')
      }
    } finally {
      setPmarLoading(false)
      setPmarJobId(null)
      setPmarStopping(false)
    }
  }

  const activePmarData = useMemo(
    () => getActivePmarData(pmarData, activeIndicator),
    [pmarData, activeIndicator],
  )

  function handleStatsResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const stats = computeStats(rd.raster_values, snap.colMin, snap.colMax, snap.rowMin, snap.rowMax)
    setStatsEntries(prev => [...prev, { id: Date.now(), layer, result: { ...snap, stats } }])
  }

  function handleProfileResult(lineData, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const { latA, lonA, latB, lonB } = lineData
    const profile = sampleProfile(latA, lonA, latB, lonB, rd)
    setProfileEntries(prev => [...prev, {
      id: Date.now(), layer,
      result: {
        ...profile,
        snapLatMin: Math.min(latA, latB),
        snapLatMax: Math.max(latA, latB),
        snapLonMin: Math.min(lonA, lonB),
        snapLonMax: Math.max(lonA, lonB),
      },
    }])
  }

  function handleThresholdResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const values = []
    for (let r = snap.rowMin; r <= snap.rowMax; r++)
      for (let c = snap.colMin; c <= snap.colMax; c++) {
        const v = rd.raster_values[r]?.[c]
        if (v > 0 && isFinite(v)) values.push(v)
      }
    setThresholdEntries(prev => [...prev, {
      id: Date.now(), layer,
      result: { ...snap, values, vmin: rd.vmin, vmax: rd.vmax, rasterRes: rd.raster_res },
    }])
  }

  function handleCsvResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const rows = ['lat,lon,value']
    for (let r = snap.rowMin; r <= snap.rowMax; r++)
      for (let c = snap.colMin; c <= snap.colMax; c++) {
        const v = rd.raster_values[r]?.[c]
        if (!v || v <= 0 || !isFinite(v)) continue
        const lat = (rd.raster_lat_min + r * rd.raster_res).toFixed(5)
        const lon = (rd.raster_lon_min + c * rd.raster_res).toFixed(5)
        rows.push(`${lat},${lon},${v}`)
      }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `pmar_cells_${Date.now()}.csv`,
    }).click()
    setTimeout(() => layer?.remove(), 1500)
  }

  function handleComparisonResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const hist = computeHistogramFromSnap(snap, rd)
    if (!hist) { layer?.remove(); return }
    setComparisonAreas(prev => [...prev, { id: Date.now(), result: { ...hist, ...snap }, layer }])
  }

  function handleCloseAll() {
    setHistograms(prev       => { prev.forEach(h => h.layer?.remove()); return [] })
    setStatsEntries(prev     => { prev.forEach(h => h.layer?.remove()); return [] })
    setProfileEntries(prev   => { prev.forEach(h => h.layer?.remove()); return [] })
    setThresholdEntries(prev => { prev.forEach(h => h.layer?.remove()); return [] })
    setComparisonAreas(prev  => { prev.forEach(a => a.layer?.remove()); return [] })
  }

  async function handleFetchNatura2000() {
    let bounds = seedShapeBounds(seedShape)
    if (!bounds && pmarData?.bounds) {
      const [[lat_min, lon_min], [lat_max, lon_max]] = pmarData.bounds
      bounds = { lon_min, lat_min, lon_max, lat_max }
    }
    if (!bounds) return
    setNatura2000Loading(true)
    setNatura2000Empty(false)
    try {
      const resp = await fetch('/processes/natura2000/execution', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ inputs: bounds }),
      })
      const raw  = await resp.json()
      const data = raw.result ?? raw
      if (data?.features?.length > 0) {
        setNatura2000Geojson(data)
      } else {
        setNatura2000Empty(true)
      }
    } catch {
      setNatura2000Empty(true)
    } finally {
      setNatura2000Loading(false)
    }
  }

  function handleDownloadPmar() {
    const ind        = activeIndicator || 'ppi'
    const geotiffKey = ind === 'ppi' ? 'geotiff_b64' : `${ind}_geotiff_b64`
    if (!pmarData?.[geotiffKey]) return
    const bytes = atob(pmarData[geotiffKey])
    const buf   = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i)
    const blob  = new Blob([buf], { type: 'image/tiff' })
    const url   = URL.createObjectURL(blob)
    const a     = document.createElement('a')
    a.href      = url
    const src   = pmarData.use_source !== 'none' ? `_${pmarData.use_source}` : ''
    a.download  = `pmar_${pmarData.pressure}_${pmarData.start_time}-${pmarData.end_time}_p${pmarData.pnum}${src}_${ind}.tif`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ position: 'relative', height: '100vh' }} data-theme={mapTheme}>
      <MapContainer
        center={[44, 12.5]}
        zoom={7}
        style={{ position: 'absolute', inset: 0 }}
        zoomControl
      >
        <TileLayer
          key={mapTheme}
          url={`https://{s}.basemaps.cartocdn.com/${mapTheme}_all/{z}/{x}/{y}{r}.png`}
          attribution='© OpenStreetMap · © CARTO'
          subdomains="abcd"
          maxZoom={19}
        />
        <SimLayer simData={simData} currentStep={currentStep} />
        <PmarLayer pmarData={activePmarData} visible={showPmarRaster} passagesLabel={t.pmarControls.tooltipPassages} />
        <SeedingAreaLayer geojson={pmarData?.seeding_geojson ?? null} visible={showSeedShape} />
        <SeedingAreaLayer geojson={t4mspPreviewGeoJSON} visible={!!t4mspPreviewGeoJSON} />
        <WindFarmsLayer geojson={windfarmsGeoJSON} visible={showWindFarms} />
        <OffshoreInstallationsLayer geojson={offshoreGeoJSON} visible={showOffshoreInstallations} />
        <MspZonesLayer geojson={mspZonesGeoJSON} visible={showMspZones} />
        <Natura2000Layer geojson={natura2000Geojson} visible={showNatura2000} />
        <SeedDrawer
          drawMode={drawMode}
          seedShape={seedShape}
          showSeedShape={showSeedShape}
          onShapeDone={handleShapeDone}
        />
        {pmarData && (
          <HistogramDrawLayer
            active={activeMapTool === 'histogram'}
            rasterData={activePmarData}
            onResult={(result, layer) =>
              setHistograms(prev => [...prev, { id: Date.now(), result, layer }])
            }
          />
        )}
        {pmarData && ['stats', 'threshold', 'csv', 'comparison'].includes(activeMapTool) && (
          <RectSelectionLayer
            active={true}
            rasterData={activePmarData}
            onResult={(snap, layer) => {
              const rd = activePmarData
              if (activeMapTool === 'stats')           handleStatsResult(snap, layer, rd)
              else if (activeMapTool === 'threshold')  handleThresholdResult(snap, layer, rd)
              else if (activeMapTool === 'csv')        handleCsvResult(snap, layer, rd)
              else if (activeMapTool === 'comparison') handleComparisonResult(snap, layer, rd)
            }}
          />
        )}
        {pmarData && activeMapTool === 'profile' && (
          <LineSelectionLayer
            active={true}
            onResult={(lineData, layer) => {
              const rd = activePmarData
              handleProfileResult(lineData, layer, rd)
            }}
          />
        )}
        <MapRefSetter mapRef={mapRef} />
      </MapContainer>

      <div style={{
        position: 'absolute', top: 16, right: 16, zIndex: 1000,
        display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2,
        background: 'var(--panel-bg)',
        border: '1px solid var(--panel-border)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderRadius: 10,
        padding: 4,
        boxShadow: '0 2px 16px rgba(0,0,0,0.12)',
      }}>
        <ActionIcon
          size={36} radius="md" variant="subtle"
          title={mapTheme === 'dark' ? 'Switch to light map' : 'Switch to dark map'}
          onClick={() => { const next = mapTheme === 'dark' ? 'light' : 'dark'; setMapTheme(next); setColorScheme(next) }}
        >
          {mapTheme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
        </ActionIcon>
        <div style={{ width: 1, height: 20, background: 'var(--panel-border)', flexShrink: 0 }} />
        <ActionIcon
          size={36} radius="md" variant="subtle"
          title="Switch language"
          onClick={toggle}
        >
          <Text size="xs" fw={700} c="dimmed">{lang === 'it' ? 'EN' : 'IT'}</Text>
        </ActionIcon>
      </div>

      <Panel
        onRun={handleRun}
        onRunPmar={handleRunPmar}
        loading={loading}
        onStopOpenDrift={async () => { if (openDriftJobId) { setOpenDriftStopping(true); await fetch(`/jobs/${openDriftJobId}`, { method: 'DELETE' }) } }}
        openDriftStopping={openDriftStopping}
        status={status}
        statusType={statusType}
        pmarLoading={pmarLoading}
        onStopPmar={async () => { if (pmarJobId) { setPmarStopping(true); await fetch(`/jobs/${pmarJobId}`, { method: 'DELETE' }) } }}
        pmarStopping={pmarStopping}
        pmarStatus={pmarStatus}
        pmarStatusType={pmarStatusType}
        drawMode={drawMode}
        onStartDraw={handleStartDraw}
        onClearSeedShape={handleClearSeedShape}
        seedShape={seedShape}
        activeTool={activeTool}
        onToolChange={handleToolChange}
        useSource={useSource}
        onUseSourceChange={src => { setUseSource(src); setWindfarmsEmpty(false); setOffshoreEmpty(false); setMspZonesEmpty(false) }}
        windfarmsLoading={windfarmsLoading}
        windfarmsEmpty={windfarmsEmpty}
        offshoreLoading={offshoreLoading}
        offshoreEmpty={offshoreEmpty}
        mspZonesLoading={mspZonesLoading}
        mspZonesEmpty={mspZonesEmpty}
        natura2000Loading={natura2000Loading}
        natura2000Empty={natura2000Empty}
        natura2000Geojson={natura2000Geojson}
        showNatura2000={showNatura2000}
        onFetchNatura2000={handleFetchNatura2000}
        onToggleNatura2000={() => setShowNatura2000(v => !v)}
        hasSeedShape={!!seedShape || !!pmarData}
        onT4mspPreview={setT4mspPreviewGeoJSON}
      />

      {pmarData && showPmarRaster && (() => {
        const active = activePmarData
        const cb = mapTheme === 'light'
          ? (active?.colorbar_light_b64 ?? active?.colorbar_b64)
          : active?.colorbar_b64
        return (
          <div className="pmar-colorbar">
            <span className="pmar-colorbar-label">{t.pmarControls.colorbarLabel}</span>
            <img src={`data:image/png;base64,${cb}`} alt="colorbar" className="pmar-colorbar-img" />
          </div>
        )
      })()}

      {pmarData && (
        <PmarControls
          showPmarRaster={showPmarRaster}
          onTogglePmarRaster={() => setShowPmarRaster(v => !v)}
          showSeedShape={showSeedShape}
          onToggleSeedShape={() => setShowSeedShape(v => !v)}
          showWindFarms={showWindFarms}
          onToggleWindFarms={() => setShowWindFarms(v => !v)}
          hasWindFarms={!!windfarmsGeoJSON}
          showOffshoreInstallations={showOffshoreInstallations}
          onToggleOffshoreInstallations={() => setShowOffshoreInstallations(v => !v)}
          hasOffshoreInstallations={!!offshoreGeoJSON}
          showMspZones={showMspZones}
          onToggleMspZones={() => setShowMspZones(v => !v)}
          hasMspZones={!!mspZonesGeoJSON}
          onDownloadPmar={handleDownloadPmar}
          elevated={!!simData}
          activeIndicator={activeIndicator}
          onIndicatorChange={setActiveIndicator}
          hasIndicators={!!(pmarData?.sum_raster_values) || !!(pmarData?.std_raster_values)}
          hasStdRaster={!!(pmarData?.std_raster_values)}
        />
      )}

      <ToolsPanel
        activeMapTool={activeMapTool}
        onSetTool={toggleTool}
        hasRaster={!!pmarData}
        windowCounts={{
          histogram:  histograms.length,
          stats:      statsEntries.length,
          profile:    profileEntries.length,
          threshold:  thresholdEntries.length,
          comparison: comparisonAreas.length,
        }}
        openWindowCount={histograms.length + statsEntries.length + profileEntries.length + thresholdEntries.length + comparisonAreas.length}
        onCloseAll={handleCloseAll}
      />

      {histograms.map((h, i) => (
        <HistogramEntry
          key={h.id}
          histogram={h}
          mapRef={mapRef}
          mapTheme={mapTheme}
          stackIndex={i}
          onClose={() => setHistograms(prev => {
            const item = prev.find(x => x.id === h.id)
            item?.layer?.remove()
            return prev.filter(x => x.id !== h.id)
          })}
        />
      ))}

      {statsEntries.map((e, i) => (
        <StatsEntry
          key={e.id}
          entry={e}
          mapRef={mapRef}
          mapTheme={mapTheme}
          stackIndex={i}
          onClose={() => setStatsEntries(prev => {
            const item = prev.find(x => x.id === e.id)
            item?.layer?.remove()
            return prev.filter(x => x.id !== e.id)
          })}
        />
      ))}

      {thresholdEntries.map((e, i) => (
        <ThresholdEntry
          key={e.id}
          entry={e}
          mapRef={mapRef}
          mapTheme={mapTheme}
          stackIndex={i}
          onClose={() => setThresholdEntries(prev => {
            const item = prev.find(x => x.id === e.id)
            item?.layer?.remove()
            return prev.filter(x => x.id !== e.id)
          })}
        />
      ))}

      {profileEntries.map((e, i) => (
        <ProfileEntry
          key={e.id}
          entry={e}
          mapRef={mapRef}
          mapTheme={mapTheme}
          stackIndex={i}
          onClose={() => setProfileEntries(prev => {
            const item = prev.find(x => x.id === e.id)
            item?.layer?.remove()
            return prev.filter(x => x.id !== e.id)
          })}
        />
      ))}

      <ComparisonView
        areas={comparisonAreas}
        mapRef={mapRef}
        mapTheme={mapTheme}
        onRemoveArea={(i) => setComparisonAreas(prev => {
          prev[i]?.layer?.remove()
          return prev.filter((_, j) => j !== i)
        })}
        onClose={() => setComparisonAreas(prev => {
          prev.forEach(a => a.layer?.remove())
          return []
        })}
      />

      <Modal
        opened={!!pmarErrorMsg}
        onClose={() => setPmarErrorMsg(null)}
        centered
        size="sm"
        zIndex={200000}
        title={<Text fw={600} size="sm">Errore</Text>}
        styles={{
          content: { background: 'var(--modal-bg)', border: '1px solid var(--modal-border)' },
          header:  { background: 'var(--modal-bg)' },
        }}
      >
        <Text size="sm" c="gray.2" style={{ lineHeight: 1.55 }}>{pmarErrorMsg}</Text>
        <Button fullWidth mt="md" color="blue" variant="light" onClick={() => setPmarErrorMsg(null)}>
          OK
        </Button>
      </Modal>

      {simData && (
        <AnimationControls
          simData={simData}
          currentStep={currentStep}
          isPlaying={isPlaying}
          onTogglePlay={togglePlay}
          onSliderChange={step => { setIsPlaying(false); setCurrentStep(step) }}
          speed={speed}
          onSpeedChange={setSpeed}
          showSeedShape={showSeedShape}
          onToggleSeedShape={() => setShowSeedShape(v => !v)}
        />
      )}
    </div>
  )
}
