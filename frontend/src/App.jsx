import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { Modal, ActionIcon, Text, Button, Group, useMantineColorScheme } from '@mantine/core'
import { IconSun, IconMoon, IconCircleCheck } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { MODEL_STYLES } from './constants'
import { useLang } from './LanguageContext'
import { Process, ErrorCode, JobOutcome, OgcError, ACCESS_DENIED,
         executeAsync, waitForJob, fetchJobResults, dismissJob,
         fetchFeatureLayer } from './api/ogcProcesses'
import { usePreviewLayer } from './hooks/usePreviewLayer'
import Panel from './components/Panel'
import SeedDrawer from './components/SeedDrawer'
import AnimationControls from './components/AnimationControls'
import AnalysesPanel, { MAX_ANALYSES } from './components/AnalysesPanel'
import { HistogramDrawLayer, PmarHistogramModal, MapRefSetter, ConnectorLine,
         RectSelectionLayer, LineSelectionLayer, computeHistogramFromSnap } from './components/PmarHistogram'
import { computeStats, PmarStatsModal } from './components/PmarStats'
import { PmarThresholdModal } from './components/PmarThreshold'
import { PmarComparisonModal } from './components/PmarComparison'
import { sampleProfile, PmarProfileModal } from './components/PmarProfile'
import { seedShapeToGeoJSON, seedShapeBounds } from './geometry/seedShape'
import { cellsCsv } from './export/pmarTools'
import { saveText } from './export/download'
import { spectralR, logNorm, linNorm, logClasses, linearClasses, classIndex,
         PROBABILITY_BANDS, redsColor, formatBound, formatPercent } from './legend/classes'
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
    // Nascosto = non disegnato: con la sola trasparenza restava nel DOM, e un
    // layer ricreato mentre era nascosto ricompariva.
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
      } catch { /* geometria non valida, skip */ }
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
    // Nascosto = non disegnato: con la sola trasparenza restava nel DOM, e un
    // layer ricreato mentre era nascosto ricompariva.
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
      } catch { /* geometria non valida, skip */ }
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
    // Nascosto = non disegnato: con la sola trasparenza restava nel DOM, e un
    // layer ricreato mentre era nascosto ricompariva.
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
      } catch { /* geometria non valida, skip */ }
    })

    return () => {
      layerRef.current?.remove()
      markersRef.current.forEach(m => m.remove())
    }
  }, [geojson, visible, map])

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

// ── Connectivity polygons layer ───────────────────────────────────────────────
/**
 * Draws the user's polygons filled by the selected connectivity metric.
 *
 * Unmounts on !visible rather than calling setStyle(): setStyle() applies one style
 * to the whole group and would flatten the per-feature colours.
 */
function ConnectivityLayer({ data, metric, visible, labels, selectedNode, onSelectNode,
                            classes, highlight }) {
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
        // Il selezionato si distingue solo per il bordo: cambiare anche il
        // riempimento lo toglierebbe dalla scala di colore della metrica.
        const picked = pr.node_id === selectedNode
        if (highlight?.size && !highlight.has(classIndex(pr[metric], classes))) {
          return { color: picked ? '#ffffff' : DIMMED_LINE, fillColor: DIMMED_LINE,
                   fillOpacity: 0.12, weight: picked ? 3 : 1, opacity: picked ? 1 : 0.5 }
        }
        const [r, g, b] = spectralR(linNorm(pr[metric], vmin, vmax) ?? 0)
        return { color: picked ? '#ffffff' : '#1e293b', fillColor: `rgb(${r},${g},${b})`,
                 fillOpacity: 0.72, weight: picked ? 3 : 1, opacity: picked ? 1 : 0.9 }
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
          // Sopra il cursore: sotto ci va il tooltip delle celle del raster, così
          // con i due layer accesi insieme non si coprono a vicenda.
          { sticky: true, direction: 'top', offset: [0, -12], className: 'pmar-map-tooltip' }
        )

        // Il click isola gli archi del poligono. `stopPropagation` evita che
        // risalga alla mappa, dove SeedDrawer ha il suo gestore di disegno.
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          onSelectNode?.(pr.node_id)
        })
      },
    }).addTo(map)

    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [data, metric, visible, map, labels, selectedNode, onSelectNode, classes, highlight])

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
      pane.style.zIndex = 450          // sopra overlayPane (400), sotto i marker (600)
      // Senza questo il pane intercetterebbe il mouse al posto dei poligoni
      // sottostanti, e il click che isola gli archi smetterebbe di funzionare.
      pane.style.pointerEvents = 'none'
    }

    layerRef.current = L.geoJSON(geojson, {
      pane: EDGES_PANE,
      style: f => {
        const pr = f.properties ?? {}
        // Fuori dalle fasce di probabilità scelte in legenda: attenuato, non tolto.
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
        // Un auto-anello (source === target) è insieme entrante e uscente,
        // quindi resta visibile in tutte e tre le modalità.
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
      // Puro contorno dell'area di studio: nulla vi è associato. Lasciandolo
      // interattivo si prenderebbe l'hover dei poligoni di connettività, perché
      // compare dopo l'analisi PMAR e finisce quindi sopra di loro nel pane SVG.
      interactive: false,
    }).addTo(map)
    return () => { layerRef.current?.remove(); layerRef.current = null }
  }, [geojson, visible, map])

  return null
}

