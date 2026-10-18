import { forwardRef, useMemo } from 'react'
import { Button, Text, Box, Group } from '@mantine/core'
import { IconDownload } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { FloatingWindow } from './FloatingWindow'
import { formatCell, sparseEntries, toDenseTsv, toEdgeListCsv, toMatrixMarket } from '../export/connectivityMatrix'

/** Scarica un testo come file. Blob e non `data:` URI: con 300 nodi sarebbe enorme. */
function saveText(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const SPECTRAL_R = [
  [94, 79, 162], [50, 136, 189], [102, 194, 165], [171, 221, 164],
  [230, 245, 152], [255, 255, 191], [254, 224, 139], [253, 174, 97],
  [244, 109, 67], [213, 62, 79], [158, 1, 66],
]

/** Same palette as the map raster, so matrix and map read as one result. */
function cellColor(v) {
  if (!(v > 0)) return 'transparent'
  const t = Math.max(0, Math.min(1, v))
  const n = SPECTRAL_R.length - 1
  const i = Math.min(Math.floor(t * n), n - 1)
  const f = t * n - i
  const a = SPECTRAL_R[i], b = SPECTRAL_R[i + 1]
  const ch = k => Math.round(a[k] + f * (b[k] - a[k]))
  return `rgba(${ch(0)},${ch(1)},${ch(2)},0.85)`
}

/**
 * Connectivity matrix as a heat-table: rows are source polygons, columns destinations.
 * Mirrors Fig. 3 of Bosi et al. (2026).
 */
export const PmarConnectivityMatrix = forwardRef(function PmarConnectivityMatrix(
  { data, onClose, stackIndex = 0 }, ref
) {
  const { t } = useLang()
  const c = t.toolsPanel

  const matrix   = data?.matrix
  const labels   = data?.node_labels ?? []
  const released = data?.n_released ?? []
  const minPart  = data?.min_particles ?? 0

  /** Same rule as the map: too few particles released, the row means nothing. */
  const reliable = i => released[i] === undefined || released[i] >= minPart

  const nonZero = useMemo(() => (matrix ? sparseEntries(matrix).length : 0), [matrix])
  const fileBase = () => `pmar_connectivity_${data.mode}_${Date.now()}`

  // Densa (tutte le n² caselle), elenco di archi e Matrix Market (solo le non nulle).
  const downloads = [
    { key: 'dense', label: c.downloadDense,
      run: () => saveText(toDenseTsv(matrix, labels, c.connectivityFrom), `${fileBase()}.tsv`, 'text/tab-separated-values') },
    { key: 'edges', label: c.downloadEdges,
      run: () => saveText(toEdgeListCsv(matrix, labels), `${fileBase()}_edges.csv`, 'text/csv') },
    { key: 'mtx', label: c.downloadMtx,
      run: () => saveText(
        toMatrixMarket(matrix, { comment: `PMAR connectivity · ${data.mode} · ${data.t_days} d`, labels }),
        `${fileBase()}.mtx`, 'text/plain') },
  ]

  const cell = { padding: '1px 4px', fontSize: 10, fontFamily: '"SF Mono", ui-monospace, monospace' }

  return (
    <FloatingWindow ref={ref} title={c.connectivityTitle} onClose={onClose} stackIndex={stackIndex} width={460}>
      <Box px="sm" pt="xs" pb={6}>
        {!matrix?.length ? (
          <Text size="xs" c="dimmed" ta="center" py="md">{c.connectivityNoData}</Text>
        ) : (
          <>
            <Box style={{ overflow: 'auto', maxHeight: 320 }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...cell, color: 'var(--text-secondary)', textAlign: 'left', position: 'sticky', left: 0, background: 'var(--modal-bg)' }}>
                      {c.connectivityFrom}
                    </th>
                    {labels.map(l => (
                      <th key={l} style={{ ...cell, color: 'var(--text-secondary)', fontWeight: 500, writingMode: 'vertical-rl', transform: 'rotate(180deg)', maxHeight: 70 }}>
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((row, i) => (
                    <tr key={labels[i] ?? i}>
                      <td
                        title={`n = ${released[i] ?? '?'}${reliable(i) ? '' : ` (< ${minPart})`}`}
                        style={{
                          ...cell,
                          color:      'var(--text-secondary)',
                          opacity:    reliable(i) ? 1 : 0.45,
                          fontStyle:  reliable(i) ? 'normal' : 'italic',
                          whiteSpace: 'nowrap',
                          position:   'sticky',
                          left:       0,
                          background: 'var(--modal-bg)',
                        }}
                      >
                        {labels[i]}
                      </td>
                      {row.map((v, j) => (
                        <td
                          key={j}
                          title={`${labels[i]} → ${labels[j]}: ${v}`}
                          style={{
                            ...cell,
                            textAlign: 'right',
                            background: cellColor(v),
                            color: v > 0.55 ? '#fff' : 'var(--text-primary)',
                            border: '1px solid var(--modal-divider)',
                          }}
                        >
                          {formatCell(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Box>
            <Text size="10px" c="dimmed" mt={6}>
              {data.mode} · {data.t_days} d · n={labels.length} · {c.nonZeroPairs.replace('{n}', nonZero)}
            </Text>
            <Group grow gap={6} mt="xs">
              {downloads.map(d => (
                <Button key={d.key} size="xs" variant="light" color="teal"
                        leftSection={<IconDownload size={12} />} onClick={d.run}>
                  {d.label}
                </Button>
              ))}
            </Group>
          </>
        )}
      </Box>
    </FloatingWindow>
  )
})
