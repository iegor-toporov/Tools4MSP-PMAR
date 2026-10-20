import { useEffect, useRef, useState } from 'react'
import { Stack, Text, TextInput, NativeSelect } from '@mantine/core'
import { LABEL_STYLES, SectionLabel, RadioCard, lbl } from '../ui'
import RunButton from './RunButton'
import BboxPicker, { bboxOf } from './BboxPicker'

// Limiti del backend (processes/MarkovProcess.py).
export const MARKOV_RES_MIN = 0.05
export const MARKOV_RES_MAX = 5
export const MARKOV_MIN_PARTICLES = 30

/** Problema dei parametri da mostrare sotto i campi, o null. */
export function markovParamError({ dt, simDays, stepHours, res }, m) {
  const minDt = (stepHours || 1) / 24
  if (!(dt >= minDt && dt <= simDays))
    return m.errDt.replace('{min}', +minDt.toFixed(3)).replace('{max}', simDays)
  if (!(res >= MARKOV_RES_MIN && res <= MARKOV_RES_MAX))
    return m.errRes.replace('{min}', MARKOV_RES_MIN).replace('{max}', MARKOV_RES_MAX)
  return null
}

/**
 * Particelle per cella stimate dal riquadro della griglia: il dominio vero è più
 * piccolo (solo celle con particelle), quindi la stima è per difetto.
 */
export function particlesPerCell(pnum, bbox, res) {
  if (!bbox || !(res > 0) || !pnum) return null
  const cells = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / res) * Math.ceil((bbox[3] - bbox[1]) / res))
  return Math.round(pnum / cells)
}

/**
 * "Propagate forward": con una matrice di transizione su una griglia regolare (solo
 * questo tipo di matrice regge una catena di Markov) si propaga nel futuro la
 * distribuzione delle particelle a t=0, per multipli di Δt (processes/MarkovProcess.py).
 * La matrice può venire da un layer di connettività già calcolato (transizione su
 * griglia generata: stessa griglia e stesso Δt) o essere nuova.
 */
