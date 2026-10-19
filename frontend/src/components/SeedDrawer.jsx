import { useEffect, useRef } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

/**
 * Colori di un'area disegnata. Due palette perché sulla mappa possono stare insieme
 * l'area di semina di una nuova simulazione (azzurro) e l'area di rilascio di
 * un'analisi Markov (arancio).
 */
export const DRAW_PALETTES = {
  seed:    { color: '#0ea5e9', fillColor: '#7dd3fc' },
  release: { color: '#f97316', fillColor: '#fdba74' },
}
const styles = palette => ({
  confirmed: { ...palette, fillOpacity: 0.18, weight: 2 },
  preview:   { ...palette, fillOpacity: 0.10, weight: 2, dashArray: '6 4' },
})
/** Bersaglio di chiusura: clic entro questo raggio dal primo vertice. */
const CLOSE_PX = 12

const toLatLngs = ring => ring.map(([lon, lat]) => [lat, lon])

export default function SeedDrawer({ drawMode, seedShape, showSeedShape, onShapeDone, palette = 'seed' }) {
  const map = useMap()
  const { confirmed: CONFIRMED_STYLE, preview: PREVIEW_STYLE } = styles(DRAW_PALETTES[palette] ?? DRAW_PALETTES.seed)

  // Refs usati dentro useMapEvents per evitare closure stale
  const drawModeRef    = useRef(drawMode)
  const onShapeDoneRef = useRef(onShapeDone)
  const seedShapeRef   = useRef(seedShape)
  useEffect(() => { drawModeRef.current    = drawMode    }, [drawMode])
  useEffect(() => { onShapeDoneRef.current = onShapeDone }, [onShapeDone])
  useEffect(() => { seedShapeRef.current   = seedShape   }, [seedShape])

  // Layer sulla mappa (preview durante disegno + shape confermata)
  const layerRef  = useRef(null)
  // Stato interno del disegno (non causa re-render)
  const stateRef  = useRef({ circlePhase: 'idle', circleCenter: null, rectDrawing: false, rectStart: null, verts: [] })

  function clearLayer() {
    layerRef.current?.remove()
    layerRef.current = null
  }

  /** Anelli già chiusi: la fonte di verità è la forma in App, non uno stato locale. */
  const closedRings = () => {
    const s = seedShapeRef.current
    return s?.type === 'polygon' ? (s.rings ?? []) : []
  }

  /**
   * Ridisegna il poligono in corso: anelli già chiusi, spezzata dei vertici
   * posati con l'elastico fino al cursore, e il bersaglio sul primo vertice.
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

  /** Chiude il poligono in corso e lo aggiunge all'area, restando in disegno. */
  function closePolygon() {
    const verts = stateRef.current.verts
    if (verts.length < 3) return
    stateRef.current.verts = []
    onShapeDoneRef.current(
      { type: 'polygon', rings: [...closedRings(), verts] },
      { keepDrawing: true },
    )
  }

  // Cursore + reset stato quando drawMode cambia
  useEffect(() => {
    if (drawMode) {
      clearLayer()
      stateRef.current = { circlePhase: 'idle', circleCenter: null, rectDrawing: false, rectStart: null, verts: [] }
      map.getContainer().style.cursor = 'crosshair'
      // Il doppio clic chiude il poligono: lo zoom lo renderebbe inutilizzabile.
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

  // Esc annulla il poligono in corso, Backspace toglie l'ultimo vertice.
  // Il listener sta su document perché il contenitore della mappa non ha il
  // focus, e Backspace senza preventDefault fa tornare indietro il browser.
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

  // Ridisegna la preview quando l'area cambia da fuori (es. "Annulla ultimo")
  useEffect(() => {
    if (drawMode === 'polygon') drawPolygonPreview(null)
  }, [drawMode, seedShape]) // eslint-disable-line react-hooks/exhaustive-deps

  // Mostra la shape confermata quando non si sta disegnando
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
    // ── Cerchio e poligono ────────────────────────────────────────────────────
    click(e) {
      const mode = drawModeRef.current
      const s    = stateRef.current

      if (mode === 'polygon') {
        // Vicino al primo vertice il clic chiude invece di aggiungere.
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
      // I due clic del doppio clic sono già arrivati come `click` e hanno posato
      // vertici sopra il precedente: vanno tolti tutti prima di chiudere, non
      // uno solo — se il doppio clic cade sull'ultimo vertice posato, i
      // duplicati sono due.
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

      // Ignora click senza trascinamento
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
