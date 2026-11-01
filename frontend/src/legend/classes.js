/**
 * Colour scales of the map and classes of the interactive legend.
 *
 * Pure module (no React, no Leaflet): both the layers that colour the map and the
 * legend use it, so a colour in the legend is by construction the one seen on the
 * map. Tested in classes.test.js.
 */

// Copy of matplotlib's Spectral_r (PMAR heatmap and connectivity polygons).
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

// The 9 ColorBrewer stops from which matplotlib builds `Reds`: the palette PMAR
// (network_to_geojson) uses to colour the arrows by probability p.
const REDS = [
  [255, 245, 240], [254, 224, 210], [252, 187, 161], [252, 146, 114], [251, 106, 74],
  [239, 59, 44],   [203, 24, 29],   [165, 15, 21],   [103, 0, 13],
]

// matplotlib's RdBu_r (ColorBrewer, 11 stops): blue below zero, white at zero, red
// above. For difference maps, where the sign matters as much as the value.
const RDBU_R = [
  [5, 48, 97],    [33, 102, 172], [67, 147, 195], [146, 197, 222], [209, 229, 240],
  [247, 247, 247],
  [253, 219, 199], [244, 165, 130], [214, 96, 77],  [178, 24, 43],   [103, 0, 31],
]

function interpolate(stops, t) {
  const x = Math.max(0, Math.min(1, t))
  const n = stops.length - 1
  const i = Math.min(Math.floor(x * n), n - 1)
  const f = x * n - i
  const a = stops[i], b = stops[i + 1]
  return [0, 1, 2].map(k => Math.round(a[k] + f * (b[k] - a[k])))
}

/** Spectral_r colour for t ∈ [0,1], as a triple [r, g, b]. */
export const spectralR = t => interpolate(SPECTRAL_R, t)

/** RdBu_r colour for t ∈ [0,1] (0.5 = zero), as a triple [r, g, b]. */
export const divergingColor = t => interpolate(RDBU_R, t)

/** Position of a signed value on the diverging scale: [-dmax, dmax] → [0, 1]. */
export function divergingNorm(val, dmax) {
  if (!Number.isFinite(val) || !(dmax > 0)) return null
  return Math.max(0, Math.min(1, (val / dmax + 1) / 2))
}

/**
 * Classes symmetric around zero, for differences. `n` even: zero is a boundary, not
 * the middle of a class that would mix overestimates and underestimates. The outer
 * classes are open, as for the other linear classes.
 */
export function divergingClasses(dmax, n = 6) {
  const d = dmax > 0 ? dmax : 1
  const step = (2 * d) / n
  return Array.from({ length: n }, (_, i) => {
    // From the centre, not from -d: so the boundary at zero is exactly 0 and not 1e-17.
    const from = (i - n / 2) * step
    const to   = (i + 1 - n / 2) * step
    return {
      lo: i === 0 ? -Infinity : from,
      hi: i === n - 1 ? Infinity : to,
      from, to,
      t: ((from + to) / 2 / d + 1) / 2,
    }
  })
}

/** `Reds` colour for t ∈ [0,1], as a hex string (the same format as PMAR). */
export function redsColor(t) {
  return '#' + interpolate(REDS, t).map(c => c.toString(16).padStart(2, '0')).join('')
}

/** Logarithmic normalisation to [0,1]; null for values ≤ 0 or not finite. */
export function logNorm(val, vmin, vmax) {
  if (val <= 0 || !isFinite(val)) return null
  const logMin = Math.log10(Math.max(vmin, 1e-12))
  const logMax = Math.log10(vmax)
  return Math.max(0, Math.min(1, (Math.log10(val) - logMin) / (logMax - logMin)))
}

/**
 * Linear normalisation to [0,1], for linear measures that can be 0.
 * logNorm() does not suit them: it returns null for every value ≤ 0.
 */
export function linNorm(val, vmin, vmax) {
  if (!isFinite(val)) return null
  if (vmax <= vmin) return 0
  return Math.max(0, Math.min(1, (val - vmin) / (vmax - vmin)))
}

/**
 * Logarithmic classes for the heatmap: bounds equally spaced in log10 between vmin and
 * vmax. Each class is `{ lo, hi, t }`, with t the position of its centre on the colour
 * scale. The first and last are open (lo = 0, hi = Infinity): on the map, values outside
 * [vmin, vmax] are already clamped to the extreme colours, and must be in a class.
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

/** Linear classes for the connectivity measures; open outer classes as in logClasses. */
export function linearClasses(vmin, vmax, n = 5) {
  const span = vmax > vmin ? vmax - vmin : 1
  return Array.from({ length: n }, (_, i) => ({
    lo: i === 0     ? -Infinity : vmin + (i / n) * span,
    hi: i === n - 1 ? Infinity  : vmin + ((i + 1) / n) * span,
    // Labels: the outer bounds show the real values, not ±∞.
    from: vmin + (i / n) * span,
    to:   vmin + ((i + 1) / n) * span,
    t:    (i + 0.5) / n,
  }))
}

/** Probability bands for the arrows (p ∈ [0, 1]); t = Reds colour at the middle of the band. */
export const PROBABILITY_BANDS = [
  [0, 0.01], [0.01, 0.05], [0.05, 0.10], [0.10, 0.25], [0.25, 0.50], [0.50, 1],
].map(([lo, hi], i, all) => ({
  lo: i === 0 ? -Infinity : lo,
  hi: i === all.length - 1 ? Infinity : hi,
  from: lo, to: hi,
  t: (lo + hi) / 2,
}))

/**
 * Index of the class that contains *value* (intervals [lo, hi)), or null if the value
 * cannot be shown. For logarithmic classes (lo of the first = 0), values ≤ 0 have no
 * class, as they have no colour on the map.
 */
export function classIndex(value, classes) {
  if (!Number.isFinite(value)) return null
  if (classes[0]?.lo === 0 && value <= 0) return null
  for (let i = 0; i < classes.length; i++) {
    if (value >= classes[i].lo && value < classes[i].hi) return i
  }
  return null
}

/** Readable number for a class bound: 1.2k, 35, 0.05, 3e-4. */
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

/** Percentage for the probability bands: 0.05 → "5 %". */
export const formatPercent = p => `${+(p * 100).toPrecision(2)} %`
