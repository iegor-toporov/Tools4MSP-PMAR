import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Modal, ActionIcon, Text, Button, useMantineColorScheme } from '@mantine/core'
import { IconSun, IconMoon, IconCircleCheck } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { MODEL_STYLES } from './constants'
import { useLang } from './LanguageContext'
import { Process, ErrorCode, JobOutcome, OgcError, ACCESS_DENIED,
         executeAsync, waitForJob, fetchJobResults, dismissJob, isTransientError } from './api/ogcProcesses'
import { usePreviewLayer } from './hooks/usePreviewLayer'
import Panel from './components/Panel'
import SeedDrawer from './components/SeedDrawer'
import AnimationControls from './components/AnimationControls'
import LayersPanel, { MAX_ANALYSES } from './components/LayersPanel'
import ToolsPanel from './components/ToolsPanel'
import MarkovStepper from './components/MarkovStepper'
import { loadState, saveState } from './storage/analysesStore'
import { fromStored, mergeAnalyses, toStored } from './storage/persistedState'
import { HistogramDrawLayer, PmarHistogramModal, MapRefSetter, ConnectorLine,
         RectSelectionLayer, LineSelectionLayer, computeHistogramFromSnap } from './components/PmarHistogram'
import { computeStats, PmarStatsModal } from './components/PmarStats'
import { PmarThresholdModal } from './components/PmarThreshold'
import { PmarComparisonModal } from './components/PmarComparison'
import { sampleProfile, PmarProfileModal } from './components/PmarProfile'
import { seedShapeToGeoJSON, seedShapeBounds } from './geometry/seedShape'
import { cellsCsv } from './export/pmarTools'
import { saveText, saveBytes, base64ToBytes } from './export/download'
import { encodeGeoTiff, connectivityRaster, fileStem } from './export/geotiff'
import { spectralR, logNorm, linNorm, logClasses, linearClasses, classIndex,
         PROBABILITY_BANDS, redsColor, formatBound, formatPercent,
         divergingColor, divergingNorm, divergingClasses } from './legend/classes'
import { clampFrame, frameDay, markovRaster } from './markov/frames'
import { PmarConnectivityMatrix } from './components/PmarConnectivityMatrix'
import MapLegend from './components/MapLegend'
import 'leaflet/dist/leaflet.css'
import './App.css'

const STRANDED_STYLE = { color: '#ef4444', fillColor: '#fca5a5', weight: 2 }

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
    // Hidden = not drawn: with transparency alone it would stay in the DOM, and a layer
    // recreated while hidden would appear again.
    if (!visible || !geojson?.features?.length) return

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
      } catch { /* invalid geometry, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, visible, map])

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
    // Hidden = not drawn: with transparency alone it would stay in the DOM, and a layer
    // recreated while hidden would appear again.
    if (!visible || !geojson?.features?.length) return

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
      } catch { /* invalid geometry, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, visible, map])

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
    // Hidden = not drawn: with transparency alone it would stay in the DOM, and a layer
    // recreated while hidden would appear again.
    if (!visible || !geojson?.features?.length) return

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
      } catch { /* invalid geometry, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, visible, map])

  return null
}

// ── Connectivity polygons layer ───────────────────────────────────────────────
/**
 * Draws the user's polygons filled by the selected connectivity metric.
 *
 * Unmounts on !visible rather than calling setStyle(): setStyle() applies one style
 * to the whole group and would flatten the per-feature colours.
 */
function ConnectivityLayer({ data, metric, visible, labels, selectedNode, onSelectNode,
                            classes, highlight, opacity = 0.8 }) {
  const map      = useMap()
  const layerRef = useRef(null)

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    const fc = data?.polygons_geojson
    if (!visible || !fc?.features?.length) return

    const [vmin, vmax] = data.metric_ranges?.[metric] ?? [0, 1]

    layerRef.current = L.geoJSON(fc, {
      style: f => {
        const pr = f.properties ?? {}
        // Polygons holding too few particles carry no usable statistic: showing them
        // in the colour scale would present noise as a result.
        if (!pr.reliable) {
          return { color: '#64748b', fillColor: '#94a3b8', fillOpacity: 0.15,
                   weight: 1, opacity: 0.6, dashArray: '3 3' }
        }
        // The selected one stands out only by its border: changing the fill too would
        // take it out of the colour scale of the measure.
        const picked = pr.node_id === selectedNode
        if (highlight?.size && !highlight.has(classIndex(pr[metric], classes))) {
          return { color: picked ? '#ffffff' : DIMMED_LINE, fillColor: DIMMED_LINE,
                   fillOpacity: 0.12, weight: picked ? 3 : 1, opacity: picked ? 1 : 0.5 }
        }
        const [r, g, b] = spectralR(linNorm(pr[metric], vmin, vmax) ?? 0)
        return { color: picked ? '#ffffff' : '#1e293b', fillColor: `rgb(${r},${g},${b})`,
                 fillOpacity: 0.9 * opacity, weight: picked ? 3 : 1, opacity: picked ? 1 : 0.9 }
      },
      onEachFeature: (f, layer) => {
        const pr  = f.properties ?? {}
        const num = v => (Number.isFinite(Number(v)) ? Number(v).toFixed(3) : '–')
        const row = (k, v) => `<div class="pmar-tt-row"><span>${k}</span><b>${v}</b></div>`
        layer.bindTooltip(
          `<div class="pmar-tt-title">${pr.node_label ?? ''}</div>
           ${row(labels.inStrength,  num(pr.in_strength))}
           ${row(labels.outStrength, num(pr.out_strength))}
           ${row(labels.betweenness, num(pr.betweenness))}
           ${pr.reliable ? '' : `<div class="pmar-tt-warn">${labels.weak}</div>`}`,
          // Above the cursor: the tooltip of the raster cells goes below, so with both
          // layers on they do not cover each other.
          { sticky: true, direction: 'top', offset: [0, -12], className: 'pmar-map-tooltip' }
        )

        // The click isolates the edges of the polygon. `stopPropagation` keeps it from
        // reaching the map, where SeedDrawer has its drawing handler.
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          onSelectNode?.(pr.node_id)
        })
      },
    }).addTo(map)

    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [data, metric, visible, map, labels, selectedNode, onSelectNode, classes, highlight, opacity])

  return null
}

/** Only the outline of the nodes of a connectivity analysis: the base layer "Connectivity grid". */
function GridOutlineLayer({ geojson, visible }) {
  const map = useMap()
  useEffect(() => {
    if (!visible || !geojson?.features?.length) return
    const layer = L.geoJSON(geojson, {
      style: { color: '#334155', weight: 1, opacity: 0.8, fill: false },
      interactive: false,
    }).addTo(map)
    return () => { layer.remove() }
  }, [geojson, visible, map])
  return null
}

/** Study area: box of the release area plus the CMEMS margin of the simulation. */
function StudyAreaLayer({ bounds, visible }) {
  const map = useMap()
  useEffect(() => {
    if (!visible || !bounds) return
    const [w, s, e, n] = bounds
    const layer = L.rectangle([[s, w], [n, e]], {
      color: '#64748b', weight: 1.5, opacity: 0.9, dashArray: '8 6', fill: false, interactive: false,
    }).addTo(map)
    return () => { layer.remove() }
  }, [bounds, visible, map])
  return null
}

// ── Connectivity network edges layer ──────────────────────────────────────────
/**
 * Draws the directed edges produced by PMAR's export_network(), which already bakes
 * stroke colour and width into each feature's properties.
 *
 * With a node selected, only the edges touching it are drawn. Every feature carries
 * `source`/`target`, the arrowhead polygons included, so one filter thins out the
 * curve and its arrowhead together.
 *
 * The edges live in their own pane above the standard overlay pane. Inside a single
 * pane the order is whatever was added last, so the polygons — which are re-created
 * on every metric or selection change — would otherwise end up covering the network
 * with their 72% fill.
 */
