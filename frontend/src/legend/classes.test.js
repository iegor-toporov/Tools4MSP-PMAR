import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PROBABILITY_BANDS, classIndex, formatBound, formatPercent, linNorm, linearClasses,
  logClasses, logNorm, redsColor, spectralR,
} from './classes.js'

describe('color scales', () => {
  it('spectralR hits the Spectral_r endpoints', () => {
    assert.deepEqual(spectralR(0), [94, 79, 162])
    assert.deepEqual(spectralR(1), [158, 1, 66])
  })

  it('redsColor matches matplotlib Reds at the ends and clamps', () => {
    assert.equal(redsColor(0), '#fff5f0')
    assert.equal(redsColor(1), '#67000d')
    assert.equal(redsColor(-1), '#fff5f0')
    assert.equal(redsColor(2), '#67000d')
  })

  it('logNorm rejects non-positive values, linNorm accepts zero', () => {
    assert.equal(logNorm(0, 1, 100), null)
    assert.equal(logNorm(10, 1, 100), 0.5)
    assert.equal(linNorm(0, 0, 4), 0)
    assert.equal(linNorm(1, 1, 1), 0)
  })
})

describe('logClasses', () => {
  const cls = logClasses(1, 1e6, 6)

  it('splits [vmin, vmax] in log-equal steps', () => {
    assert.equal(cls.length, 6)
    cls.forEach((c, i) => {
      assert.ok(Math.abs(Math.log10(c.from) - i) < 1e-9)
      assert.ok(Math.abs(Math.log10(c.to) - (i + 1)) < 1e-9)
    })
  })

  it('keeps out-of-range values in the open end classes, and has no class for <= 0', () => {
    assert.equal(classIndex(0.5, cls), 0)          // sotto vmin
    assert.equal(classIndex(1, cls), 0)            // = vmin
    assert.equal(classIndex(10, cls), 1)           // limite: appartiene alla classe sopra
    assert.equal(classIndex(5e6, cls), 5)          // sopra vmax
    assert.equal(classIndex(0, cls), null)
    assert.equal(classIndex(-3, cls), null)
    assert.equal(classIndex(NaN, cls), null)
  })

  it('places each class colour at its centre', () => {
    assert.deepEqual(cls.map(c => c.t), [1, 3, 5, 7, 9, 11].map(k => k / 12))
  })
})

describe('linearClasses', () => {
  const cls = linearClasses(0, 1, 5)

  it('covers zero and every finite value', () => {
    assert.equal(classIndex(0, cls), 0)
    assert.equal(classIndex(-0.2, cls), 0)
    assert.equal(classIndex(0.5, cls), 2)
    assert.equal(classIndex(1, cls), 4)
    assert.equal(classIndex(7, cls), 4)
  })

  it('labels the real range, not infinities', () => {
    assert.equal(cls[0].from, 0)
    assert.equal(cls[4].to, 1)
  })

  it('does not divide by zero on a flat range', () => {
    const flat = linearClasses(2, 2, 5)
    assert.equal(classIndex(2, flat), 0)
  })
})

describe('PROBABILITY_BANDS', () => {
  it('assigns probabilities to the expected bands', () => {
    assert.equal(classIndex(0, PROBABILITY_BANDS), 0)
    assert.equal(classIndex(0.03, PROBABILITY_BANDS), 1)
    assert.equal(classIndex(0.25, PROBABILITY_BANDS), 4)
    assert.equal(classIndex(1, PROBABILITY_BANDS), 5)
    // il passaggio può superare 1 per riga, ma non per arco: resta comunque nell'ultima
    assert.equal(classIndex(1.2, PROBABILITY_BANDS), 5)
  })
})

describe('formatting', () => {
  it('formats class bounds compactly', () => {
    assert.equal(formatBound(0), '0')
    assert.equal(formatBound(12345), '12k')
    assert.equal(formatBound(2.5e6), '2.5M')
    assert.equal(formatBound(35.4), '35')
    assert.equal(formatBound(0.0512), '0.051')
    assert.equal(formatBound(0.0003), '3e-4')
    assert.equal(formatPercent(0.05), '5 %')
  })
})
