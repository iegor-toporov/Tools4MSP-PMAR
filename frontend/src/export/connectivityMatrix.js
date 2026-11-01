/**
 * Export and formatting of the connectivity matrix.
 *
 * Pure module (no React): the matrix window uses it, and it is tested in
 * connectivityMatrix.test.js. The matrix arrives from the backend dense (n×n, rows =
 * origin, columns = destination); almost all entries are zero, because distant nodes
 * do not exchange particles. The *sparse* formats write only the non-zero pairs, as
 * triples (row, column, value).
 */

/** The non-zero pairs, in row order: `{ i, j, p }` with 0-based indices. */
export function sparseEntries(matrix) {
  const out = []
  matrix.forEach((row, i) => row.forEach((p, j) => { if (p > 0) out.push({ i, j, p }) }))
  return out
}

/** CSV value: quoted only if it contains commas, quotes or line breaks. */
function csvField(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Edge list (CSV): one row per non-zero pair. It opens in Excel, pandas, R, Gephi,
 * networkx; it is the same information as the matrix, without the zeros.
 */
export function toEdgeListCsv(matrix, labels = []) {
  const lines = ['source_id,source_label,target_id,target_label,p']
  for (const { i, j, p } of sparseEntries(matrix)) {
    lines.push([i, csvField(labels[i] ?? i), j, csvField(labels[j] ?? j), p].join(','))
  }
  return lines.join('\n') + '\n'
}

/**
 * Matrix Market, coordinate format: read by scipy.io.mmread (Python), Matrix::readMM
 * (R) and MATLAB, and the format PMAR writes with mmwrite. Indices are 1-based. The
 * format has no names for rows and columns: the node labels, in order, go into a
 * comment.
 */
export function toMatrixMarket(matrix, { comment = '', labels = [] } = {}) {
  const n = matrix.length
  const entries = sparseEntries(matrix)
  const lines = ['%%MatrixMarket matrix coordinate real general']
  if (comment) lines.push(`% ${comment}`)
  if (labels.length) lines.push(`% nodes (row/column order): ${JSON.stringify(labels)}`)
  lines.push(`${n} ${n} ${entries.length}`)
  for (const { i, j, p } of entries) lines.push(`${i + 1} ${j + 1} ${p}`)
  return lines.join('\n') + '\n'
}

/** Dense matrix (TSV): a header with the destinations, one row per origin. */
export function toDenseTsv(matrix, labels = [], corner = '') {
  const header = [corner, ...matrix.map((_, j) => labels[j] ?? j)].join('\t')
  const body = matrix.map((row, i) => [labels[i] ?? i, ...row].join('\t')).join('\n')
  return `${header}\n${body}\n`
}

/**
 * Text of a table cell: probability 0–1 with 2 decimals. A non-zero value below 0.005
 * would show "0.00", as if the link did not exist: it is written "<0.01". The full
 * value stays in the cell's tooltip.
 */
export function formatCell(v) {
  if (!(v > 0)) return ''
  if (v < 0.005) return '<0.01'
  return v.toFixed(2)
}
