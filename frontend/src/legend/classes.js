/**
 * Scale di colore della mappa e classi della legenda interattiva.
 *
 * Modulo puro (niente React, niente Leaflet): lo usano sia i layer che colorano la
 * mappa sia la legenda, così un colore in legenda è per costruzione quello che si vede
 * sulla mappa. Testato in classes.test.js.
 */

// Replica di Spectral_r di matplotlib (heatmap PMAR e poligoni di connettività).
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

// Le 9 tappe ColorBrewer da cui matplotlib costruisce `Reds`: è la palette con cui
// PMAR (network_to_geojson) colora le frecce in base alla probabilità p.
const REDS = [
  [255, 245, 240], [254, 224, 210], [252, 187, 161], [252, 146, 114], [251, 106, 74],
  [239, 59, 44],   [203, 24, 29],   [165, 15, 21],   [103, 0, 13],
]

function interpolate(stops, t) {
  const x = Math.max(0, Math.min(1, t))
  const n = stops.length - 1
  const i = Math.min(Math.floor(x * n), n - 1)
  const f = x * n - i
  const a = stops[i], b = stops[i + 1]
  return [0, 1, 2].map(k => Math.round(a[k] + f * (b[k] - a[k])))
}

/** Colore Spectral_r per t ∈ [0,1], come terna [r, g, b]. */
export const spectralR = t => interpolate(SPECTRAL_R, t)

/** Colore `Reds` per t ∈ [0,1], come stringa esadecimale (lo stesso formato di PMAR). */
export function redsColor(t) {
  return '#' + interpolate(REDS, t).map(c => c.toString(16).padStart(2, '0')).join('')
}

/** Normalizzazione logaritmica in [0,1]; null per valori ≤ 0 o non finiti. */
export function logNorm(val, vmin, vmax) {
  if (val <= 0 || !isFinite(val)) return null
  const logMin = Math.log10(Math.max(vmin, 1e-12))
  const logMax = Math.log10(vmax)
  return Math.max(0, Math.min(1, (Math.log10(val) - logMin) / (logMax - logMin)))
}

/**
 * Normalizzazione lineare in [0,1], per metriche lineari che possono valere 0.
 * logNorm() non le serve: restituisce null per ogni valore ≤ 0.
 */
export function linNorm(val, vmin, vmax) {
  if (!isFinite(val)) return null
  if (vmax <= vmin) return 0
  return Math.max(0, Math.min(1, (val - vmin) / (vmax - vmin)))
}

/**
 * Classi logaritmiche per la heatmap: limiti equidistanti in log10 fra vmin e vmax.
 * Ogni classe è `{ lo, hi, t }`, con t la posizione del suo centro nella scala colori.
 * La prima e l'ultima sono aperte (lo = 0, hi = Infinity): sulla mappa i valori fuori
 * da [vmin, vmax] sono già schiacciati sui colori estremi, e devono stare in una classe.
 */
export function logClasses(vmin, vmax, n = 6) {
  const lo = Math.log10(Math.max(vmin, 1e-12))
  const hi = Math.log10(Math.max(vmax, vmin * 1.0001, 1e-12))
  const edge = k => 10 ** (lo + (k / n) * (hi - lo))
  return Array.from({ length: n }, (_, i) => ({
    lo:   i === 0     ? 0        : edge(i),
    hi:   i === n - 1 ? Infinity : edge(i + 1),
    from: edge(i),
    to:   edge(i + 1),
    t:    (i + 0.5) / n,
  }))
}

/** Classi lineari per le metriche di connettività; estremi aperti come in logClasses. */
export function linearClasses(vmin, vmax, n = 5) {
  const span = vmax > vmin ? vmax - vmin : 1
  return Array.from({ length: n }, (_, i) => ({
    lo: i === 0     ? -Infinity : vmin + (i / n) * span,
    hi: i === n - 1 ? Infinity  : vmin + ((i + 1) / n) * span,
    // Etichette: gli estremi mostrano i valori reali, non ±∞.
    from: vmin + (i / n) * span,
    to:   vmin + ((i + 1) / n) * span,
    t:    (i + 0.5) / n,
  }))
}

/** Fasce di probabilità per le frecce (p ∈ [0, 1]); t = colore Reds a metà fascia. */
export const PROBABILITY_BANDS = [
  [0, 0.01], [0.01, 0.05], [0.05, 0.10], [0.10, 0.25], [0.25, 0.50], [0.50, 1],
].map(([lo, hi], i, all) => ({
  lo: i === 0 ? -Infinity : lo,
  hi: i === all.length - 1 ? Infinity : hi,
  from: lo, to: hi,
  t: (lo + hi) / 2,
}))

/**
 * Indice della classe che contiene *value* (intervalli [lo, hi)), o null se il valore
 * non è rappresentabile. Per le classi logaritmiche (lo della prima = 0) i valori ≤ 0
 * non hanno classe, come non hanno colore sulla mappa.
 */
export function classIndex(value, classes) {
  if (!Number.isFinite(value)) return null
  if (classes[0]?.lo === 0 && value <= 0) return null
  for (let i = 0; i < classes.length; i++) {
    if (value >= classes[i].lo && value < classes[i].hi) return i
  }
  return null
}

/** Numero leggibile per un limite di classe: 1.2k, 35, 0.05, 3e-4. */
export function formatBound(v) {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1e6) return `${+(v / 1e6).toPrecision(2)}M`
  if (a >= 1e3) return `${+(v / 1e3).toPrecision(2)}k`
  if (a >= 1)   return `${+v.toPrecision(2)}`
  if (a >= 1e-3) return `${+v.toPrecision(2)}`
  return v.toExponential(0)
}

/** Percentuale per le fasce di probabilità: 0.05 → "5 %". */
export const formatPercent = p => `${+(p * 100).toPrecision(2)} %`
