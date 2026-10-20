import { useEffect, useState } from 'react'
import { Stack, Group, Text, TextInput, Button, SegmentedControl, NativeSelect, Collapse,
         UnstyledButton } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import { seedShapeToGeoJSON } from '../../geometry/seedShape'
import PolygonDrawControls from '../PolygonDrawControls'
import { LABEL_STYLES, SectionLabel, RadioCard, lbl } from '../ui'
import RunButton from './RunButton'
import BboxPicker, { bboxOf } from './BboxPicker'

// Limiti del backend (processes/MarkovProcess.py): passi del cursore e risoluzione.
export const MARKOV_MAX_STEPS = 100
export const MARKOV_RES_MIN = 0.05
export const MARKOV_RES_MAX = 5
export const MARKOV_MIN_PARTICLES = 30
const DT_PRESETS = [1, 5, 10]

/** Problema dei parametri da mostrare sotto i campi, o null. */
export function markovParamError({ dt, steps, simDays, stepHours, res }, m) {
  const minDt = (stepHours || 1) / 24
  if (!(dt >= minDt && dt <= simDays))
    return m.errDt.replace('{min}', +minDt.toFixed(3)).replace('{max}', simDays)
  if (!(Number.isInteger(steps) && steps >= 1 && steps <= MARKOV_MAX_STEPS))
    return m.errSteps.replace('{max}', MARKOV_MAX_STEPS)
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
 * "Propagate forward": approssimazione a catena di Markov della propagazione del
 * tracciante dopo multipli di Δt (processes/MarkovProcess.py). La matrice di
 * transizione può venire da un layer di connettività già calcolato (transizione su
 * griglia generata: stessa griglia e stesso Δt) o essere nuova.
 */
export default function PropagateSection({
  ctx, markov, draw, matrices, active, useSource, onUseSourceChange, sourcePicker,
}) {
  const { t, sc, scenarioId, scenarioLabel, scenarioInfo, ready, limitNote, analysesFull } = ctx
  const g = t.analysis.propagate
  const m = t.pmar.markov
  const p = t.pmar
  const own = matrices.filter(x => x.scenarioId === scenarioId)
  const [title, setTitle]       = useState('')
  const [matrixMode, setMatrixMode] = useState(own.length ? 'existing' : 'new')
  const [matrixId, setMatrixId] = useState(own[0]?.id ?? '')
  const [res, setRes]           = useState('0.25')
  const [dt, setDt]             = useState('10')
  const [steps, setSteps]       = useState(String(MARKOV_MAX_STEPS))
  const [release, setRelease]   = useState('single')
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseArea, setReleaseArea] = useState(false)
  const simDays = sc?.duration_days

  const matrix = matrixMode === 'existing' ? own.find(x => x.id === matrixId) ?? null : null

  // Nuove matrici, o cambio di simulazione: la scelta deve restare valida.
  useEffect(() => {
    if (own.length && !own.some(x => x.id === matrixId)) setMatrixId(own[0].id)
    if (!own.length && matrixMode === 'existing') setMatrixMode('new')
  }, [own.map(x => x.id).join(), scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (own.length) setMatrixMode('existing') }, [scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Δt non può superare la simulazione: scegliendone una più corta lo si riduce.
  useEffect(() => {
    if (simDays && parseFloat(dt) > simDays) setDt(String(Math.min(10, simDays)))
  }, [scenarioId, simDays]) // eslint-disable-line react-hooks/exhaustive-deps

  // Forme sulla mappa solo mentre la sezione è aperta e la scelta le usa.
  useEffect(() => { draw.onVisible('propBbox', active && matrixMode === 'new') }, [active, matrixMode]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { draw.onVisible('markov', active && releaseArea) }, [active, releaseArea]) // eslint-disable-line react-hooks/exhaustive-deps

  // Con una matrice esistente griglia e Δt sono i suoi.
  const resNum   = matrix ? matrix.res : parseFloat(res)
  const bbox     = matrix ? matrix.bbox : (bboxOf(draw.shapes.propBbox) ?? sc?.bounds ?? null)
  const dtNum    = matrix ? matrix.tDays : parseFloat(dt)
  const stepsNum = Number(steps)
  const error = sc
    ? markovParamError({ dt: dtNum, steps: stepsNum, simDays, stepHours: sc.time_step_hours, res: resNum }, { ...m, ...g })
    : null
  const validUntil = sc && !error ? Math.min(stepsNum, Math.floor(simDays / dtNum + 1e-9)) * dtNum : 0
  const perCell = particlesPerCell(sc?.pnum, bbox, resNum)

  const source = releaseArea ? 'area' : useSource === 'none' ? 'uniform' : useSource
  const sourceLabel = releaseArea ? m.sourceArea : p.useSources[useSource]
  const autoTitle = [g.titleWord, sourceLabel, `Δt ${+(dtNum || 0).toFixed(2)} d`, scenarioLabel]
    .filter(Boolean).join(' · ')
  const canRun = ready && !markov.loading && !analysesFull && !error &&
    (matrixMode === 'new' || !!matrix) &&
    (source !== 'geotiff' || !!ctx.geotiff.b64) &&
    (source !== 'area' || !!draw.shapes.markov)

  function run() {
    if (!canRun) return
    const drawn = matrix ? matrix.bbox : bboxOf(draw.shapes.propBbox)
    markov.onRun({
      scenario_id: scenarioId,
      res:         resNum,
      dt_days:     dtNum,
      steps:       stepsNum,
      release,
      source,
      ...(drawn ? { bbox: drawn } : {}),
      ...(source === 'geotiff' ? { geotiff_b64: ctx.geotiff.b64 } : {}),
      ...(source === 'area' ? { area_geojson: JSON.stringify(seedShapeToGeoJSON(draw.shapes.markov)) } : {}),
    }, {
      title: title.trim() || autoTitle,
      info: {
        scenario: scenarioInfo(),
        params: {
          source, res: resNum, dt_days: dtNum, steps: stepsNum, release,
          ...(matrix ? { matrix_from: matrix.title } : {}),
          ...(source === 'geotiff' ? { geotiff_name: ctx.geotiff.name } : {}),
        },
      },
    })
    setTitle('')
  }

  const pickSource = key => {
    if (key === 'area') { setReleaseArea(true); return }
    setReleaseArea(false)
    onUseSourceChange(key)
  }
  const drawing = draw.target === 'markov' ? draw.mode : null
  const areaControls = (
    <Stack gap="xs">
      <Group grow gap="xs">
        {['circle', 'rectangle', 'polygon'].map(mode => (
          <Button key={mode} size="xs" px={4} fz={11} color="orange" type="button"
                  variant={drawing === mode ? 'filled' : 'light'}
                  onClick={() => draw.onStart(mode, 'markov')}>
            {{ circle: p.btnCircle, rectangle: p.btnRect, polygon: p.btnPolygon }[mode]}
          </Button>
        ))}
      </Group>
      {drawing === 'circle'    && <Text size="xs" c="dimmed" ta="center">{p.hintCircle}</Text>}
      {drawing === 'rectangle' && <Text size="xs" c="dimmed" ta="center">{p.hintRect}</Text>}
      {drawing === 'polygon'   && (
        <PolygonDrawControls seedShape={draw.shapes.markov} labels={p}
                             onUndo={() => draw.onUndo('markov')} onFinish={draw.onFinish} />
      )}
      {!drawing && (draw.shapes.markov
        ? (
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="orange.6">{m.areaReady}</Text>
            <Button size="compact-xs" variant="subtle" color="gray" type="button" onClick={() => draw.onClear('markov')}>
              {m.areaClear}
            </Button>
          </Group>
        )
        : <Text size="xs" c="dimmed" ta="center">{m.areaHint}</Text>)}
    </Stack>
  )

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
        {!matrix && (
          <Group gap={4} mt={4}>
            {DT_PRESETS.filter(d => !simDays || d <= simDays).map(d => (
              <Button key={d} size="compact-xs" type="button"
                      variant={parseFloat(dt) === d ? 'filled' : 'light'}
                      onClick={() => setDt(String(d))}>
                {m.dtPreset.replace('{d}', d)}
              </Button>
            ))}
          </Group>
        )}
        <Text size="10px" c="dimmed" mt={4} lh={1.35}>{g.intervalHint}</Text>
      </div>

      <div>
        <TextInput
          type="number" size="xs"
          label={lbl(g.steps, g.stepsTip)}
          value={steps} min="1" max={MARKOV_MAX_STEPS} step="1"
          onChange={e => setSteps(e.target.value)}
          styles={LABEL_STYLES}
        />
        {!error && sc && (
          <Text size="10px" c="dimmed" mt={4}>
            {g.horizonHint
              .replace('{h}', +(stepsNum * dtNum).toFixed(2))
              .replace('{sim}', +validUntil.toFixed(2))}
          </Text>
        )}
      </div>

      <UnstyledButton onClick={() => setReleaseOpen(v => !v)} aria-expanded={releaseOpen}>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em', flex: 1 }}>
            {g.release}
          </Text>
          <Text size="10px" c="dimmed" truncate maw={150}>
            {sourceLabel} · {release === 'continuous' ? m.releaseContinuous : m.releaseSingle}
          </Text>
          <IconChevronDown size={12} style={{ transform: releaseOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        </Group>
      </UnstyledButton>
      <Collapse expanded={releaseOpen}>
        <Stack gap="sm">
          <Text size="10px" c="dimmed" lh={1.4}>{g.releaseIntro}</Text>
          <div>
            <Text size="xs" fw={500} mb={4}>{lbl(m.labelRelease, m.tooltipRelease)}</Text>
            <SegmentedControl
              size="xs" fullWidth value={release} onChange={setRelease}
              data={[{ value: 'single', label: m.releaseSingle },
                     { value: 'continuous', label: m.releaseContinuous }]}
            />
          </div>
          {sourcePicker({ value: releaseArea ? 'area' : useSource, onPick: pickSource, area: areaControls })}
        </Stack>
      </Collapse>

      {error && <Text size="xs" c="red.5">{error}</Text>}
      <RunButton labels={t.analysis.runLabels} loading={markov.loading} stopping={markov.stopping}
                 onStop={markov.onStop} disabled={!canRun} onRun={run} limitNote={limitNote}
                 hint={!sc ? p.hintNoScenario
                     : source === 'area' && !draw.shapes.markov ? m.areaHint
                     : source === 'geotiff' && !ctx.geotiff.b64 ? t.analysis.dispersal.needTiff : null} />
    </Stack>
  )
}
