import { Stack, Group, Text, TextInput, Button, SegmentedControl, NativeSelect } from '@mantine/core'
import PolygonDrawControls from './PolygonDrawControls'

// Deve restare allineato a MARKOV_RESOLUTIONS in processes/MarkovProcess.py
export const MARKOV_RESOLUTIONS = [
  { value: '0.25', label: '0.25°' },
  { value: '0.1',  label: '0.1°'  },
  { value: '0.05', label: '0.05°' },
]
// Limiti del backend (MarkovProcess.py): passi del cursore e orizzonte massimo.
export const MARKOV_MAX_FRAMES  = 40
export const MARKOV_MAX_HORIZON = 365
export const MARKOV_MIN_PARTICLES = 30
const DT_PRESETS = [1, 5, 10]

/**
 * Orizzonte proposto quando il campo è vuoto: il doppio della simulazione, così si
 * vede subito la previsione oltre la sua durata, entro i limiti del backend.
 */
export function defaultHorizon(dt, simDays) {
  if (!(dt > 0)) return null
  const h = Math.min(MARKOV_MAX_HORIZON, dt * MARKOV_MAX_FRAMES, Math.max(dt, 2 * (simDays || dt)))
  return Math.floor(h / dt) * dt
}

/** Problema dei parametri da mostrare sotto i campi, o null. */
export function markovParamError({ dt, horizon, simDays, stepHours }, m) {
  const minDt = (stepHours || 1) / 24
  if (!(dt >= minDt && dt <= simDays))
    return m.errDt.replace('{min}', +minDt.toFixed(3)).replace('{max}', simDays)
  if (!(horizon >= dt && horizon <= MARKOV_MAX_HORIZON))
    return m.errHorizon.replace('{max}', MARKOV_MAX_HORIZON)
  const steps = Math.floor(horizon / dt + 1e-9)
  if (steps > MARKOV_MAX_FRAMES)
    return m.errSteps.replace('{n}', steps).replace('{max}', MARKOV_MAX_FRAMES)
  return null
}

/**
 * Particelle per cella stimate dal riquadro dell'area di semina: il dominio vero è
 * più piccolo (solo celle con particelle), quindi la stima è per difetto.
 */
export function particlesPerCell(sc, res) {
  const b = sc?.bounds
  if (!b || !(res > 0) || !sc.pnum) return null
  const cells = Math.max(1, Math.ceil((b[2] - b[0]) / res) * Math.ceil((b[3] - b[1]) / res))
  return Math.round(sc.pnum / cells)
}

/**
 * Sotto-tab "Markov" del pannello Analisi: intervallo Δt, orizzonte, tipo di rilascio,
 * griglia e sorgente. Lo stato sta in PmarPanel, perché il bottone di avvio vive nella
 * barra fissa in fondo al pannello.
 */
export default function MarkovControls({
  m, p, lbl, labelStyles, sc,
  dt, onDtChange, horizon, horizonPlaceholder, onHorizonChange,
  release, onReleaseChange, res, onResChange,
  sourceGroups, area, draw, error, steps, validUntil,
}) {
  const perCell = particlesPerCell(sc, parseFloat(res))
  const simDays = sc?.duration_days
  return (
    <Stack gap="sm" pt="sm">
      <Text size="10px" c="dimmed" lh={1.4}>{m.intro}</Text>

      <div>
        <TextInput
          type="number" size="xs"
          label={lbl(m.labelDt, m.tooltipDt)}
          value={dt} min="0" step="any"
          onChange={e => onDtChange(e.target.value)}
          styles={labelStyles}
        />
        <Group gap={4} mt={4}>
          {DT_PRESETS.filter(d => !simDays || d <= simDays).map(d => (
            <Button key={d} size="compact-xs" type="button"
                    variant={parseFloat(dt) === d ? 'filled' : 'light'}
                    onClick={() => onDtChange(String(d))}>
              {m.dtPreset.replace('{d}', d)}
            </Button>
          ))}
        </Group>
      </div>

      <TextInput
        type="number" size="xs"
        label={lbl(m.labelHorizon, m.tooltipHorizon)}
        value={horizon} placeholder={horizonPlaceholder} min="0" step="any"
        onChange={e => onHorizonChange(e.target.value)}
        styles={labelStyles}
      />
      {!error && steps > 0 && (
        <Text size="10px" c="dimmed" mt={-6}>
          {m.horizonHint.replace('{n}', steps).replace('{sim}', validUntil)}
        </Text>
      )}

      <div>
        <Text size="xs" fw={500} mb={4}>{lbl(m.labelRelease, m.tooltipRelease)}</Text>
        <SegmentedControl
          size="xs" fullWidth value={release} onChange={onReleaseChange}
          data={[{ value: 'single', label: m.releaseSingle },
                 { value: 'continuous', label: m.releaseContinuous }]}
        />
      </div>

      <NativeSelect
        size="xs"
        label={lbl(m.labelRes, m.tooltipRes)}
        value={res}
        onChange={e => onResChange(e.target.value)}
        data={MARKOV_RESOLUTIONS}
        styles={labelStyles}
      />
      {perCell !== null && (
        <Text size="10px" mt={-6} c={perCell < MARKOV_MIN_PARTICLES ? 'orange.6' : 'dimmed'}>
          {m.perCell.replace('{n}', perCell).replace('{min}', MARKOV_MIN_PARTICLES)}
        </Text>
      )}

      <Group gap={4} align="center">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
          {m.sectionSource}
        </Text>
      </Group>
      {sourceGroups}

      {area && (
        <Stack gap="xs">
          <Group grow gap="xs">
            {['circle', 'rectangle', 'polygon'].map(mode => (
              <Button key={mode} size="xs" px={4} fz={11} color="orange" type="button"
                      variant={draw.drawing === mode ? 'filled' : 'light'}
                      onClick={() => draw.onStartDraw(mode)}>
                {{ circle: p.btnCircle, rectangle: p.btnRect, polygon: p.btnPolygon }[mode]}
              </Button>
            ))}
          </Group>
          {draw.drawing === 'circle'    && <Text size="xs" c="dimmed" ta="center">{p.hintCircle}</Text>}
          {draw.drawing === 'rectangle' && <Text size="xs" c="dimmed" ta="center">{p.hintRect}</Text>}
          {draw.drawing === 'polygon'   && (
            <PolygonDrawControls seedShape={draw.shape} labels={p} onUndo={draw.onUndo} onFinish={draw.onFinishDraw} />
          )}
          {!draw.drawing && (draw.shape
            ? (
              <Group justify="space-between" gap="xs">
                <Text size="xs" c="orange.6">{m.areaReady}</Text>
                <Button size="compact-xs" variant="subtle" color="gray" type="button" onClick={draw.onClear}>
                  {m.areaClear}
                </Button>
              </Group>
            )
            : <Text size="xs" c="dimmed" ta="center">{m.areaHint}</Text>)}
        </Stack>
      )}

      {error && <Text size="xs" c="red.5">{error}</Text>}
    </Stack>
  )
}
