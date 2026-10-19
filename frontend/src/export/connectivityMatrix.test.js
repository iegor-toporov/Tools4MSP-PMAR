import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatCell, sparseEntries, toDenseTsv, toEdgeListCsv, toMatrixMarket,
} from './connectivityMatrix.js'

const M = [
  [1,    0.25, 0],
  [0,    0,    0.004],
  [0.5,  0,    0.000012],
]
const LABELS = ['A1', 'B, north', 'C"x"']

describe('sparseEntries', () => {
  it('keeps only non-zero pairs, row by row, 0-based', () => {
    assert.deepEqual(sparseEntries(M), [
      { i: 0, j: 0, p: 1 }, { i: 0, j: 1, p: 0.25 }, { i: 1, j: 2, p: 0.004 },
      { i: 2, j: 0, p: 0.5 }, { i: 2, j: 2, p: 0.000012 },
    ])
  })
})

describe('toEdgeListCsv', () => {
  const lines = toEdgeListCsv(M, LABELS).trim().split('\n')

  it('has one header plus one line per non-zero pair', () => {
    assert.equal(lines[0], 'source_id,source_label,target_id,target_label,p')
    assert.equal(lines.length, 1 + 5)
  })

  it('quotes labels containing commas or quotes', () => {
    assert.equal(lines[2], '0,A1,1,"B, north",0.25')
    assert.equal(lines[3], '1,"B, north",2,"C""x""",0.004')
  })

  it('keeps small values in full', () => {
    assert.equal(lines[5], '2,"C""x""",2,"C""x""",0.000012')
  })
})

describe('toMatrixMarket', () => {
  const text = toMatrixMarket(M, { comment: 'passage · 5 d', labels: LABELS })
  const lines = text.trim().split('\n')

  it('writes the coordinate header, comments and size line', () => {
    assert.equal(lines[0], '%%MatrixMarket matrix coordinate real general')
    assert.equal(lines[1], '% passage · 5 d')
    assert.ok(lines[2].startsWith('% nodes (row/column order): ["A1"'))
    assert.equal(lines[3], '3 3 5')
  })

  it('uses 1-based indices', () => {
    assert.deepEqual(lines.slice(4), ['1 1 1', '1 2 0.25', '2 3 0.004', '3 1 0.5', '3 3 0.000012'])
  })

  it('has every comment line starting with %', () => {
    const body = toMatrixMarket(M, { comment: 'x' }).split('\n')
    assert.ok(body.slice(0, 2).every(l => l.startsWith('%')))
  })
})

describe('toDenseTsv', () => {
  it('keeps the existing dense layout', () => {
    const lines = toDenseTsv([[0, 0.5], [1, 0]], ['a', 'b'], 'from \\ to').trim().split('\n')
    assert.deepEqual(lines, ['from \\ to\ta\tb', 'a\t0\t0.5', 'b\t1\t0'])
  })
})

describe('formatCell', () => {
  it('shows probabilities with two decimals', () => {
    assert.equal(formatCell(0), '')
    assert.equal(formatCell(0.1234), '0.12')
    assert.equal(formatCell(1), '1.00')
    assert.equal(formatCell(0.005), '0.01')
  })

  it('never shows a non-zero link as 0.00', () => {
    assert.equal(formatCell(0.004), '<0.01')
    assert.equal(formatCell(0.000012), '<0.01')
  })
})