export default function PropagateSection({ ctx, markov, draw, matrices, active }) {
  const { t, sc, scenarioId, scenarioLabel, scenarioInfo, ready, limitNote, analysesFull } = ctx
  const g = t.analysis.propagate
  const m = t.pmar.markov
  const own = matrices.filter(x => x.scenarioId === scenarioId)
  const [title, setTitle]           = useState('')
  const [matrixMode, setMatrixMode] = useState(own.length ? 'existing' : 'new')
  const [matrixId, setMatrixId]     = useState(own[0]?.id ?? '')
  const [res, setRes]               = useState('0.25')
  const [dt, setDt]                 = useState('10')
  const simDays = sc?.duration_days

  const matrix = matrixMode === 'existing' ? own.find(x => x.id === matrixId) ?? null : null

  // Nuove matrici, o cambio di simulazione: la scelta deve restare valida. Appena
  // compare la prima matrice di questa simulazione la si propone.
  const ownKey = own.map(x => x.id).join()
  const hadOwn = useRef(own.length > 0)
  useEffect(() => {
    if (own.length && !own.some(x => x.id === matrixId)) setMatrixId(own[0].id)
    if (!own.length && matrixMode === 'existing') setMatrixMode('new')
    if (own.length && !hadOwn.current) setMatrixMode('existing')
    hadOwn.current = own.length > 0
  }, [ownKey, scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Δt non può superare la simulazione: scegliendone una più corta lo si riduce.
  useEffect(() => {
    if (simDays && parseFloat(dt) > simDays) setDt(String(Math.min(10, simDays)))
  }, [scenarioId, simDays]) // eslint-disable-line react-hooks/exhaustive-deps

  // Il riquadro disegnato si vede solo mentre la sezione è aperta e la scelta lo usa.
  useEffect(() => { draw.onVisible('propBbox', active && matrixMode === 'new') }, [active, matrixMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Con una matrice esistente griglia e Δt sono i suoi.
  const resNum = matrix ? matrix.res : parseFloat(res)
  const bbox   = matrix ? matrix.bbox : (bboxOf(draw.shapes.propBbox) ?? sc?.bounds ?? null)
  const dtNum  = matrix ? matrix.tDays : parseFloat(dt)
  const error = sc
    ? markovParamError({ dt: dtNum, simDays, stepHours: sc.time_step_hours, res: resNum }, { ...m, ...g })
    : null
  const perCell = particlesPerCell(sc?.pnum, bbox, resNum)

  const autoTitle = [g.titleWord, `Δt ${+(dtNum || 0).toFixed(2)} d`, scenarioLabel].filter(Boolean).join(' · ')
  const canRun = ready && !markov.loading && !analysesFull && !error && (matrixMode === 'new' || !!matrix)

  function run() {
    if (!canRun) return
    const drawn = matrix ? matrix.bbox : bboxOf(draw.shapes.propBbox)
    markov.onRun({
      scenario_id: scenarioId,
      res:         resNum,
      dt_days:     dtNum,
      ...(drawn ? { bbox: drawn } : {}),
    }, {
      title: title.trim() || autoTitle,
      info: {
        scenario: scenarioInfo(),
        params: { res: resNum, dt_days: dtNum, ...(matrix ? { matrix_from: matrix.title } : {}) },
      },
    })
    setTitle('')
  }

  return (
    <Stack gap="sm">
      <TextInput size="xs" label={t.analysis.layerTitle} placeholder={autoTitle} value={title}
                 onChange={e => setTitle(e.target.value)} maxLength={80} styles={LABEL_STYLES}
                 onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run() } }} />
      {sc && sc.beaching !== false && (
        <Text size="10px" c="orange.6" lh={1.4}>{m.beachingNote}</Text>
      )}

      <div>
        <SectionLabel>{g.matrix}</SectionLabel>
        <Stack gap={6} mt={6} role="radiogroup">
          <RadioCard selected={matrixMode === 'existing'} disabled={!own.length}
                     onSelect={() => setMatrixMode('existing')}
                     title={g.existing} tip={g.existingTip}
                     description={own.length ? null : g.noneExisting}>
            <NativeSelect
              size="xs" label={g.fromConnectivity} value={matrixId}
              onChange={e => setMatrixId(e.target.value)}
              data={own.map(x => ({ value: x.id, label: x.title }))}
              styles={LABEL_STYLES}
            />
            {matrix && (
              <Text size="10px" c="dimmed" mt={4}>
                {g.existingInfo.replace('{res}', matrix.res).replace('{dt}', +matrix.tDays.toFixed(3))}
              </Text>
            )}
          </RadioCard>
          <RadioCard selected={matrixMode === 'new'} onSelect={() => setMatrixMode('new')} title={g.create}>
            <BboxPicker
              t={t} res={res} onResChange={setRes} resMin={MARKOV_RES_MIN} resMax={MARKOV_RES_MAX}
              shape={draw.shapes.propBbox} defaultBbox={sc?.bounds}
              drawing={draw.target === 'propBbox' && draw.mode === 'rectangle'}
              onDraw={() => draw.onStart('rectangle', 'propBbox')}
              onClear={() => draw.onClear('propBbox')}
            />
          </RadioCard>
        </Stack>
        {perCell !== null && (
          <Text size="10px" mt={4} c={perCell < MARKOV_MIN_PARTICLES ? 'orange.6' : 'dimmed'}>
            {m.perCell.replace('{n}', perCell).replace('{min}', MARKOV_MIN_PARTICLES)}
          </Text>
        )}
      </div>

      <div>
        <TextInput
          type="number" size="xs"
          label={lbl(t.analysis.connectivity.interval, m.tooltipDt)}
          value={matrix ? String(+matrix.tDays.toFixed(3)) : dt} min="0" step="any"
          readOnly={!!matrix} disabled={!!matrix}
          onChange={e => setDt(e.target.value)}
          styles={LABEL_STYLES}
        />
        <Text size="10px" c="dimmed" mt={4} lh={1.35}>{g.intervalHint}</Text>
      </div>

      {error && <Text size="xs" c="red.5">{error}</Text>}
      <RunButton labels={t.analysis.runLabels} loading={markov.loading} stopping={markov.stopping}
                 onStop={markov.onStop} disabled={!canRun} onRun={run} limitNote={limitNote}
                 hint={!sc ? t.pmar.hintNoScenario : null} />
    </Stack>
  )
}
