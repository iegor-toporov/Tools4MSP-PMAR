/**
 * Export e formattazione della matrice di connettività.
 *
 * Modulo puro (niente React): lo usa la finestra della matrice ed è testato in
 * connectivityMatrix.test.js. La matrice arriva dal backend densa (n×n, righe =
 * origine, colonne = destinazione); quasi tutte le caselle sono zero, perché nodi
 * lontani non si scambiano particelle. I formati *sparsi* scrivono solo le coppie
 * con valore diverso da zero, come terne (riga, colonna, valore).
 */

/** Le coppie non nulle, in ordine di riga: `{ i, j, p }` con indici 0-based. */
export function sparseEntries(matrix) {
  const out = []
  matrix.forEach((row, i) => row.forEach((p, j) => { if (p > 0) out.push({ i, j, p }) }))
  return out
}

/** Valore CSV: tra virgolette solo se contiene virgole, virgolette o a capo. */
function csvField(v) {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Elenco di archi (CSV): una riga per coppia non nulla. Si apre in Excel, pandas,
 * R, Gephi, networkx; è la stessa informazione della matrice, senza gli zeri.
 */
export function toEdgeListCsv(matrix, labels = []) {
  const lines = ['source_id,source_label,target_id,target_label,p']
  for (const { i, j, p } of sparseEntries(matrix)) {
    lines.push([i, csvField(labels[i] ?? i), j, csvField(labels[j] ?? j), p].join(','))
  }
  return lines.join('\n') + '\n'
}

/**
 * Matrix Market, formato coordinate: lo leggono scipy.io.mmread (Python),
 * Matrix::readMM (R) e MATLAB, ed è quello che PMAR scrive con mmwrite. Gli indici
 * sono 1-based. Il formato non ha nomi per righe e colonne: le etichette dei nodi,
 * in ordine, vanno in un commento.
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

/** Matrice densa (TSV): intestazione con le destinazioni, una riga per origine. */
export function toDenseTsv(matrix, labels = [], corner = '') {
  const header = [corner, ...matrix.map((_, j) => labels[j] ?? j)].join('\t')
  const body = matrix.map((row, i) => [labels[i] ?? i, ...row].join('\t')).join('\n')
  return `${header}\n${body}\n`
}

/**
 * Testo di una cella della tabella: probabilità 0–1 a 2 decimali. Un valore non
 * nullo sotto 0.005 mostrerebbe "0.00", come se il collegamento non esistesse:
 * si scrive "<0.01". Il valore pieno resta nel tooltip della cella.
 */
export function formatCell(v) {
  if (!(v > 0)) return ''
  if (v < 0.005) return '<0.01'
  return v.toFixed(2)
}