// ── PMAR raster overlay (canvas layer con hover per cella) ───────────────────
// Colore delle celle, poligoni e frecce attenuati dalla legenda interattiva.
const DIMMED_FILL = 'rgba(148,163,184,0.18)'
const DIMMED_LINE = '#94a3b8'

function PmarLayer({ pmarData, visible, passagesLabel, classes, highlight, interactive = true }) {
  const map          = useMap()
  const canvasRef    = useRef(null)
  const tooltipRef   = useRef(null)
  const drawRef      = useRef(null)
  const labelRef     = useRef(passagesLabel)
  labelRef.current   = passagesLabel
  const visibleRef   = useRef(visible)
  visibleRef.current = visible
  // Lette da draw(), registrato una volta sola: le ref evitano di ricreare il canvas
  // a ogni clic sulla legenda.
  const highlightRef = useRef(highlight)
  highlightRef.current = highlight
  // Con più heatmap sulla mappa il tooltip lo apre solo quella dell'analisi attiva.
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  const classesRef   = useRef(classes)
  classesRef.current = classes

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
          const hl = highlightRef.current
          if (hl?.size && !hl.has(classIndex(val, classesRef.current))) {
            ctx.fillStyle = DIMMED_FILL
          } else {
            const [r, g, b] = spectralR(t)
            ctx.fillStyle = `rgba(${r},${g},${b},0.82)`
          }
          ctx.fillRect(x, y, w, h)
        }
      }
    }

    function onMouseMove(e) {
      // Il raster nascosto non deve lasciare in giro il suo tooltip: senza questo
      // controllo il primo movimento del mouse lo rimostrerebbe su celle invisibili.
      if (!visibleRef.current || !interactiveRef.current) { tooltip.style.display = 'none'; return }

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

          // Sotto il cursore: sopra ci va il tooltip dei poligoni di connettività.
          // Vicino al bordo inferiore della mappa si ribalta sopra, altrimenti
          // uscirebbe dal riquadro proprio dove serve.
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

  // Clic sulla legenda: si ridisegna lo stesso canvas con le nuove classi accese.
  useEffect(() => { drawRef.current?.() }, [highlight, classes])

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
 * Testo di un avviso del backend nella lingua corrente. Il backend manda `code` e
 * numeri, non frasi: altrimenti l'avviso arriverebbe in una lingua sola. Un codice
 * sconosciuto ricade sul `message` inglese del backend.
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

// ── Legenda interattiva ──────────────────────────────────────────────────────
const INDICATOR_LABEL_KEYS = {
  ppi: 'indicatorDensity', sum: 'indicatorSum', max: 'indicatorMax', q90: 'indicatorQ90', std: 'indicatorStd',
}
const METRIC_LABEL_KEYS = {
  in_strength: 'metricInStrength', out_strength: 'metricOutStrength', betweenness: 'metricBetweenness',
}

/** Etichetta di una classe: estremi aperti in basso e in alto, intervallo in mezzo. */
function classLabel(c, i, n, fmt) {
  if (i === 0)     return `< ${fmt(c.to)}`
  if (i === n - 1) return `≥ ${fmt(c.from)}`
  return `${fmt(c.from)} – ${fmt(c.to)}`
}

/** Conta quanti valori cadono in ogni classe (null = senza classe, ignorati). */
function countByClass(values, classes) {
  const counts = new Array(classes.length).fill(0)
  for (const v of values) {
    const i = classIndex(v, classes)
    if (i !== null) counts[i]++
  }
  return counts
}

/** Righe di legenda dall'alto (valori alti) in basso, come la vecchia colorbar. */
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

// Layer EMODnet che un risultato PMAR può portarsi dietro.
const SOURCE_LAYER_COMPONENTS = [
  ['windfarms_geojson', WindFarmsLayer],
  ['offshore_geojson',  OffshoreInstallationsLayer],
  ['msp_zones_geojson', MspZonesLayer],
]

/** Tutto ciò che un'analisi PMAR disegna: heatmap, area di semina, layer sorgente. */
function PmarAnalysisLayers({ analysis, raster, isActive, passagesLabel, classes, highlight }) {
  const { data, view: v } = analysis
  return (
    <>
      <PmarLayer pmarData={raster} visible={v.visible} interactive={isActive}
                 passagesLabel={passagesLabel} classes={classes} highlight={highlight} />
      <SeedingAreaLayer geojson={analysis.areaGeoJSON} visible={v.visible && v.showSeedArea} />
      {SOURCE_LAYER_COMPONENTS.map(([key, Layer]) => data[key] ? (
        <Layer key={key} geojson={data[key]} visible={v.visible && v.showSource} />
      ) : null)}
    </>
  )
}

/** Poligoni e frecce di un'analisi di connettività, con la sua selezione di nodo. */
function ConnectivityAnalysisLayers({ analysis, labels, onSelectNode, metricClasses,
                                      metricHighlight, edgeHighlight, visible }) {
  const { id, data, view: v } = analysis
  const selectNode = useCallback(nodeId => onSelectNode(id, nodeId), [onSelectNode, id])
  return (
    <>
      <SeedingAreaLayer geojson={analysis.areaGeoJSON} visible={visible && v.showSeedArea} />
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
        visible={visible && v.showPolygons}
        labels={labels}
        selectedNode={v.selectedNode}
        onSelectNode={selectNode}
        classes={metricClasses}
        highlight={metricHighlight}
      />
    </>
  )
}

// Etichette dei file esportati dagli strumenti: in inglese, fisse, così un CSV non
// cambia a seconda della lingua dell'interfaccia di chi l'ha scaricato.
const EXPORT_SOURCE_LABELS = {
  none: 'Uniform (no weighting)', windfarms: 'Wind farms (EMODnet)',
  offshore_installations: 'Offshore installations (EMODnet)',
  msp_zones: 'MSP aquaculture zones (EMODnet)', geotiff: 'Custom GeoTIFF',
}
const EXPORT_VALUE_LABELS = {
  ppi: 'PPI, particle passages per cell', sum: 'SUM indicator', max: 'MAX indicator',
  q90: 'Q90 indicator', std: 'standard deviation across seedings',
}

/** Stato di visualizzazione di un'analisi: ciò che prima stava nella barra in basso. */
const DEFAULT_VIEW = {
  visible: true, showSeedArea: true,
  indicator: 'ppi', showSource: true,                       // PMAR
  metric: 'in_strength', showPolygons: true, showEdges: true, // connettività
  selectedNode: null, edgeDirection: 'both',
}

// Margini per fitBounds: a sinistra il pannello principale, a destra quello delle analisi.
const FIT_PADDING = { paddingTopLeft: [340, 40], paddingBottomRight: [340, 40] }

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
  // Area della simulazione scelta nel pannello: mentre è evidenziata, l'area
  // disegnata resta nascosta, così sulla mappa se ne vede una sola.
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

  // ── Analisi salvate in sessione (pannello di destra), la più recente in testa ──
  const [analyses,         setAnalyses]         = useState([])
  const [activeAnalysisId, setActiveAnalysisId] = useState(null)
  // Scenario selezionato a sinistra: la sua area non si disegna se un'analisi dello
  // stesso scenario mostra già la propria (sarebbe la stessa area due volte).
  const [selectedScenarioId, setSelectedScenarioId] = useState(null)
  const activeAnalysis = analyses.find(a => a.id === activeAnalysisId) ?? null
  const activePmar = activeAnalysis?.kind === 'pmar' ? activeAnalysis : null
  const activeConn = activeAnalysis?.kind === 'connectivity' ? activeAnalysis : null
  // I nomi di prima, ora derivati dall'analisi attiva: strumenti e legenda li usano così.
  const pmarData           = activePmar?.data ?? null
  const activeIndicator    = activePmar?.view.indicator ?? 'ppi'
  const connectivityData   = activeConn?.data ?? null
  const connectivityMetric = activeConn?.view.metric ?? 'in_strength'

  const [pmarLoading,     setPmarLoading]     = useState(false)
  const [pmarJobId,       setPmarJobId]       = useState(null)
  const [pmarStopping,    setPmarStopping]    = useState(false)

  const [connectivityLoading,  setConnectivityLoading]  = useState(false)
  const [connectivityJobId,    setConnectivityJobId]    = useState(null)
  const [connectivityStopping, setConnectivityStopping] = useState(false)
  // Id dell'analisi di connettività di cui è aperta la matrice (null = chiusa).
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
   * active. The connectivity matrix arms nothing — it only opens its own window —
   * so it keeps its own state rather than competing for `activeMapTool`.
   */
  const toggleTool = (tool) => {
    if (tool === 'connectivity') { setShowConnMatrix(v => (v ? null : activeConn?.id ?? null)); return }
    setActiveMapTool(prev => prev === tool ? null : tool)
  }

  const [useSource,        setUseSource]        = useState('none')

  const [natura2000Geojson, setNatura2000Geojson] = useState(null)
  const [showNatura2000,    setShowNatura2000]    = useState(true)
  const [natura2000Loading, setNatura2000Loading] = useState(false)
  const [natura2000Empty,   setNatura2000Empty]   = useState(false)

  // Memoized so the preview effects key on the seeding area, not on every render.
  const seedBounds = useMemo(() => seedShapeBounds(seedShape), [seedShape])

  // Margine dell'analisi, comunicato da PmarPanel: la preview copre la stessa area
  // di studio che il backend userà per pesare (area dello scenario ± margine).
  const [analysisMargin, setAnalysisMargin] = useState(1)

  // Area della preview EMODnet: lo scenario selezionato se c'è (in Analisi l'area
  // disegnata di solito non esiste), altrimenti l'area di seeding disegnata.
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

  // Preview della sorgente scelta a sinistra, prima di lanciare: cambiando bottone
  // la precedente sparisce. Il layer arrivato con un risultato vive nella sua scheda.
  // Come per l'area di semina: se un'analisi di questo scenario con questa sorgente
  // esiste già (anche nascosta), il layer lo comanda lo switch della sua scheda;
  // altrimenti spegnerlo lascerebbe accesa questa copia identica.
  const sourceCoveredByAnalysis = analyses.some(a =>
    a.kind === 'pmar' && a.info?.scenario?.id === selectedScenarioId
    && a.info?.params?.use_source === useSource)
  const preview = data => (sourceCoveredByAnalysis ? null : data)
  const windfarmsGeoJSON = useSource === 'windfarms'              ? preview(windfarms.data) : null
  const offshoreGeoJSON  = useSource === 'offshore_installations' ? preview(offshore.data)  : null
  const mspZonesGeoJSON  = useSource === 'msp_zones'              ? preview(mspZones.data)  : null

  const timerRef = useRef(null)

  function handleToolChange(tool) {
    setActiveTool(tool)
    setDrawMode(null)
  }

  function handleStartDraw(mode) {
    setDrawMode(mode)
    setSeedShape(null)
  }

  /**
   * Una forma conclusa. Il disegno a poligoni resta armato (`keepDrawing`) per
   * poterne accumulare più d'uno nella stessa area di seeding.
   */
  function handleShapeDone(shape, opts) {
    setSeedShape(shape)
    if (!opts?.keepDrawing) setDrawMode(null)
  }

  /**
   * Evidenzia l'area della simulazione scelta e inquadra la mappa su di essa:
   * selezionarla è un gesto esplicito, e l'area può stare fuori dalla vista.
   */
  function handleScenarioArea(geojson, scenarioId = null) {
    setScenarioAreaGeoJSON(geojson)
    setSelectedScenarioId(geojson ? scenarioId : null)
    if (!geojson || !mapRef.current) return
    try {
      mapRef.current.fitBounds(L.geoJSON(geojson).getBounds(), FIT_PADDING)
    } catch { /* geometria degenere: si lascia la vista com'è */ }
  }

  /** Fine del disegno a poligoni: esce dalla modalità e tiene l'area. */
  function handleFinishDraw() {
    setDrawMode(null)
  }

  /** Toglie l'ultimo poligono chiuso; azzera l'area se era l'unico. */
  function handleUndoLastPolygon() {
    setSeedShape(prev => {
      if (prev?.type !== 'polygon') return prev
      const rings = prev.rings.slice(0, -1)
      return rings.length ? { ...prev, rings } : null
    })
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

    // OpenDriftProcess accetta solo seeding_type circle|rectangle: per un'area
    // poligonale si semina nel rettangolo che la contiene.
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

  async function handleRunPmar({ scenario_id, pressure, start_time, duration_days, pnum, res, margin, time_step_hours, shapefile_b64, geotiff_b64, title, info }) {
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

    try {

      const jobId = await executeAsync(Process.PMAR, inputs)
      setPmarJobId(jobId)

      const { outcome } = await waitForJob(jobId)
      if (outcome === JobOutcome.DISMISSED) return

      const raw  = await fetchJobResults(jobId)
      const data = raw.result ?? raw

      if (!data.raster_values || !data.bounds) throw new Error(t.status.badResponse)

      addAnalysis({
        kind: 'pmar',
        title: title || (lang === 'it' ? data.label_it : data.label_en) || 'PMAR',
        info, data, areaGeoJSON: data.seeding_geojson ?? null,
      })
      if (data.bounds && mapRef.current)
        mapRef.current.fitBounds(L.latLngBounds(data.bounds), FIT_PADDING)
      // Le finestre degli strumenti già aperte restano: sono istantanee dell'analisi
      // su cui sono state fatte, e "Chiudi tutto" le toglie.
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

    } catch (err) {
      const clean = describeError(err, t)
        .replace(/^Error executing process:\s*/i, '')
        .replace(/^Errore:\s*/i, '')
        .replace(/^Error:\s*/i, '')
        .trim()
      setPmarErrorMsg(clean)
      setPmarStatus('')
      setPmarStatusType('error')
    } finally {
      setPmarLoading(false)
      setPmarJobId(null)
      setPmarStopping(false)
    }
  }

  async function handleRunConnectivity(inputs, { title, info } = {}) {
    if (analyses.length >= MAX_ANALYSES) return
    // Il backend non restituisce l'area di semina: si prende quella dello scenario
    // selezionato, adesso, perché durante l'attesa se ne può scegliere un altro.
    const areaAtStart = selectedScenarioId && selectedScenarioId === info?.scenario?.id
      ? scenarioAreaGeoJSON : null
    setConnectivityLoading(true)

    try {
      const jobId = await executeAsync(Process.CONNECTIVITY, inputs)
      setConnectivityJobId(jobId)

      const { outcome } = await waitForJob(jobId)
      if (outcome === JobOutcome.DISMISSED) return

      const raw  = await fetchJobResults(jobId)
      const data = raw.result ?? raw
      if (!data.polygons_geojson) throw new Error(t.status.badResponse)

      // Ogni analisi ha la sua selezione di nodo: gli indici di un'altra rete non
      // significherebbero niente qui.
      addAnalysis({
        kind: 'connectivity',
        title: title || (lang === 'it' ? data.label_it : data.label_en) || 'Connectivity',
        info, data, areaGeoJSON: areaAtStart,
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

    } catch (err) {
      setPmarErrorMsg(describeError(err, t))
    } finally {
      setConnectivityLoading(false)
      setConnectivityJobId(null)
      setConnectivityStopping(false)
    }
  }

  // ── Gestione delle analisi salvate ──────────────────────────────────────
  /**
   * Ogni analisi ha la propria area di semina (`areaGeoJSON`), comandata dallo switch
   * della sua scheda: l'evidenziazione della selezione a sinistra è solo un'anteprima.
   */
  function addAnalysis({ kind, title, info, data, areaGeoJSON = null }) {
    const id = `an-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setAnalyses(prev => (prev.length >= MAX_ANALYSES ? prev
      : [{ id, kind, title, info, data, areaGeoJSON, createdAt: Date.now(),
           view: { ...DEFAULT_VIEW } }, ...prev]))
    setActiveAnalysisId(id)
  }

  /** Aggiorna la vista di un'analisi; `patch` è un oggetto o una funzione della vista. */
  function updateView(id, patch) {
    setAnalyses(prev => prev.map(a => (a.id !== id ? a
      : { ...a, view: { ...a.view, ...(typeof patch === 'function' ? patch(a.view) : patch) } })))
  }

  function renameAnalysis(id, title) {
    setAnalyses(prev => prev.map(a => (a.id === id ? { ...a, title } : a)))
  }

  /** Eliminando l'attiva diventa attiva la più recente rimasta. */
  function deleteAnalysis(id) {
    const rest = analyses.filter(a => a.id !== id)
    setAnalyses(rest)
    if (id === activeAnalysisId) setActiveAnalysisId(rest[0]?.id ?? null)
    if (showConnMatrix === id) setShowConnMatrix(null)
  }

  /** Click su un poligono: isola i suoi archi, riclic sullo stesso deseleziona. */
  function handleSelectNode(analysisId, nodeId) {
    setActiveAnalysisId(analysisId)
    // Riaccendere le frecce: con le frecce spente il click non farebbe vedere niente.
    updateView(analysisId, v => ({ selectedNode: v.selectedNode === nodeId ? null : nodeId,
                                   showEdges: true }))
  }

  const connectivityLabels = useMemo(() => ({
    inStrength:  t.pmarControls.metricInStrength,
    outStrength: t.pmarControls.metricOutStrength,
    betweenness: t.pmarControls.metricBetweenness,
    weak:        t.pmar.connectivity.weakWarning.replace('{n}', connectivityData?.min_particles ?? 30),
  }), [t, connectivityData?.min_particles])

  // Raster dell'indicatore scelto, calcolato una volta per analisi e indicatore: un
  // oggetto nuovo a ogni render farebbe ricreare il canvas di PmarLayer.
  const rasterCache = useRef(new WeakMap())
  const rasterOf = useCallback((data, indicator) => {
    let byIndicator = rasterCache.current.get(data)
    if (!byIndicator) { byIndicator = new Map(); rasterCache.current.set(data, byIndicator) }
    if (!byIndicator.has(indicator)) byIndicator.set(indicator, getActivePmarData(data, indicator))
    return byIndicator.get(indicator)
  }, [])
  const activePmarData = useMemo(
    () => (pmarData ? rasterOf(pmarData, activeIndicator) : null),
    [pmarData, activeIndicator, rasterOf],
  )

  // ── Legenda interattiva: classi, conteggi e classi accese per ogni layer ──
  // Strumenti di analisi (in cima al pannello di destra): chiusi all'avvio.
  const [toolsExpanded, setToolsExpanded] = useState(false)

  const [ppiHighlight,    setPpiHighlight]    = useState(() => new Set())
  const [metricHighlight, setMetricHighlight] = useState(() => new Set())
  const [edgeHighlight,   setEdgeHighlight]   = useState(() => new Set())
  // Una selezione vale per i dati su cui è stata fatta: nuovo risultato, nuovo
  // indicatore o nuova metrica la azzerano.
  useEffect(() => { setPpiHighlight(new Set()) }, [activePmarData])
  useEffect(() => { setMetricHighlight(new Set()) }, [connectivityData, connectivityMetric])
  useEffect(() => { setEdgeHighlight(new Set()) }, [connectivityData])

  const ppiClasses = useMemo(
    () => (activePmarData?.vmax > 0 ? logClasses(activePmarData.vmin, activePmarData.vmax) : null),
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
      const counts = countByClass(activePmarData.raster_values.flat(), ppiClasses)
      const ind = INDICATOR_LABEL_KEYS[activeIndicator]
      out.push({
        key: 'ppi',
        title: `${t.pmarControls.colorbarLabel}${ind && activeIndicator !== 'ppi' ? ` · ${t.pmarControls[ind]}` : ''}`,
        rows: legendRows(ppiClasses, counts, formatBound, c => {
          const [r, g, b] = spectralR(c.t); return { color: `rgb(${r},${g},${b})` }
        }),
        selected: ppiHighlight, onToggle: toggleIn(setPpiHighlight), onReset: () => setPpiHighlight(new Set()),
      })
    }
    if (connectivityData && activeConn.view.visible && activeConn.view.showPolygons && metricClasses) {
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
      // Solo le curve: ogni connessione ha anche una punta di freccia, che non va contata.
      const ps = edgeFeats.filter(f => f.geometry?.type === 'LineString').map(f => f.properties?.p)
      const counts = countByClass(ps, PROBABILITY_BANDS)
      out.push({
        key: 'edges',
        title: L.edgesTitle,
        // Spessore come in PMAR (1–8 px lineare su p), ridotto per stare in legenda.
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
   * Contesto per i file degli strumenti, preso dall'analisi attiva al momento della
   * selezione: se poi si attiva un'altra analisi, il file dice comunque da dove viene.
   */
  function toolMeta() {
    const a = activePmar
    if (!a) return {}
    const sc = a.info?.scenario ?? {}
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
    // Con la latitudine di ogni cella: l'area di una cella dipende da cos(lat).
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

  /** Tutte le celle del rettangolo, zeri compresi, con id, centro e area. */
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
      const layer = await fetchFeatureLayer(Process.NATURA2000, bounds)
      if (layer) setNatura2000Geojson(layer)
      else       setNatura2000Empty(true)
    } catch {
      setNatura2000Empty(true)
    } finally {
      setNatura2000Loading(false)
    }
  }

  function handleDownloadPmar(an) {
    const pmarData   = an.data
    const ind        = an.view.indicator || 'ppi'
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
          url={`https://basemaps.cartocdn.com/rastertiles/${mapTheme}_all/{z}/{x}/{y}{r}.png?key=cb1_4afp_1_b906152c4dcc975006348ae1`}
          attribution='© OpenStreetMap · © CARTO'
          maxZoom={19}
        />
        <SimLayer simData={simData} currentStep={currentStep} />
        {/* ── Analisi PMAR: una heatmap (più area e layer sorgente) per analisi.
             Dall'ultima alla più recente, così la più recente sta sopra. ── */}
        {[...analyses].reverse().filter(a => a.kind === 'pmar').map(a => {
          const isActive = a.id === activeAnalysisId
          const v = a.view
          return (
            <PmarAnalysisLayers
              key={a.id}
              analysis={a}
              raster={rasterOf(a.data, v.indicator)}
              isActive={isActive}
              passagesLabel={t.pmarControls.tooltipPassages}
              classes={isActive ? ppiClasses : null}
              highlight={isActive ? ppiHighlight : NO_HIGHLIGHT}
            />
          )
        })}
        {/* Area dello scenario scelto a sinistra: è un'anteprima. Appena esiste
            un'analisi di quello scenario (anche nascosta) l'area la comanda lo switch
            della scheda; altrimenti spegnerlo farebbe ricomparire questa, identica. */}
        <SeedingAreaLayer
          geojson={scenarioAreaGeoJSON}
          visible={showSeedShape && !!scenarioAreaGeoJSON && !analyses.some(a =>
            a.info?.scenario?.id && a.info.scenario.id === selectedScenarioId)}
        />
        <SeedingAreaLayer geojson={t4mspPreviewGeoJSON} visible={!!t4mspPreviewGeoJSON} />
        {/* Preview della sorgente scelta a sinistra, prima di lanciare. */}
        <WindFarmsLayer geojson={windfarmsGeoJSON} visible />
        <OffshoreInstallationsLayer geojson={offshoreGeoJSON} visible />
        <MspZonesLayer geojson={mspZonesGeoJSON} visible />
        <Natura2000Layer geojson={natura2000Geojson} visible={showNatura2000} />
        {/* ── Analisi di connettività ── */}
        {[...analyses].reverse().filter(a => a.kind === 'connectivity').map(a => {
          const isActive = a.id === activeAnalysisId
          const v = a.view
          return (
            <ConnectivityAnalysisLayers
              key={a.id}
              analysis={a}
              labels={connectivityLabels}
              onSelectNode={handleSelectNode}
              metricClasses={isActive ? metricClasses : null}
              metricHighlight={isActive ? metricHighlight : NO_HIGHLIGHT}
              edgeHighlight={isActive ? edgeHighlight : NO_HIGHLIGHT}
              visible={v.visible}
            />
          )
        })}
        <SeedDrawer
          drawMode={drawMode}
          seedShape={seedShape}
          showSeedShape={showSeedShape && !scenarioAreaGeoJSON}
          onShapeDone={handleShapeDone}
        />
        {pmarData && (
          <HistogramDrawLayer
            active={activeMapTool === 'histogram'}
            rasterData={activePmarData}
            onResult={(result, layer) =>
              setHistograms(prev => [...prev, { id: Date.now(), result: { ...result, meta: toolMeta() }, layer }])
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

      {/* Tema e lingua: in alto a sinistra, accanto al pannello principale. */}
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
        drawMode={drawMode}
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
        natura2000Loading={natura2000Loading}
        natura2000Empty={natura2000Empty}
        natura2000Geojson={natura2000Geojson}
        showNatura2000={showNatura2000}
        onFetchNatura2000={handleFetchNatura2000}
        onToggleNatura2000={() => setShowNatura2000(v => !v)}
        hasSeedShape={!!seedShape || !!pmarData}
        onT4mspPreview={setT4mspPreviewGeoJSON}
        onScenarioArea={handleScenarioArea}
        onRunConnectivity={handleRunConnectivity}
        analysesFull={analyses.length >= MAX_ANALYSES}
        connectivityLoading={connectivityLoading}
        connectivityStopping={connectivityStopping}
        onStopConnectivity={async () => {
          if (connectivityJobId) { setConnectivityStopping(true); await dismissJob(connectivityJobId) }
        }}
      />

      <MapLegend sections={legendSections} labels={t.legend} />

      {analyses.length > 0 && (
        <AnalysesPanel
          analyses={analyses}
          activeId={activeAnalysisId}
          onActivate={setActiveAnalysisId}
          onDelete={deleteAnalysis}
          onRename={renameAnalysis}
          onUpdateView={updateView}
          onDownload={handleDownloadPmar}
          tools={{
            activeMapTool,
            onSetTool: toggleTool,
            windowCounts: {
              histogram:    histograms.length,
              stats:        statsEntries.length,
              profile:      profileEntries.length,
              threshold:    thresholdEntries.length,
              comparison:   comparisonAreas.length,
              connectivity: showConnMatrix ? 1 : 0,
            },
            openWindowCount: histograms.length + statsEntries.length + profileEntries.length
              + thresholdEntries.length + comparisonAreas.length + (showConnMatrix ? 1 : 0),
            onCloseAll: handleCloseAll,
            expanded: toolsExpanded,
            onToggleExpanded: () => setToolsExpanded(v => !v),
          }}
        />
      )}

      {(() => {
        // La matrice è quella dell'analisi attiva quando è stata aperta.
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
