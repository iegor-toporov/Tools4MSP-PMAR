import { useEffect, useRef } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

/**
 * Colours of a drawn area. Several palettes, because the map can show at the same
 * time the release area of a new simulation (light blue), the release area of
 * Propagate (orange) and the box of a grid (purple).
 */
export const DRAW_PALETTES = {
  seed:    { color: '#0ea5e9', fillColor: '#7dd3fc' },
  release: { color: '#f97316', fillColor: '#fdba74' },
  bbox:    { color: '#7c3aed', fillColor: '#c4b5fd' },
}
const styles = palette => ({
  confirmed: { ...palette, fillOpacity: 0.18, weight: 2 },
  preview:   { ...palette, fillOpacity: 0.10, weight: 2, dashArray: '6 4' },
})
/** Closing target: a click within this radius of the first vertex. */
const CLOSE_PX = 12

const toLatLngs = ring => ring.map(([lon, lat]) => [lat, lon])

export default function SeedDrawer({ drawMode, seedShape, showSeedShape, onShapeDone, palette = 'seed' }) {
  const map = useMap()
  const { confirmed: CONFIRMED_STYLE, preview: PREVIEW_STYLE } = styles(DRAW_PALETTES[palette] ?? DRAW_PALETTES.seed)

  // Refs used inside useMapEvents to avoid stale closures
  const drawModeRef    = useRef(drawMode)
  const onShapeDoneRef = useRef(onShapeDone)
  const seedShapeRef   = useRef(seedShape)
  useEffect(() => { drawModeRef.current    = drawMode    }, [drawMode])
  useEffect(() => { onShapeDoneRef.current = onShapeDone }, [onShapeDone])
  useEffect(() => { seedShapeRef.current   = seedShape   }, [seedShape])

  // Layers on the map (preview while drawing + confirmed shape)
  const layerRef  = useRef(null)
  // Internal drawing state (does not cause re-renders)
  const stateRef  = useRef({ circlePhase: 'idle', circleCenter: null, rectDrawing: false, rectStart: null, verts: [] })

  function clearLayer() {
    layerRef.current?.remove()
    layerRef.current = null
  }

  /** Rings already closed: the source of truth is the shape in App, not local state. */
  const closedRings = () => {
    const s = seedShapeRef.current
    return s?.type === 'polygon' ? (s.rings ?? []) : []
  }

  /**
   * Redraw the polygon in progress: rings already closed, the polyline of the
   * vertices placed with a rubber band to the cursor, and the target on the first
   * vertex.
   */
  function drawPolygonPreview(cursor) {
    clearLayer()
    const verts = stateRef.current.verts
    const group = L.layerGroup()

    for (const ring of closedRings()) {
      if (ring.length >= 3) L.polygon(toLatLngs(ring), CONFIRMED_STYLE).addTo(group)
    }

    if (verts.length) {
      const path = toLatLngs(verts)
      L.polyline(cursor ? [...path, [cursor.lat, cursor.lng]] : path, PREVIEW_STYLE).addTo(group)
      L.circleMarker(path[0], {
        radius: verts.length >= 3 ? 6 : 4,
        color: CONFIRMED_STYLE.color,
        fillColor: verts.length >= 3 ? CONFIRMED_STYLE.color : '#ffffff',
        fillOpacity: 1,
        weight: 2,
      }).addTo(group)
    }

    layerRef.current = group.addTo(map)
  }

  /** Close the polygon in progress and add it to the area, staying in drawing mode. */
  function closePolygon() {
    const verts = stateRef.current.verts
    if (verts.length < 3) return
    stateRef.current.verts = []
    onShapeDoneRef.current(
      { type: 'polygon', rings: [...closedRings(), verts] },
      { keepDrawing: true },
    )
  }

  // Cursor + state reset when drawMode changes
  useEffect(() => {
    if (drawMode) {
      clearLayer()
      stateRef.current = { circlePhase: 'idle', circleCenter: null, rectDrawing: false, rectStart: null, verts: [] }
      map.getContainer().style.cursor = 'crosshair'
      // A double click closes the polygon: zooming would make it unusable.
      if (drawMode === 'polygon') map.doubleClickZoom.disable()
    } else {
      map.getContainer().style.cursor = ''
      map.doubleClickZoom.enable()
    }
    return () => {
      map.getContainer().style.cursor = ''
      map.doubleClickZoom.enable()
    }
  }, [drawMode, map])

  // Esc cancels the polygon in progress, Backspace removes the last vertex.
  // The listener is on document because the map container does not have the focus,
  // and Backspace without preventDefault makes the browser go back.
  useEffect(() => {
    if (drawMode !== 'polygon') return

    function onKeyDown(e) {
      if (e.target.closest?.('input, textarea, select')) return
      if (e.key === 'Escape') {
        stateRef.current.verts = []
        drawPolygonPreview(null)
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        stateRef.current.verts = stateRef.current.verts.slice(0, -1)
        drawPolygonPreview(null)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [drawMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw the preview when the area changes from outside (e.g. "Undo last")
  useEffect(() => {
    if (drawMode === 'polygon') drawPolygonPreview(null)
  }, [drawMode, seedShape]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show the confirmed shape when not drawing
  useEffect(() => {
    if (drawMode) return
    clearLayer()
    if (!seedShape || !showSeedShape) return

    if (seedShape.type === 'circle') {
      layerRef.current = L.circle([seedShape.lat, seedShape.lon], {
        radius: seedShape.radius, ...CONFIRMED_STYLE,
      }).addTo(map)
    } else if (seedShape.type === 'polygon') {
      const rings = (seedShape.rings ?? []).filter(r => r.length >= 3)
      if (!rings.length) return
      layerRef.current = L.polygon(rings.map(toLatLngs), CONFIRMED_STYLE).addTo(map)
    } else {
      layerRef.current = L.rectangle([
        [seedShape.lat_min, seedShape.lon_min],
        [seedShape.lat_max, seedShape.lon_max],
      ], CONFIRMED_STYLE).addTo(map)
    }

    return clearLayer
  }, [drawMode, seedShape, showSeedShape, map])

  useMapEvents({
    // ── Circle and polygon ────────────────────────────────────────────────────
    click(e) {
      const mode = drawModeRef.current
      const s    = stateRef.current

      if (mode === 'polygon') {
        // Near the first vertex a click closes instead of adding.
        if (s.verts.length >= 3) {
          const first = map.latLngToContainerPoint(L.latLng(s.verts[0][1], s.verts[0][0]))
          if (first.distanceTo(e.containerPoint) <= CLOSE_PX) { closePolygon(); return }
        }
        s.verts = [...s.verts, [e.latlng.lng, e.latlng.lat]]
        drawPolygonPreview(e.latlng)
        return
      }

      if (mode !== 'circle') return

      if (s.circlePhase === 'idle') {
        s.circlePhase  = 'radius'
        s.circleCenter = e.latlng
        clearLayer()
        layerRef.current = L.circle(e.latlng, { radius: 500, ...PREVIEW_STYLE }).addTo(map)
      } else {
        const radius = Math.max(100, Math.round(s.circleCenter.distanceTo(e.latlng)))
        clearLayer()
        stateRef.current = { ...stateRef.current, circlePhase: 'idle', circleCenter: null }
        onShapeDoneRef.current({
          type: 'circle',
          lon:  s.circleCenter.lng,
          lat:  s.circleCenter.lat,
          radius,
        })
      }
    },

    dblclick() {
      if (drawModeRef.current !== 'polygon') return
      // The two clicks of the double click have already arrived as `click` and placed
      // vertices on top of the previous one: all of them must be removed before
      // closing, not just one; if the double click falls on the last vertex placed,
      // there are two duplicates.
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
      let verts = stateRef.current.verts
      while (verts.length >= 2 && same(verts[verts.length - 1], verts[verts.length - 2])) {
        verts = verts.slice(0, -1)
      }
      stateRef.current.verts = verts
      closePolygon()
    },

    mousemove(e) {
      const mode = drawModeRef.current
      const s    = stateRef.current

      if (mode === 'polygon') {
        if (s.verts.length) drawPolygonPreview(e.latlng)
        return
      }

      if (mode === 'circle' && s.circlePhase === 'radius' && s.circleCenter) {
        const radius = Math.max(100, Math.round(s.circleCenter.distanceTo(e.latlng)))
        layerRef.current?.setRadius(radius)
      }

      if (mode === 'rectangle' && s.rectDrawing && s.rectStart) {
        const bounds = L.latLngBounds(s.rectStart, e.latlng)
        if (layerRef.current) {
          layerRef.current.setBounds(bounds)
        } else {
          layerRef.current = L.rectangle(bounds, PREVIEW_STYLE).addTo(map)
        }
      }
    },

    // ── Rettangolo ────────────────────────────────────────────────────────────
    mousedown(e) {
      if (drawModeRef.current !== 'rectangle') return
      map.dragging.disable()
      stateRef.current.rectDrawing = true
      stateRef.current.rectStart   = e.latlng
      clearLayer()
    },

    mouseup(e) {
      if (drawModeRef.current !== 'rectangle' || !stateRef.current.rectDrawing) return
      map.dragging.enable()
      stateRef.current.rectDrawing = false

      const bounds = L.latLngBounds(stateRef.current.rectStart, e.latlng)
      stateRef.current.rectStart = null

      // Ignore clicks without dragging
      const sw = bounds.getSouthWest()
      const ne = bounds.getNorthEast()
      if (Math.abs(ne.lng - sw.lng) < 0.001 && Math.abs(ne.lat - sw.lat) < 0.001) return

      clearLayer()
      onShapeDoneRef.current({
        type:    'rectangle',
        lon_min: sw.lng, lat_min: sw.lat,
        lon_max: ne.lng, lat_max: ne.lat,
      })
    },
  })

  return null
}