const EDGES_PANE = 'connectivityEdges'
function ConnectivityEdgesLayer({ geojson, visible, selectedNode, direction, highlight }) {
  const map      = useMap()
  const layerRef = useRef(null)

  useEffect(() => {
    layerRef.current?.remove()
    layerRef.current = null
    if (!visible || !geojson?.features?.length) return

    if (!map.getPane(EDGES_PANE)) {
      const pane = map.createPane(EDGES_PANE)
      pane.style.zIndex = 450          // above overlayPane (400), below the markers (600)
      // Without this the pane would catch the mouse instead of the polygons below, and
      // the click that isolates the edges would stop working.
      pane.style.pointerEvents = 'none'
    }

    layerRef.current = L.geoJSON(geojson, {
      pane: EDGES_PANE,
      style: f => {
        const pr = f.properties ?? {}
        // Outside the probability bands chosen in the legend: dimmed, not removed.
        if (highlight?.size && !highlight.has(classIndex(pr.p, PROBABILITY_BANDS))) {
          return { color: DIMMED_LINE, weight: 1, opacity: 0.15,
                   fillColor: DIMMED_LINE, fillOpacity: 0.15 }
        }
        return {
          color:       pr.stroke ?? '#0f172a',
          weight:      pr['stroke-width'] ?? 1.5,
          opacity:     pr['stroke-opacity'] ?? 0.75,
          fillColor:   pr.fill ?? pr.stroke ?? '#0f172a',
          fillOpacity: pr['fill-opacity'] ?? 0.75,
        }
      },
      filter: f => {
        if (selectedNode === null || selectedNode === undefined) return true
        const { source, target } = f.properties ?? {}
        // A self-loop (source === target) is both incoming and outgoing, so it stays
        // visible in all three modes.
        if (direction === 'in')  return target === selectedNode
        if (direction === 'out') return source === selectedNode
        return source === selectedNode || target === selectedNode
      },
      interactive: false,
    }).addTo(map)

    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [geojson, visible, map, selectedNode, direction, highlight])

  return null
}

// ── PMAR seeding area polygon layer ─────────────────────────────────────────
function SeedingAreaLayer({ geojson, visible, palette = null }) {
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
        ...palette,
      },
      // Plain outline of the study area: nothing is attached to it. If it were
      // interactive it would take the hover of the connectivity polygons, because it
      // appears after the PMAR analysis and so ends up above them in the SVG pane.
      interactive: false,
    }).addTo(map)
    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [geojson, visible, palette, map])

  return null
}

/**
 * Value of a cell in the tooltip. PPIs are counts (whole numbers above 1); Markov
 * forecasts are fractions as small as 1e-5, which with three fixed decimals would
 * become "0.000".
 */
function formatCellValue(val, signed = false) {
  const a = Math.abs(val)
  const s = a >= 1 ? (a >= 100 ? Math.round(a).toString() : a.toFixed(2))
          : a >= 0.001 ? a.toFixed(3) : a.toExponential(2)
  return (val < 0 ? '−' : signed ? '+' : '') + s
}

// ── PMAR raster overlay (canvas layer with hover per cell) ───────────────────
// Colour of the cells, polygons and arrows dimmed by the interactive legend.
const DIMMED_FILL = 'rgba(148,163,184,0.18)'
const DIMMED_LINE = '#94a3b8'

function PmarLayer({ pmarData, visible, passagesLabel, classes, highlight, interactive = true,
                    opacity = 0.8 }) {
  const map          = useMap()
  const canvasRef    = useRef(null)
  const tooltipRef   = useRef(null)
  const drawRef      = useRef(null)
  const labelRef     = useRef(passagesLabel)
  labelRef.current   = passagesLabel
  const visibleRef   = useRef(visible)
  visibleRef.current = visible
  // Read by draw(), registered once: the refs avoid recreating the canvas at every
  // click on the legend.
  const highlightRef = useRef(highlight)
  highlightRef.current = highlight
  // With several heatmaps on the map, only that of the active analysis opens the tooltip.
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  const classesRef   = useRef(classes)
  classesRef.current = classes
  const opacityRef   = useRef(opacity)
  opacityRef.current = opacity

  useEffect(() => {
    if (!pmarData?.raster_values || !pmarData.bounds) return

    const {
      raster_values, vmin, vmax,
      raster_lon_min, raster_lat_min, raster_res,
      raster_nx, raster_ny,
    } = pmarData
    // Differences of a Markov analysis: signed values on a diverging scale.
    const diverging = pmarData.scale === 'diverging'
    const norm  = diverging ? v => divergingNorm(v, pmarData.dmax) : v => logNorm(v, vmin, vmax)
    const paint = diverging ? divergingColor : spectralR
    const shown = diverging ? v => !!v && Number.isFinite(v) : v => v > 0

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
          if (!shown(val)) continue

          const lat = raster_lat_min + row * raster_res
          const lon = raster_lon_min + col * raster_res
          const half = raster_res / 2

          const sw = map.latLngToLayerPoint([lat - half, lon - half])
          const ne = map.latLngToLayerPoint([lat + half, lon + half])

          const x = ne.x - ox, y = ne.y - oy
          const w = sw.x - ne.x, h = sw.y - ne.y
          if (x + w < 0 || y + h < 0 || x > size.x || y > size.y) continue

          const t = norm(val)
          if (t === null) continue
          const hl = highlightRef.current
          if (hl?.size && !hl.has(classIndex(val, classesRef.current))) {
            ctx.fillStyle = DIMMED_FILL
          } else {
            const [r, g, b] = paint(t)
            ctx.fillStyle = `rgba(${r},${g},${b},${opacityRef.current})`
          }
          ctx.fillRect(x, y, w, h)
        }
      }
    }

    function onMouseMove(e) {
      // A hidden raster must not leave its tooltip around: without this check the first
      // mouse move would show it again over invisible cells.
      if (!visibleRef.current || !interactiveRef.current) { tooltip.style.display = 'none'; return }

      const { lat, lng } = e.latlng
      const col = Math.floor((lng - raster_lon_min + raster_res / 2) / raster_res)
      const row = Math.floor((lat - raster_lat_min + raster_res / 2) / raster_res)

      if (col >= 0 && col < raster_nx && row >= 0 && row < raster_ny) {
        const val = raster_values[row][col]
        if (shown(val)) {
          const latC = (raster_lat_min + row * raster_res).toFixed(3)
          const lonC = (raster_lon_min + col * raster_res).toFixed(3)
          const dispVal = formatCellValue(val, diverging)
          const decimals = Math.max(0, Math.ceil(-Math.log10(raster_res)) + 1)
          const latID = (raster_lat_min + row * raster_res).toFixed(decimals)
          const lonID = (raster_lon_min + col * raster_res).toFixed(decimals)
          const cellId = `${lonID}E_${latID}N`
          tooltip.innerHTML =
            `<b>${dispVal}</b> ${labelRef.current}` +
            `<br><span>${latC}° N · ${lonC}° E</span>` +
            `<br><span class="pmar-cell-id">ID: ${cellId}</span>`
          tooltip.style.display = 'block'

          // Below the cursor: the tooltip of the connectivity polygons goes above.
          // Near the bottom edge of the map it flips above, otherwise it would leave
          // the frame exactly where it is needed.
          const mapH = map.getSize().y
          const below = e.containerPoint.y + 18
          const flip  = below + tooltip.offsetHeight > mapH - 8
          tooltip.style.left = (e.containerPoint.x + 14) + 'px'
          tooltip.style.top  = (flip ? e.containerPoint.y - tooltip.offsetHeight - 14 : below) + 'px'
          return
        }
      }
      tooltip.style.display = 'none'
    }

    const onMouseOut = () => { tooltip.style.display = 'none' }

    drawRef.current = draw
    map.on('moveend zoomend resize', draw)
    map.on('mousemove', onMouseMove)
    map.on('mouseout',  onMouseOut)
    draw()
    canvas.style.display = visibleRef.current ? '' : 'none'

    return () => {
      map.getPanes().overlayPane.removeChild(canvas)
      map.getContainer().removeChild(tooltip)
      map.off('moveend zoomend resize', draw)
      map.off('mousemove', onMouseMove)
      map.off('mouseout',  onMouseOut)
      canvasRef.current  = null
      tooltipRef.current = null
      drawRef.current    = null
    }
  }, [pmarData, map])

  // Click on the legend: the same canvas is redrawn with the new classes switched on.
  useEffect(() => { drawRef.current?.() }, [highlight, classes, opacity])

  useEffect(() => {
    if (canvasRef.current)
      canvasRef.current.style.display = visible ? '' : 'none'
    if (!visible && tooltipRef.current)
      tooltipRef.current.style.display = 'none'
  }, [visible])

  return null
}

// ── Histogram instance (one per drawn selection) ─────────────────────────────
/**
 * Turns a structured API error into the localized text shown to the user.
 *
 * The API module reports *what* went wrong (a code, plus whatever the backend
 * explained); choosing the wording, and the language, belongs here.
 */
function describeError(err, t) {
  if (err instanceof OgcError && err.detail === ACCESS_DENIED) return t.pmar.access.denied
  if (err instanceof OgcError) {
    if (err.code === ErrorCode.HTTP)       return err.detail ?? t.status.httpError(err.httpStatus)
    if (err.code === ErrorCode.JOB_FAILED) return err.detail ?? t.status.badResponse
  }
  return err.message
}

/**
 * Text of a backend warning in the current language. The backend sends `code` and
 * numbers, not sentences: otherwise the warning would arrive in one language only. An
 * unknown code falls back to the backend's English `message`.
 */
