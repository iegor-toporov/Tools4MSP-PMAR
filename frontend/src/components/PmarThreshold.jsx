import { forwardRef, useEffect, useRef } from 'react'
import { Text, Box, Slider, Button } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { FloatingWindow } from './FloatingWindow'
import { cellAreaKm2, thresholdCsv } from '../export/pmarTools'
import { saveText } from '../export/download'

// ── Value formatter ───────────────────────────────────────────────────────────

function fmt(v) {
  if (!isFinite(v) || v === 0) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'k'
  if (v >= 10)  return v.toFixed(1)
  return v.toFixed(3)
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export const PmarThresholdModal = forwardRef(function PmarThresholdModal(
  { result, onClose, stackIndex = 0 }, ref
) {
  const { t } = useLang()
  const c = t.toolsPanel
  const threshRef = useRef(null)
  const cellsRef  = useRef(null)
  const areaRef   = useRef(null)
  const pctRef    = useRef(null)

  // Celle con valore > 0 e la loro latitudine: l'area di una cella dipende da cos(lat)
  // (prima era (res·111.32)², a 44° N sovrastimata di circa il 39%).
  const { cells = [], vmin, vmax, rasterRes = 0.1 } = result
  const logMin = Math.log10(Math.max(vmin > 0 ? vmin : 1e-6, 1e-12))
  const logMax = Math.log10(Math.max(vmax > 0 ? vmax : 1,    1e-12))

  function compute(sliderVal) {
    if (logMax <= logMin || !cells.length)
      return { threshold: Math.pow(10, logMin), nAbove: 0, area: 0, pct: 0 }
    const threshold = Math.pow(10, logMin + (sliderVal / 1000) * (logMax - logMin))
    let nAbove = 0, area = 0
    for (const c of cells) if (c.v >= threshold) { nAbove++; area += cellAreaKm2(c.lat, rasterRes) }
    return { threshold, nAbove, area, pct: nAbove / cells.length * 100 }
  }

  // La curva di superamento: le stesse grandezze del cursore, per 50 soglie.
  function downloadCsv() {
    saveText(thresholdCsv(result, result.meta), `pmar_threshold_${Date.now()}.csv`)
  }

  function updateDom(sliderVal) {
    const { threshold, nAbove, area, pct } = compute(sliderVal)
    if (threshRef.current) threshRef.current.textContent = fmt(threshold)
    if (cellsRef.current)  cellsRef.current.textContent  = nAbove.toLocaleString()
    if (areaRef.current)   areaRef.current.textContent   = area.toFixed(1)
    if (pctRef.current)    pctRef.current.textContent    = pct.toFixed(1)
  }

  useEffect(() => { updateDom(500) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FloatingWindow ref={ref} title={c.thresholdTitle} onClose={onClose} stackIndex={stackIndex}>
      <Box px="sm" pt="xs" pb={6}>
        {cells.length === 0 ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.statsNoData}</Text>
        ) : (
          <>
            <Slider
              min={0} max={1000} defaultValue={500}
              color="blue" size="sm" mb="sm"
              onChange={val => updateDom(val)}
              label={null}
            />
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  [c.thresholdAbove, threshRef, ''],
                  [c.thresholdCells, cellsRef,  ''],
                  [c.thresholdArea,  areaRef,   ' km²'],
                  [c.thresholdPct,   pctRef,    ' %'],
                ].map(([label, valueRef, unit]) => (
                  <tr key={label}>
                    <td style={{ padding: '2px 8px 2px 0', fontSize: 11, color: 'var(--text-secondary)' }}>{label}</td>
                    <td style={{ padding: '2px 0', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right', fontFamily: '"IBM Plex Mono", "SF Mono", ui-monospace, monospace' }}>
                      <span ref={valueRef}>—</span>
                      <span style={{ opacity: 0.6 }}>{unit}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
