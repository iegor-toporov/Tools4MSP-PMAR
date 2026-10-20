import { forwardRef } from 'react'
import { Button, Text, Box } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { FloatingWindow } from './FloatingWindow'
import { statsCsv } from '../export/pmarTools'
import { saveText } from '../export/download'

// Il calcolo sta in export/pmarTools.js (quantili come numpy/pandas); qui si
// riesporta per chi lo importava da questo file.
export { computeStats } from '../export/pmarTools'

// ── Value formatter ───────────────────────────────────────────────────────────

function fmt(v) {
  if (!isFinite(v) || v === 0) return '—'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'k'
  if (v >= 10)  return v.toFixed(1)
  return v.toFixed(3)
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export const PmarStatsModal = forwardRef(function PmarStatsModal(
  { result, onClose, stackIndex = 0 }, ref
) {
  const { t } = useLang()
  const c = t.toolsPanel

  function downloadCsv() {
    if (!result.stats) return
    saveText(statsCsv(result, result.meta), `pmar_stats_${Date.now()}.csv`)
  }


  const rows = result.stats ? [
    [c.statsN,      result.stats.n.toLocaleString()],
    [c.statsMean,   fmt(result.stats.mean)],
    [c.statsMedian, fmt(result.stats.median)],
    [c.statsStd,    fmt(result.stats.std)],
    [c.statsMin,    fmt(result.stats.min)],
    [c.statsMax,    fmt(result.stats.max)],
    [c.statsQ25,    fmt(result.stats.q25)],
    [c.statsQ75,    fmt(result.stats.q75)],
    [c.statsQ90,    fmt(result.stats.q90)],
    [c.statsQ95,    fmt(result.stats.q95)],
    [c.statsQ99,    fmt(result.stats.q99)],
  ] : []

  return (
    <FloatingWindow ref={ref} title={c.statsTitle} onClose={onClose} stackIndex={stackIndex}>
      <Box px="sm" pt="xs" pb={6}>
        {!result.stats ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.statsNoData}</Text>
        ) : (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {rows.map(([label, val]) => (
                  <tr key={label}>
                    <td style={{ padding: '2px 8px 2px 0', fontSize: 11, color: 'var(--text-secondary)' }}>{label}</td>
                    <td style={{ padding: '2px 0', fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right', fontFamily: '"IBM Plex Mono", "SF Mono", ui-monospace, monospace' }}>{val}</td>
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