function describeWarning(w, t) {
  if (typeof w === 'string') return w
  const c = t.pmar.connectivity
  const fill = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), s)
  if (w.code === 'edges_trimmed')
    return fill(c.warnEdgesTrimmed, { drawn: w.drawn, total: w.total })
  if (w.code === 'weak_polygons')
    return fill(w.count === 1 ? c.warnWeakPolygonsOne : c.warnWeakPolygons,
                { count: w.count, total: w.total, n: w.min_particles })
  const m = t.pmar.markov
  if (w.code === 'weak_cells')
    return fill(m.warnWeakCells, { count: w.count, total: w.total, n: w.min_particles })
  if (w.code === 'dt_short')
    return fill(m.warnDtShort, { pct: Math.round(w.median_stay * 100) })
  return w.message ?? ''
}

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
/**
 * Key of the raster shown by an analysis: the indicator for a PMAR one, frame and level
 * for a Markov one. It changes when what is seen changes, and is the cache key.
 */
function rasterKeyOf(a) {
  if (a.kind !== 'markov') return a.view.indicator ?? 'ppi'
  const k = clampFrame(a.data, a.view.frame)
  return `markov:${k}`
}

/** Day of a frame: whole numbers without decimals, fractions (Δt in hours) with two. */
const formatDay = d => (Number.isInteger(d) ? `${d}` : `${+d.toFixed(2)}`)

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

// ── Interactive legend ──────────────────────────────────────────────────────
const INDICATOR_LABEL_KEYS = {
  ppi: 'indicatorDensity', max: 'indicatorMax', q90: 'indicatorQ90', std: 'indicatorStd',
}
const METRIC_LABEL_KEYS = {
  in_strength: 'metricInStrength', out_strength: 'metricOutStrength', betweenness: 'metricBetweenness',
}

/** Label of a class: open bounds at the bottom and top, an interval in between. */
function classLabel(c, i, n, fmt) {
  if (i === 0)     return `< ${fmt(c.to)}`
  if (i === n - 1) return `≥ ${fmt(c.from)}`
  return `${fmt(c.from)} – ${fmt(c.to)}`
}

/** Count how many values fall in each class (null = no class, ignored). */
function countByClass(values, classes) {
  const counts = new Array(classes.length).fill(0)
  for (const v of values) {
    const i = classIndex(v, classes)
    if (i !== null) counts[i]++
  }
  return counts
}

/** Legend rows from top (high values) to bottom, as on a colour bar. */
function legendRows(classes, counts, fmt, swatch) {
  return classes
    .map((c, i) => ({ index: i, count: counts[i], swatch: swatch(c),
                      label: classLabel(c, i, classes.length, fmt) }))
    .reverse()
}

const toggleIn = setter => i => setter(prev => {
  const next = new Set(prev)
  if (next.has(i)) next.delete(i); else next.add(i)
  return next
})

const NO_HIGHLIGHT = new Set()

// EMODnet layers that a PMAR result can carry.
const SOURCE_LAYER_COMPONENTS = [
  ['windfarms_geojson', WindFarmsLayer],
  ['offshore_geojson',  OffshoreInstallationsLayer],
  ['msp_zones_geojson', MspZonesLayer],
]

/**
 * Source layer of a Dispersal analysis: the EMODnet layers that the result carries.
 * The base layer "Source layer" shows them.
 */
function AnalysisSourceLayers({ analysis, visible }) {
  const { data } = analysis
  return SOURCE_LAYER_COMPONENTS.map(([key, Layer]) => data[key] ? (
    <Layer key={key} geojson={data[key]} visible={visible} />
  ) : null)
}

/** Study area and release area of an analysis, according to its switches. */
function BaseLayersOf({ analysis, base }) {
  const bounds = useMemo(() => studyBoundsOf(analysis.info?.scenario), [analysis.info])
  return (
    <>
      <StudyAreaLayer bounds={bounds} visible={base.study} />
      <SeedingAreaLayer geojson={analysis.areaGeoJSON} visible={base.seed && !!analysis.areaGeoJSON} />
    </>
  )
}

/** Does it have a source layer to show (that is, it is not uniform)? */
function hasSourceLayer(a) {
  if (!a) return false
  if (a.kind === 'pmar') return SOURCE_LAYER_COMPONENTS.some(([key]) => a.data[key]?.features?.length)
  return false
}

/** Polygons and arrows of a connectivity analysis, with its node selection. */
function ConnectivityAnalysisLayers({ analysis, labels, onSelectNode, metricClasses,
                                      metricHighlight, edgeHighlight, visible }) {
  const { id, data, view: v } = analysis
  const selectNode = useCallback(nodeId => onSelectNode(id, nodeId), [onSelectNode, id])
  return (
    <>
      <ConnectivityEdgesLayer
        geojson={data.edges_geojson ?? null}
        visible={visible && v.showEdges}
        selectedNode={v.selectedNode}
        direction={v.edgeDirection}
        highlight={edgeHighlight}
      />
      <ConnectivityLayer
        data={data}
        metric={v.metric}
        visible={visible}
        labels={labels}
        selectedNode={v.selectedNode}
        onSelectNode={selectNode}
        classes={metricClasses}
        highlight={metricHighlight}
        opacity={v.opacity ?? 0.8}
      />
    </>
  )
}

// Labels of the files exported by the tools: in English and fixed, so a CSV does not
// change with the interface language of whoever downloaded it.
const EXPORT_SOURCE_LABELS = {
  none: 'Uniform (no weighting)', windfarms: 'Wind farms (EMODnet)',
  offshore_installations: 'Offshore installations (EMODnet)',
  msp_zones: 'MSP aquaculture zones (EMODnet)', geotiff: 'Custom GeoTIFF',
}
const EXPORT_VALUE_LABELS = {
  ppi: 'PPI, particle passages per cell', max: 'MAX across seedings',
  q90: 'Q90 across seedings', std: 'standard deviation across seedings',
}

/**
 * Display state of an analysis layer. Saved views that lack a field (e.g. `opacity`)
 * receive it from here: see storage/persistedState.js.
 */
const DEFAULT_BASE = { seed: true, study: true, source: true, grid: false }
const DEFAULT_VIEW = {
  visible: true, opacity: 0.8,
  base: DEFAULT_BASE,                                          // base layers of this analysis
  indicator: 'ppi',                                            // PMAR
  metric: 'in_strength', showEdges: true,                      // connectivity
  selectedNode: null, edgeDirection: 'both',
  frame: null,                                                 // Propagate (null = ultimo frame)
}

/** Switches of the base layers of an analysis (older saved views lack them). */
const baseOf = a => ({ ...DEFAULT_BASE, ...a?.view?.base })

/** Study area of a simulation: box of the release area ± CMEMS margin. */
function studyBoundsOf(sc) {
  const b = sc?.bounds
  if (!b || b.length !== 4) return null
  const m = Number(sc.cmems_margin ?? 0) || 0
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m]
}

/** Grid of an analysis: its own, if it is a connectivity one; otherwise the most recent of the same simulation. */
function gridOf(a, analyses) {
  if (!a) return null
  if (a.kind === 'connectivity') return a
  const id = a.info?.scenario?.id
  return id ? analyses.find(x => x.kind === 'connectivity' && x.info?.scenario?.id === id) ?? null : null
}

// Margins for fitBounds: the two side panels (16 + 320 + 16).
const FIT_PADDING = { paddingTopLeft: [352, 40], paddingBottomRight: [352, 40] }

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
  // Area of the simulation chosen in the panel: while it is highlighted, the drawn
  // area stays hidden, so only one is seen on the map.
  const [scenarioAreaGeoJSON, setScenarioAreaGeoJSON] = useState(null)

  const [simData,     setSimData]     = useState(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isPlaying,   setIsPlaying]   = useState(false)
  const [speed,       setSpeed]       = useState(5)
  const [loading,            setLoading]            = useState(false)
  const [openDriftJobId,     setOpenDriftJobId]     = useState(null)
  const [openDriftStopping,  setOpenDriftStopping]  = useState(false)
  const [status,             setStatus]             = useState('')
  const [statusType,         setStatusType]         = useState('')

  // ── Analyses (right-hand panel), the most recent first ──
  // Saved in this browser (IndexedDB) together with the analyses still running, which
  // are resumed after a reload: see storage/persistedState.js.
  const [analyses,         setAnalyses]         = useState([])
  const [activeAnalysisId, setActiveAnalysisId] = useState(null)
  const [pendingJobs,      setPendingJobs]      = useState([])
  const [storeLoaded,      setStoreLoaded]      = useState(false)
  // Scenario selected on the left (id and status data): it gives the release area and
  // the study area to the base layers.
  const [selectedScenarioId, setSelectedScenarioId] = useState(null)
  const [selectedScenario,   setSelectedScenario]   = useState(null)
  // Base layers of the previews of the left panel (chosen simulation, drawn area,
  // chosen source), controlled by the Layers panel when no analysis layer is selected.
  // Those of each analysis are in its view (`view.base`).
  const [previewBase,        setPreviewBase]        = useState(DEFAULT_BASE)
  const activeAnalysis = analyses.find(a => a.id === activeAnalysisId) ?? null
  // Raster analyses: PMAR, and Markov on the chosen frame and level. Tools and legend
  // treat them the same way.
  const activePmar = activeAnalysis?.kind === 'pmar' || activeAnalysis?.kind === 'markov'
    ? activeAnalysis : null
  const activeConn = activeAnalysis?.kind === 'connectivity' ? activeAnalysis : null
  // Values derived from the active analysis: tools and legend use them in this form.
  const pmarData           = activePmar?.data ?? null
  const activeIndicator    = activePmar ? rasterKeyOf(activePmar) : 'ppi'
  const connectivityData   = activeConn?.data ?? null
  const connectivityMetric = activeConn?.view.metric ?? 'in_strength'

  const [pmarLoading,     setPmarLoading]     = useState(false)
  const [pmarJobId,       setPmarJobId]       = useState(null)
  const [pmarStopping,    setPmarStopping]    = useState(false)

  const [connectivityLoading,  setConnectivityLoading]  = useState(false)
  const [connectivityJobId,    setConnectivityJobId]    = useState(null)
  const [connectivityStopping, setConnectivityStopping] = useState(false)

  const [markovLoading,  setMarkovLoading]  = useState(false)
  const [markovJobId,    setMarkovJobId]    = useState(null)
  const [markovStopping, setMarkovStopping] = useState(false)
  // Shapes drawn for the Analysis panel, separate from the release area: the release
  // area of Propagate and the boxes of the grids (connectivity and new matrix).
  // The drawing goes to one or the other according to `drawTarget` ('seed' = release area).
  const [extraShapes,  setExtraShapes]  = useState({ connBbox: null, propBbox: null })
  const [extraVisible, setExtraVisible] = useState({ connBbox: false, propBbox: false })
  const [drawTarget,   setDrawTarget]   = useState('seed')
  // Id of the connectivity analysis whose matrix is open (null = closed).
  const [showConnMatrix,       setShowConnMatrix]       = useState(null)
  const [pmarStatus,      setPmarStatus]      = useState('')
  const [pmarStatusType,  setPmarStatusType]  = useState('')
  const [pmarErrorMsg,    setPmarErrorMsg]    = useState(null)
  const [activeMapTool,     setActiveMapTool]     = useState(null)
  const [histograms,        setHistograms]        = useState([])
  const [statsEntries,      setStatsEntries]      = useState([])
  const [profileEntries,    setProfileEntries]    = useState([])
  const [thresholdEntries,  setThresholdEntries]  = useState([])
  const [comparisonAreas,   setComparisonAreas]   = useState([])
  const mapRef = useRef(null)

  /**
   * The raster tools arm a drawing interaction on the map, so at most one may be
   * active. The connectivity matrix arms nothing — it only opens its own window from
   * the layer card — so it keeps its own state (`showConnMatrix`).
   */
  const toggleTool = (tool) => setActiveMapTool(prev => prev === tool ? null : tool)

  const [useSource,        setUseSource]        = useState('none')

  // Memoized so the preview effects key on the seeding area, not on every render.
  const seedBounds = useMemo(() => seedShapeBounds(seedShape), [seedShape])

  // Margin of the analysis, passed by PmarPanel: the preview covers the same study area
  // that the backend will use for weighting (scenario area ± margin).
  const [analysisMargin, setAnalysisMargin] = useState(1)

  // Area of the EMODnet preview: the selected scenario if there is one (in Analysis a
  // drawn area usually does not exist), otherwise the drawn release area.
  const previewBounds = useMemo(() => {
    if (!scenarioAreaGeoJSON) return seedBounds
    try {
      const b = L.geoJSON(scenarioAreaGeoJSON).getBounds()
      const m = analysisMargin
      return { lon_min: b.getWest() - m, lat_min: b.getSouth() - m,
               lon_max: b.getEast() + m, lat_max: b.getNorth() + m }
    } catch {
      return seedBounds
    }
  }, [scenarioAreaGeoJSON, analysisMargin, seedBounds])

  const windfarms = usePreviewLayer(Process.WINDFARMS, {
    enabled: useSource === 'windfarms', bounds: previewBounds,
  })
  const offshore = usePreviewLayer(Process.OFFSHORE_INSTALLATIONS, {
    enabled: useSource === 'offshore_installations', bounds: previewBounds,
  })
  const mspZones = usePreviewLayer(Process.MSP_ZONES, {
    enabled: useSource === 'msp_zones', bounds: previewBounds,
  })

  // Preview of the source chosen on the left, before running: choosing another button
  // removes the previous one. If an analysis of this simulation with this source
  // already exists, its card controls the layer; the preview would be an identical
  // copy that stays on when that one is switched off, so it is not drawn.
  const sourceCoveredByAnalysis = analyses.some(a => a.kind === 'pmar'
    && a.info?.scenario?.id === selectedScenarioId && a.info?.params?.use_source === useSource)
  const previewSource = useSource !== 'none' && !sourceCoveredByAnalysis ? useSource : null
  const preview = data => (sourceCoveredByAnalysis ? null : data)
  const windfarmsGeoJSON = useSource === 'windfarms'              ? preview(windfarms.data) : null
  const offshoreGeoJSON  = useSource === 'offshore_installations' ? preview(offshore.data)  : null
  const mspZonesGeoJSON  = useSource === 'msp_zones'              ? preview(mspZones.data)  : null

  const timerRef = useRef(null)

  function handleToolChange(tool) {
    setActiveTool(tool)
    setDrawMode(null)
  }

  // Buttons sometimes pass the click event as the first argument: it counts as 'seed'.
  const targetOf = target => (typeof target === 'string' ? target : 'seed')
  const setExtraShape = (target, shape) =>
    setExtraShapes(prev => ({ ...prev, [target]: typeof shape === 'function' ? shape(prev[target]) : shape }))

  function handleStartDraw(mode, target = 'seed') {
    target = targetOf(target)
    setDrawTarget(target)
    setDrawMode(mode)
    if (target === 'seed') setSeedShape(null)
    else setExtraShape(target, null)
  }

  /**
   * A finished shape. Polygon drawing stays armed (`keepDrawing`) so that several
   * polygons can be added to the same release area.
   */
  function handleShapeDone(shape, opts) {
    if (drawTarget === 'seed') setSeedShape(shape)
    else setExtraShape(drawTarget, shape)
    if (!opts?.keepDrawing) setDrawMode(null)
  }

  /**
   * Highlight the area of the chosen simulation and fit the map to it: selecting it is
   * an explicit action, and the area may lie outside the view.
   */
  function handleScenarioArea(geojson, scenarioId = null, scenario = null) {
    setScenarioAreaGeoJSON(geojson)
    setSelectedScenarioId(geojson ? scenarioId : null)
    setSelectedScenario(geojson ? scenario : null)
    if (!geojson || !mapRef.current) return
    try {
      mapRef.current.fitBounds(L.geoJSON(geojson).getBounds(), FIT_PADDING)
    } catch { /* degenerate geometry: the view stays as it is */ }
  }

  /** End of polygon drawing: leave the mode and keep the area. */
  function handleFinishDraw() {
    setDrawMode(null)
  }

  /** Remove the last closed polygon; clear the area if it was the only one. */
  function handleUndoLastPolygon(target = 'seed') {
    target = targetOf(target)
    const undo = prev => {
      if (prev?.type !== 'polygon') return prev
      const rings = prev.rings.slice(0, -1)
      return rings.length ? { ...prev, rings } : null
    }
    if (target === 'seed') setSeedShape(undo)
    else setExtraShape(target, undo)
  }

  function handleClearSeedShape(target = 'seed') {
    target = targetOf(target)
    if (target === 'seed') setSeedShape(null)
    else setExtraShape(target, null)
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

    // OpenDriftProcess accepts only seeding_type circle|rectangle: for a polygonal area
    // the particles are seeded in the rectangle that contains it.
    const seedParams = seedShape.type === 'circle'
      ? { seeding_type: 'circle', lon: seedShape.lon, lat: seedShape.lat, radius: seedShape.radius }
      : { seeding_type: 'rectangle', ...seedShapeBounds(seedShape) }

    setLoading(true)
    setStatus(t.status.running(t.modelLabels?.[model] ?? model))
    setStatusType('')
    setSimData(null)
    setIsPlaying(false)
    setCurrentStep(0)

    try {
      const jobId = await executeAsync(Process.OPENDRIFT, {
        model, start_time, number, duration_hours, ...seedParams,
      })
      setOpenDriftJobId(jobId)

      const { outcome } = await waitForJob(jobId)
      if (outcome === JobOutcome.DISMISSED) return

      const raw  = await fetchJobResults(jobId)
      const data = (raw.steps && raw.times) ? raw : (raw.trajectory ?? raw)
      if (!data.steps || !data.times) throw new Error(t.status.badResponse)

      const nParticles = data.steps[0].filter(Boolean).length
      setStatus(t.status.done(nParticles, data.times.length))
      setStatusType('ok')
      setSimData(data)
      setCurrentStep(0)
      setIsPlaying(true)

    } catch (err) {
      setStatus(t.status.error(describeError(err, t)))
      setStatusType('error')
    } finally {
      setLoading(false)
      setOpenDriftJobId(null)
      setOpenDriftStopping(false)
    }
  }

  async function handleRunPmar({ scenario_id, pressure, start_time, duration_days, pnum, res, margin, time_step_hours, shapefile_b64, geotiff_b64, title, info, indicator }) {
    if (analyses.length >= MAX_ANALYSES) return
    let inputs

    if (scenario_id) {
      inputs = { scenario_id, use_source: useSource, res, margin,
        ...(useSource === 'geotiff' && geotiff_b64  ? { geotiff_b64 }  : {}),
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
      }
    }

    setPmarLoading(true)
    setPmarStatus(t.pmar.btnRunning)
    setPmarStatusType('')
    let jobId
    try {
      jobId = await executeAsync(Process.PMAR, inputs)
    } catch (err) {
      showPmarError(err)
      setPmarLoading(false)
      return
    }
    await trackJob({ jobId, kind: 'pmar', title, info, areaGeoJSON: null, submittedAt: Date.now(),
                     view: indicator ? { indicator } : null })
  }

  async function handleRunConnectivity(inputs, { title, info } = {}) {
    if (analyses.length >= MAX_ANALYSES) return
    // The backend does not return the release area: it is taken from the selected
    // scenario now, because another one may be chosen during the wait.
    const areaAtStart = selectedScenarioId && selectedScenarioId === info?.scenario?.id
      ? scenarioAreaGeoJSON : null
    setConnectivityLoading(true)
    let jobId
    try {
      jobId = await executeAsync(Process.CONNECTIVITY, inputs)
    } catch (err) {
      setPmarErrorMsg(describeError(err, t))
      setConnectivityLoading(false)
      return
    }
    await trackJob({ jobId, kind: 'connectivity', title, info, areaGeoJSON: areaAtStart,
                     submittedAt: Date.now() })
  }

  async function handleRunMarkov(inputs, { title, info } = {}) {
    if (analyses.length >= MAX_ANALYSES) return
    const areaAtStart = selectedScenarioId && selectedScenarioId === info?.scenario?.id
      ? scenarioAreaGeoJSON : null
    setMarkovLoading(true)
    let jobId
    try {
      jobId = await executeAsync(Process.MARKOV, inputs)
    } catch (err) {
      setPmarErrorMsg(describeError(err, t))
      setMarkovLoading(false)
      return
    }
    await trackJob({ jobId, kind: 'markov', title, info, areaGeoJSON: areaAtStart,
                     submittedAt: Date.now() })
  }

  function showPmarError(err) {
    const clean = describeError(err, t)
      .replace(/^Error executing process:\s*/i, '')
      .replace(/^Errore:\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim()
    setPmarErrorMsg(clean)
    setPmarStatus('')
    setPmarStatusType('error')
  }

  /**
   * Follow a submitted analysis until its result and add it to the panel.
   *
   * The job stays in `pendingJobs` (saved in the browser) until it finishes: if the
   * page reloads in the meantime, at start it is resumed from here with `resumed`,
   * with its "running…" and its Stop. Network errors and backend restarts do not lose
   * it: it tries again, and if the network stays down the job stays pending for the
   * next reload.
   */
  async function trackJob(job, { resumed = false } = {}) {
    const pmar = job.kind === 'pmar'
    const [setLoadingOf, setJobIdOf, setStoppingOf] = {
      pmar:         [setPmarLoading, setPmarJobId, setPmarStopping],
      connectivity: [setConnectivityLoading, setConnectivityJobId, setConnectivityStopping],
      markov:       [setMarkovLoading, setMarkovJobId, setMarkovStopping],
    }[job.kind]
    setPendingJobs(prev => [...prev.filter(j => j.jobId !== job.jobId), job])
    setLoadingOf(true); setJobIdOf(job.jobId)
    if (pmar) { setPmarStatus(t.pmar.btnRunning); setPmarStatusType('') }
    let keepPending = false
    try {
      // ~1 minute of consecutive errors (3 s interval): the time of a restart.
      const { outcome } = await waitForJob(job.jobId, { maxTransientErrors: 20 })
      if (outcome === JobOutcome.DISMISSED) return

      const raw  = await fetchJobResults(job.jobId)
      const data = raw.result ?? raw
      if (pmar) finishPmar(job, data)
      else if (job.kind === 'markov') finishMarkov(job, data)
      else finishConnectivity(job, data)

    } catch (err) {
      keepPending = isTransientError(err)
      if (resumed && err instanceof OgcError && err.httpStatus === 404) {
        // Job expired or gone from the backend: there is nothing left to recover.
        notifications.show({
          title:   t.analyses.resumeLostTitle,
          message: t.analyses.resumeLostBody.replace('{title}', job.title ?? ''),
          color:   'orange',
        })
        if (pmar) setPmarStatus('')
      } else if (pmar) {
        showPmarError(err)
      } else {
        setPmarErrorMsg(describeError(err, t))
      }
    } finally {
      if (!keepPending) setPendingJobs(prev => prev.filter(j => j.jobId !== job.jobId))
      setLoadingOf(false); setJobIdOf(null); setStoppingOf(false)
    }
  }

  function finishPmar(job, data) {
    if (!data.raster_values || !data.bounds) throw new Error(t.status.badResponse)

    addAnalysis({
      kind: 'pmar',
      title: job.title || (lang === 'it' ? data.label_it : data.label_en) || 'PMAR',
      info: job.info, data, areaGeoJSON: data.seeding_geojson ?? null, view: job.view,
    })
    if (data.bounds && mapRef.current)
      mapRef.current.fitBounds(L.latLngBounds(data.bounds), FIT_PADDING)
    // Tool windows already open stay: they are snapshots of the analysis they were
    // made on, and "Close all" removes them.
    setActiveMapTool(null)
    setPmarStatus('')
    setPmarStatusType('')
    notifications.show({
      title:     t.pmar.analysisReadyTitle,
      message:   t.pmar.analysisReadyBody,
      color:     'green',
      icon:      <IconCircleCheck size={18} />,
      autoClose: 20000,
    })
  }

  function finishConnectivity(job, data) {
    if (!data.polygons_geojson) throw new Error(t.status.badResponse)

    // Each analysis has its own node selection: the indices of another network would
    // mean nothing here.
    addAnalysis({
      kind: 'connectivity',
      title: job.title || (lang === 'it' ? data.label_it : data.label_en) || 'Connectivity',
      info: job.info, data, areaGeoJSON: job.areaGeoJSON ?? null,
    })
    if (data.bounds && mapRef.current)
      mapRef.current.fitBounds(L.latLngBounds(data.bounds), FIT_PADDING)

    const warnings = (data.warnings ?? []).map(w => describeWarning(w, t)).filter(Boolean)
    notifications.show({
      title:     t.pmar.analysisReadyTitle,
      message:   warnings.length === 0 ? t.pmar.analysisReadyBody
               : warnings.length === 1 ? warnings[0]
               : (
                 <ul style={{ margin: 0, paddingLeft: 18 }}>
                   {warnings.map((w, i) => <li key={i}>{w}</li>)}
                 </ul>
               ),
      color:     warnings.length ? 'yellow' : 'green',
      icon:      <IconCircleCheck size={18} />,
      autoClose: 20000,
    })
  }

  function finishMarkov(job, data) {
    if (!data.frames?.length || !data.grid) throw new Error(t.status.badResponse)
    addAnalysis({
      kind: 'markov',
      title: job.title || (lang === 'it' ? data.label_it : data.label_en) || 'Markov',
      info: job.info, data, areaGeoJSON: job.areaGeoJSON ?? null,
    })
    if (data.bounds && mapRef.current)
      mapRef.current.fitBounds(L.latLngBounds(data.bounds), FIT_PADDING)
    setActiveMapTool(null)
    const warnings = (data.warnings ?? []).map(w => describeWarning(w, t)).filter(Boolean)
    notifications.show({
      title:     t.pmar.analysisReadyTitle,
      message:   warnings.length === 0 ? t.pmar.analysisReadyBody
               : warnings.length === 1 ? warnings[0]
               : (
                 <ul style={{ margin: 0, paddingLeft: 18 }}>
                   {warnings.map((w, i) => <li key={i}>{w}</li>)}
                 </ul>
               ),
      color:     warnings.length ? 'yellow' : 'green',
      icon:      <IconCircleCheck size={18} />,
      autoClose: 20000,
    })
  }

  // ── Persistence in the browser ─────────────────────────────────────────
  // At start: saved analyses, and resumption of the jobs still running.
  useEffect(() => {
    let cancelled = false
    loadState().then(raw => {
      if (cancelled) return
      const stored = fromStored(raw, { max: MAX_ANALYSES, defaultView: DEFAULT_VIEW })
      if (stored.analyses.length) {
        setAnalyses(prev => mergeAnalyses(prev, stored.analyses, MAX_ANALYSES))
        setActiveAnalysisId(id => id ?? stored.activeAnalysisId)
      }
      setStoreLoaded(true)
      // One per type: the page follows one at a time (a single "running…" and Stop).
      const seen = new Set()
      for (const job of stored.pendingJobs) {
        if (seen.has(job.kind)) continue
        seen.add(job.kind)
        trackJob(job, { resumed: true })
      }
    })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Save at every change, batched; never before the saved state has been read, which
  // would otherwise be overwritten by the empty panel at start.
  useEffect(() => {
    if (!storeLoaded) return
    const timer = setTimeout(() => {
      saveState(toStored({ analyses, activeAnalysisId, pendingJobs }, { max: MAX_ANALYSES }))
    }, 300)
    return () => clearTimeout(timer)
  }, [storeLoaded, analyses, activeAnalysisId, pendingJobs])

  // ── Management of the saved analyses ────────────────────────────────────
  /**
   * Each analysis keeps its own release area (`areaGeoJSON`): the base layer
   * "Seeding area" shows it when no simulation is selected on the left.
   */
  function addAnalysis({ kind, title, info, data, areaGeoJSON = null, view = null }) {
    const id = `an-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setAnalyses(prev => (prev.length >= MAX_ANALYSES ? prev
      : [{ id, kind, title, info, data, areaGeoJSON, createdAt: Date.now(),
           view: { ...DEFAULT_VIEW, ...view } }, ...prev]))
    setActiveAnalysisId(id)
  }

  /** Update the view of an analysis; `patch` is an object or a function of the view. */
  function updateView(id, patch) {
    setAnalyses(prev => prev.map(a => (a.id !== id ? a
      : { ...a, view: { ...a.view, ...(typeof patch === 'function' ? patch(a.view) : patch) } })))
  }

  function renameAnalysis(id, title) {
    setAnalyses(prev => prev.map(a => (a.id === id ? { ...a, title } : a)))
  }

  function clearAnalyses() {
    setAnalyses([])
    setActiveAnalysisId(null)
    setShowConnMatrix(null)
  }

  /** When the active one is deleted, the most recent remaining one becomes active. */
  function deleteAnalysis(id) {
    const rest = analyses.filter(a => a.id !== id)
    setAnalyses(rest)
    if (id === activeAnalysisId) setActiveAnalysisId(rest[0]?.id ?? null)
    if (showConnMatrix === id) setShowConnMatrix(null)
  }

  /** Click on a polygon: isolate its edges; a second click on the same one deselects it. */
  function handleSelectNode(analysisId, nodeId) {
    setActiveAnalysisId(analysisId)
    // Switch the arrows back on: with the arrows off, the click would show nothing.
    updateView(analysisId, v => ({ selectedNode: v.selectedNode === nodeId ? null : nodeId,
                                   showEdges: true }))
  }

  const connectivityLabels = useMemo(() => ({
    inStrength:  t.pmarControls.metricInStrength,
    outStrength: t.pmarControls.metricOutStrength,
    betweenness: t.pmarControls.metricBetweenness,
    weak:        t.pmar.connectivity.weakWarning.replace('{n}', connectivityData?.min_particles ?? 30),
  }), [t, connectivityData?.min_particles])

  // Raster of the chosen indicator, computed once per analysis and indicator: a new
  // object at every render would make PmarLayer recreate its canvas.
  const rasterCache = useRef(new WeakMap())
  const rasterOf = useCallback(a => {
    const key = rasterKeyOf(a)
    let byKey = rasterCache.current.get(a.data)
    if (!byKey) { byKey = new Map(); rasterCache.current.set(a.data, byKey) }
    if (!byKey.has(key)) {
      byKey.set(key, a.kind === 'markov'
        ? markovRaster(a.data, a.view.frame)
        : getActivePmarData(a.data, a.view.indicator))
    }
    return byKey.get(key)
  }, [])
  const activePmarData = useMemo(
    () => (activePmar ? rasterOf(activePmar) : null),
    [activePmar?.data, activeIndicator, rasterOf], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // The tools work on positive values: not on the difference map.
  const rasterTools = !!activePmarData && activePmarData.scale !== 'diverging'

  // ── Interactive legend: classes, counts and switched-on classes per layer ──
  const [ppiHighlight,    setPpiHighlight]    = useState(() => new Set())
  const [metricHighlight, setMetricHighlight] = useState(() => new Set())
  const [edgeHighlight,   setEdgeHighlight]   = useState(() => new Set())
  // A selection applies to the data it was made on: a new result, indicator or measure
  // clears it.
  useEffect(() => { setPpiHighlight(new Set()) }, [activePmarData])
  useEffect(() => { setMetricHighlight(new Set()) }, [connectivityData, connectivityMetric])
  useEffect(() => { setEdgeHighlight(new Set()) }, [connectivityData])

  const ppiClasses = useMemo(
    () => (activePmarData?.scale === 'diverging' ? divergingClasses(activePmarData.dmax)
         : activePmarData?.vmax > 0 ? logClasses(activePmarData.vmin, activePmarData.vmax) : null),
    [activePmarData],
  )
  const metricClasses = useMemo(() => {
    const range = connectivityData?.metric_ranges?.[connectivityMetric]
    return range ? linearClasses(range[0], range[1]) : null
  }, [connectivityData, connectivityMetric])

  const legendSections = useMemo(() => {
    const out = []
    const L = t.legend
    if (pmarData && activePmar.view.visible && ppiClasses) {
      const diverging = activePmarData.scale === 'diverging'
      const counts = countByClass(activePmarData.raster_values.flat().filter(v => v !== 0), ppiClasses)
      const ind = INDICATOR_LABEL_KEYS[activeIndicator]
      const title = activePmar.kind === 'markov'
        ? `${t.pmar.markov.legendTitle} · ${t.pmar.markov.dayN.replace('{d}',
            formatDay(frameDay(pmarData, activePmarData.frame)))}`
        : `${t.pmarControls.colorbarLabel}${ind && activeIndicator !== 'ppi' ? ` · ${t.pmarControls[ind]}` : ''}`
      out.push({
        key: 'ppi',
        title,
        rows: legendRows(ppiClasses, counts, formatBound, c => {
          const [r, g, b] = (diverging ? divergingColor : spectralR)(c.t); return { color: `rgb(${r},${g},${b})` }
        }),
        selected: ppiHighlight, onToggle: toggleIn(setPpiHighlight), onReset: () => setPpiHighlight(new Set()),
      })
    }
    if (connectivityData && activeConn.view.visible && metricClasses) {
      const feats = connectivityData.polygons_geojson?.features ?? []
      const reliable = feats.filter(f => f.properties?.reliable)
      const counts = countByClass(reliable.map(f => f.properties[connectivityMetric]), metricClasses)
      const rows = legendRows(metricClasses, counts, formatBound, c => {
        const [r, g, b] = spectralR(c.t); return { color: `rgb(${r},${g},${b})` }
      })
      const weak = feats.length - reliable.length
      if (weak > 0) rows.push({ label: L.unreliable, count: weak, swatch: { color: '#94a3b8', dashed: true } })
      out.push({
        key: 'metric',
        title: t.pmarControls[METRIC_LABEL_KEYS[connectivityMetric]],
        rows,
        selected: metricHighlight, onToggle: toggleIn(setMetricHighlight), onReset: () => setMetricHighlight(new Set()),
      })
    }
    const edgeFeats = connectivityData?.edges_geojson?.features ?? []
    if (connectivityData && activeConn.view.visible && activeConn.view.showEdges && edgeFeats.length) {
      // Only the curves: each connection also has an arrowhead, which must not be counted.
      const ps = edgeFeats.filter(f => f.geometry?.type === 'LineString').map(f => f.properties?.p)
      const counts = countByClass(ps, PROBABILITY_BANDS)
      out.push({
        key: 'edges',
        title: L.edgesTitle,
        // Width as in PMAR (1–8 px linear in p), reduced to fit in the legend.
        rows: legendRows(PROBABILITY_BANDS, counts, formatPercent,
                         c => ({ line: true, color: redsColor(c.t), width: 1 + c.t * 5 })),
        selected: edgeHighlight, onToggle: toggleIn(setEdgeHighlight), onReset: () => setEdgeHighlight(new Set()),
      })
    }
    return out
  }, [t, pmarData, activePmar, ppiClasses, activePmarData, activeIndicator, ppiHighlight,
      connectivityData, activeConn, metricClasses, connectivityMetric, metricHighlight,
      edgeHighlight])

  /**
   * Context for the tool files, taken from the analysis active at the moment of the
   * selection: if another analysis is activated later, the file still says where it
   * comes from.
   */
  function toolMeta() {
    const a = activePmar
    if (!a) return {}
    const sc = a.info?.scenario ?? {}
    if (a.kind === 'markov') {
      const d = a.data, r = activePmarData
      return {
        title: a.title,
        scenario: { label: sc.label_en || sc.label_it, start_time: sc.start_time,
                    duration_days: sc.duration_days, pnum: sc.pnum, seedings: sc.seedings },
        sourceLayer: 'particle distribution at t=0',
        valueLabel: `Markov chain particles per cell, step ${r.frame} × Δt ${d.dt_days} d = day ${frameDay(d, r.frame)}`,
        res: r.raster_res,
      }
    }
    const src = a.info?.params?.use_source
    const ind = a.view.indicator
    return {
      title: a.title,
      scenario: { label: sc.label_en || sc.label_it, start_time: sc.start_time,
                  duration_days: sc.duration_days, pnum: sc.pnum, seedings: sc.seedings },
      sourceLayer: EXPORT_SOURCE_LABELS[src] ?? src,
      valueLabel: (EXPORT_VALUE_LABELS[ind] ?? ind)
        + (ind === 'ppi' && src && src !== 'none' ? ', weighted by the source layer' : ''),
      res: activePmarData?.raster_res,
    }
  }

  function handleStatsResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const stats = computeStats(rd.raster_values, snap.colMin, snap.colMax, snap.rowMin, snap.rowMax)
    setStatsEntries(prev => [...prev, { id: Date.now(), layer, result: { ...snap, stats, meta: toolMeta() } }])
  }

  function handleProfileResult(lineData, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const { latA, lonA, latB, lonB } = lineData
    const profile = sampleProfile(latA, lonA, latB, lonB, rd)
    setProfileEntries(prev => [...prev, {
      id: Date.now(), layer,
      result: {
        ...profile,
        meta: toolMeta(),
        snapLatMin: Math.min(latA, latB),
        snapLatMax: Math.max(latA, latB),
        snapLonMin: Math.min(lonA, lonB),
        snapLonMax: Math.max(lonA, lonB),
      },
    }])
  }

  function handleThresholdResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    // With the latitude of each cell: the area of a cell depends on cos(lat).
    const cells = []
    for (let r = snap.rowMin; r <= snap.rowMax; r++)
      for (let c = snap.colMin; c <= snap.colMax; c++) {
        const v = rd.raster_values[r]?.[c]
        if (v > 0 && isFinite(v)) cells.push({ v, lat: rd.raster_lat_min + r * rd.raster_res })
      }
    setThresholdEntries(prev => [...prev, {
      id: Date.now(), layer,
      result: { ...snap, cells, vmin: rd.vmin, vmax: rd.vmax, rasterRes: rd.raster_res, meta: toolMeta() },
    }])
  }

  /** All the cells of the rectangle, zeros included, with id, centre and area. */
  function handleCsvResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    saveText(cellsCsv(rd, snap, toolMeta()), `pmar_cells_${Date.now()}.csv`)
    setTimeout(() => layer?.remove(), 1500)
  }

  function handleComparisonResult(snap, layer, rd) {
    if (!rd) { layer?.remove(); return }
    const hist = computeHistogramFromSnap(snap, rd)
    if (!hist) { layer?.remove(); return }
    setComparisonAreas(prev => [...prev, { id: Date.now(), result: { ...hist, ...snap, meta: toolMeta() }, layer }])
  }

  function handleCloseAll() {
    setHistograms(prev       => { prev.forEach(h => h.layer?.remove()); return [] })
    setStatsEntries(prev     => { prev.forEach(h => h.layer?.remove()); return [] })
    setProfileEntries(prev   => { prev.forEach(h => h.layer?.remove()); return [] })
    setThresholdEntries(prev => { prev.forEach(h => h.layer?.remove()); return [] })
    setComparisonAreas(prev  => { prev.forEach(a => a.layer?.remove()); return [] })
    setShowConnMatrix(null)
  }

  /**
   * "Download raster" of a card. PMAR: the backend's GeoTIFF for the indicator shown.
   * Propagate: the frame and level shown, written here. Connectivity on a grid: the
   * chosen measure, one cell per node; on polygons there is no raster, so the polygons
   * are downloaded with the measures (GeoJSON). The file name is the title.
   */
  function handleDownloadLayer(an) {
    const stem = fileStem(an.title, an.kind)
    if (an.kind === 'pmar') {
      const ind = an.view.indicator || 'ppi'
      const b64 = an.data[ind === 'ppi' ? 'geotiff_b64' : `${ind}_geotiff_b64`]
      if (b64) saveBytes(base64ToBytes(b64), `${stem}_${ind}.tif`, 'image/tiff')
      return
    }
    if (an.kind === 'markov') {
      const r = rasterOf(an)
      const bytes = encodeGeoTiff({
        values: r.raster_values, lon_min: r.raster_lon_min, lat_min: r.raster_lat_min,
        res: r.raster_res, nx: r.raster_nx, ny: r.raster_ny,
      })
      saveBytes(bytes, `${stem}_step${r.frame}.tif`, 'image/tiff')
      return
    }
    const raster = connectivityRaster(an.data, an.view.metric)
    if (raster) {
      saveBytes(encodeGeoTiff(raster), `${stem}_${an.view.metric}.tif`, 'image/tiff')
    } else {
      saveText(JSON.stringify(an.data.polygons_geojson), `${stem}.geojson`, 'application/geo+json')
    }
  }

  // ── Base layers (right-hand panel) ─────────────────────────────────────────
  // The panel shows those of the selected analysis layer; with no layer selected, those
  // of the previews of the left panel. The area and study area of the simulation chosen
  // on the left are not drawn as a preview if an analysis of that simulation already
  // exists: its card controls them.
  const selectedCovered = !!selectedScenarioId
    && analyses.some(a => a.info?.scenario?.id === selectedScenarioId)
  const previewStudy = useMemo(() => studyBoundsOf(selectedScenario), [selectedScenario])
  const previewGrid  = selectedScenarioId
    ? analyses.find(a => a.kind === 'connectivity' && a.info?.scenario?.id === selectedScenarioId) ?? null
    : null

  const baseLayerRows = (() => {
    const l = t.layers
    const loc = (it, en) => (lang === 'it' ? it : en) || it || en
    const areaLabel = sc => {
      const name = sc && loc(sc.area_it, sc.area_en)
      return name && !/^(Area personalizzata|Custom area)$/.test(name) ? name : loc(sc?.label_it, sc?.label_en)
    }
    const sourceLabel = key => t.pmar.useSources[key]
    const SW = {
      seed:   { border: '2px dashed #0a84ff', background: 'rgba(100,210,255,0.25)' },
      study:  { border: '1.5px dashed #64748b' },
      source: { background: '#7b5cc4' },
      grid:   { border: '1.5px solid var(--text-secondary)' },
    }
    const a = activeAnalysis
    let rows
    if (a) {
      const sc = a.info?.scenario
      const grid = gridOf(a, analyses)
      rows = [
        { key: 'seed', subtitle: a.areaGeoJSON ? areaLabel(sc) : l.notAvailable, available: !!a.areaGeoJSON },
        { key: 'study', subtitle: studyBoundsOf(sc) ? l.studySub : l.notAvailable, available: !!studyBoundsOf(sc) },
        ...(hasSourceLayer(a) ? [{ key: 'source', available: true, subtitle: sourceLabel(
              a.info?.params?.use_source) }] : []),
        { key: 'grid', subtitle: grid ? grid.title : l.gridNone, available: !!grid },
      ].map(r => ({ ...r, on: baseOf(a)[r.key] }))
    } else {
      rows = [
        { key: 'seed', available: !!(scenarioAreaGeoJSON || seedShape || t4mspPreviewGeoJSON),
          subtitle: scenarioAreaGeoJSON ? areaLabel(selectedScenario)
                  : seedShape ? l.seedDrawn : t4mspPreviewGeoJSON ? l.seedPredefined : l.seedNone },
        { key: 'study', subtitle: previewStudy ? l.studySub : l.studyNone, available: !!previewStudy },
        ...(previewSource ? [{ key: 'source', available: true, subtitle: sourceLabel(previewSource) }] : []),
        { key: 'grid', subtitle: previewGrid ? previewGrid.title : l.gridNone, available: !!previewGrid },
      ].map(r => ({ ...r, on: previewBase[r.key] }))
    }
    return rows.map(r => ({ ...r, title: l[r.key], swatch: SW[r.key] }))
  })()

  function toggleBase(key) {
    const a = activeAnalysis
    if (a) updateView(a.id, v => ({ base: { ...DEFAULT_BASE, ...v.base, [key]: !baseOf({ view: v })[key] } }))
    else setPreviewBase(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Transition matrices on a generated grid: the only ones Propagate can reuse.
  const transitionMatrices = analyses
    .filter(a => a.kind === 'connectivity' && a.data.mode === 'transition'
              && a.data.node_source === 'grid' && a.data.grid_bbox && a.data.grid_res)
    .map(a => ({ id: a.id, title: a.title, scenarioId: a.info?.scenario?.id,
                 res: a.data.grid_res, bbox: a.data.grid_bbox, tDays: a.data.t_days }))

  const activeMarkov = activeAnalysis?.kind === 'markov' && activeAnalysis.view.visible ? activeAnalysis : null
  const toolsVisible = analyses.length > 0

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
          url={`https://basemaps.cartocdn.com/rastertiles/${mapTheme}_all/{z}/{x}/{y}{r}.png?key=cb1_4afp_1_b906152c4dcc975006348ae1`}
          attribution='© OpenStreetMap · © CARTO'
          maxZoom={19}
        />
        <SimLayer simData={simData} currentStep={currentStep} />
        {/* ── Base layers: study area below everything, then the release area. Those
             of each visible analysis according to its switches, then the previews. ── */}
        {[...analyses].reverse().filter(a => a.view.visible).map(a => {
          const b = baseOf(a)
          return (
            <BaseLayersOf key={a.id} analysis={a} base={b} />
          )
        })}
        <StudyAreaLayer bounds={previewStudy} visible={previewBase.study && !selectedCovered} />
        <SeedingAreaLayer geojson={scenarioAreaGeoJSON}
                          visible={previewBase.seed && !!scenarioAreaGeoJSON && !selectedCovered} />
        <SeedingAreaLayer geojson={t4mspPreviewGeoJSON} visible={previewBase.seed && !!t4mspPreviewGeoJSON} />
        {/* ── PMAR and Propagate heatmaps: one per layer, from the oldest to the most
             recent, so the most recent is on top. ── */}
        {[...analyses].reverse().filter(a => a.kind === 'pmar' || a.kind === 'markov').map(a => {
          const isActive = a.id === activeAnalysisId
          const raster = rasterOf(a)
          return (
            <PmarLayer
              key={a.id}
              pmarData={raster}
              visible={a.view.visible}
              interactive={isActive}
              opacity={a.view.opacity ?? 0.8}
              passagesLabel={a.kind === 'markov' ? t.pmar.markov.tooltipParticles : t.pmarControls.tooltipPassages}
              classes={isActive ? ppiClasses : null}
              highlight={isActive ? ppiHighlight : NO_HIGHLIGHT}
            />
          )
        })}
        {/* ── Source layer: of each visible analysis that keeps it on, and the
             preview chosen on the left. ── */}
        {[...analyses].reverse().filter(a => a.view.visible && hasSourceLayer(a)).map(a => (
          <AnalysisSourceLayers key={a.id} analysis={a} visible={baseOf(a).source} />
        ))}
        <WindFarmsLayer geojson={windfarmsGeoJSON} visible={previewBase.source} />
        <OffshoreInstallationsLayer geojson={offshoreGeoJSON} visible={previewBase.source} />
        <MspZonesLayer geojson={mspZonesGeoJSON} visible={previewBase.source} />
        {/* ── Connectivity analyses ── */}
        {[...analyses].reverse().filter(a => a.kind === 'connectivity').map(a => {
          const isActive = a.id === activeAnalysisId
          return (
            <ConnectivityAnalysisLayers
              key={a.id}
              analysis={a}
              labels={connectivityLabels}
              onSelectNode={handleSelectNode}
              metricClasses={isActive ? metricClasses : null}
              metricHighlight={isActive ? metricHighlight : NO_HIGHLIGHT}
              edgeHighlight={isActive ? edgeHighlight : NO_HIGHLIGHT}
              visible={a.view.visible}
            />
          )
        })}
        {[...analyses].reverse().filter(a => a.view.visible && baseOf(a).grid).map(a => (
          <GridOutlineLayer key={a.id} geojson={gridOf(a, analyses)?.data.polygons_geojson ?? null} visible />
        ))}
        <GridOutlineLayer geojson={previewGrid?.data.polygons_geojson ?? null}
                          visible={previewBase.grid && !activeAnalysis} />
        <SeedDrawer
          drawMode={drawTarget === 'seed' ? drawMode : null}
          seedShape={seedShape}
          showSeedShape={showSeedShape && previewBase.seed && !scenarioAreaGeoJSON}
          onShapeDone={handleShapeDone}
        />
        {['connBbox', 'propBbox'].map(target => (
          <SeedDrawer
            key={target}
            palette="bbox"
            drawMode={drawTarget === target ? drawMode : null}
            seedShape={extraShapes[target]}
            showSeedShape={extraVisible[target]}
            onShapeDone={handleShapeDone}
          />
        ))}
        {rasterTools && (
          <HistogramDrawLayer
            active={activeMapTool === 'histogram'}
            rasterData={activePmarData}
            onResult={(result, layer) =>
              setHistograms(prev => [...prev, { id: Date.now(), result: { ...result, meta: toolMeta() }, layer }])
            }
          />
        )}
        {rasterTools && ['stats', 'threshold', 'csv', 'comparison'].includes(activeMapTool) && (
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
        {rasterTools && activeMapTool === 'profile' && (
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

      {/* Theme and language: top left, next to the main panel. */}
      <div className="map-toolbar">
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
        onStopOpenDrift={async () => { if (openDriftJobId) { setOpenDriftStopping(true); await dismissJob(openDriftJobId) } }}
        openDriftStopping={openDriftStopping}
        status={status}
        statusType={statusType}
        pmarLoading={pmarLoading}
        onStopPmar={async () => { if (pmarJobId) { setPmarStopping(true); await dismissJob(pmarJobId) } }}
        pmarStopping={pmarStopping}
        pmarStatus={pmarStatus}
        pmarStatusType={pmarStatusType}
        drawMode={drawTarget === 'seed' ? drawMode : null}
        onStartDraw={handleStartDraw}
        onFinishDraw={handleFinishDraw}
        onUndoLastPolygon={handleUndoLastPolygon}
        onClearSeedShape={handleClearSeedShape}
        seedShape={seedShape}
        activeTool={activeTool}
        onToolChange={handleToolChange}
        useSource={useSource}
        onUseSourceChange={setUseSource}
        onAnalysisMarginChange={setAnalysisMargin}
        windfarmsLoading={windfarms.loading}
        windfarmsEmpty={windfarms.isEmpty}
        offshoreLoading={offshore.loading}
        offshoreEmpty={offshore.isEmpty}
        mspZonesLoading={mspZones.loading}
        mspZonesEmpty={mspZones.isEmpty}
        onT4mspPreview={setT4mspPreviewGeoJSON}
        onScenarioArea={handleScenarioArea}
        onRunConnectivity={handleRunConnectivity}
        analysesFull={analyses.length >= MAX_ANALYSES}
        connectivityLoading={connectivityLoading}
        connectivityStopping={connectivityStopping}
        onStopConnectivity={async () => {
          if (connectivityJobId) { setConnectivityStopping(true); await dismissJob(connectivityJobId) }
        }}
        markov={{
          onRun: handleRunMarkov,
          loading: markovLoading,
          stopping: markovStopping,
          onStop: async () => { if (markovJobId) { setMarkovStopping(true); await dismissJob(markovJobId) } },
        }}
        draw={{
          shapes: extraShapes,
          mode: drawTarget === 'seed' ? null : drawMode,
          target: drawTarget,
          onStart: handleStartDraw,
          onFinish: handleFinishDraw,
          onUndo: handleUndoLastPolygon,
          onClear: handleClearSeedShape,
          onVisible: (target, on) => setExtraVisible(prev => (prev[target] === on ? prev : { ...prev, [target]: on })),
        }}
        matrices={transitionMatrices}
      />

      <MapLegend sections={legendSections} labels={t.legend} />

      {activeMarkov && (
        <MarkovStepper an={activeMarkov} onView={patch => updateView(activeMarkov.id, patch)} />
      )}

      <LayersPanel
        compact={toolsVisible}
        baseLayers={baseLayerRows}
        onToggleBase={toggleBase}
        baseSubject={activeAnalysis ? activeAnalysis.title : null}
        analyses={analyses}
        activeId={activeAnalysisId}
        onActivate={setActiveAnalysisId}
        onDelete={deleteAnalysis}
        onClearAll={clearAnalyses}
        onRename={renameAnalysis}
        onUpdateView={updateView}
        onDownload={handleDownloadLayer}
        onOpenMatrix={id => { setActiveAnalysisId(id); setShowConnMatrix(v => (v === id ? null : id)) }}
        matrixOpenId={showConnMatrix}
      />

      {toolsVisible && (
        <ToolsPanel
          activeMapTool={activeMapTool}
          onSetTool={toggleTool}
          hasRaster={rasterTools}
          windowCounts={{
            histogram:  histograms.length,
            stats:      statsEntries.length,
            profile:    profileEntries.length,
            threshold:  thresholdEntries.length,
            comparison: comparisonAreas.length,
          }}
          openWindowCount={histograms.length + statsEntries.length + profileEntries.length
            + thresholdEntries.length + comparisonAreas.length + (showConnMatrix ? 1 : 0)}
          onCloseAll={handleCloseAll}
        />
      )}

      {(() => {
        // The matrix is that of the analysis active when it was opened.
        const an = showConnMatrix && analyses.find(a => a.id === showConnMatrix)
        return an ? (
          <PmarConnectivityMatrix
            data={an.data}
            onClose={() => setShowConnMatrix(null)}
            stackIndex={0}
          />
        ) : null
      })()}

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
