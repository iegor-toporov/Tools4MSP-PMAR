import { useEffect, useRef, useState } from 'react'
import { Paper, Group, Text, ActionIcon, Tooltip, Slider, SegmentedControl } from '@mantine/core'
import { IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { MarkovLayer, clampFrame, effectiveLayer, firstUnvalidatedFrame, frameCount,
         frameSummary, layerAvailable } from '../markov/frames'

// Un passo ogni 0.9 s: abbastanza per leggere giorno e mappa.
const PLAY_INTERVAL_MS = 900

const formatDay = d => (Number.isInteger(d) ? `${d}` : `${+d.toFixed(2)}`)

/**
 * Cursore dei passi di un layer "Propagate forward", in basso sulla mappa accanto alla
 * legenda: si vede quando quel layer è l'attivo. Passo k = k × Δt; il livello mostrato
 * è la previsione, la simulazione o la loro differenza (finché la simulazione dura).
 */
export default function MarkovStepper({ an, onView }) {
  const { t } = useLang()
  const m = t.pmar.markov
  const s = t.stepper
  const v = an.view
  const d = an.data
  const n = frameCount(d)
  const k = clampFrame(d, v.frame)
  const layer = effectiveLayer(d, k, v.layer)
  const sum = frameSummary(d, k)
  const firstOut = firstUnvalidatedFrame(d)
  const [playing, setPlaying] = useState(false)
  // Frame corrente per il timer, che non deve ripartire a ogni passo.
  const kRef = useRef(k)
  kRef.current = k

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      if (kRef.current >= n - 1) setPlaying(false)
      else onView({ frame: kRef.current + 1 })
    }, PLAY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [playing, n]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cambiando layer attivo il play si ferma.
  useEffect(() => { setPlaying(false) }, [an.id])

  const togglePlay = () => {
    if (!playing && k >= n - 1) onView({ frame: 0 })      // dalla fine si riparte
    setPlaying(p => !p)
  }
  const pct = x => `${(x * 100).toFixed(1)} %`
  // Residui di arrotondamento (1e-17) sono zero: al primo passo l'errore è nullo per costruzione.
  const num = x => (Math.abs(x) < 1e-12 ? 0 : Math.abs(x) >= 0.01 ? +x.toPrecision(3) : x.toExponential(1))
  const last = n - 1
  const ticks = last >= 4 ? [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * last)) : [0, last]

  return (
    <Paper shadow="xl" radius="lg" className="markov-stepper">
      <Group justify="space-between" align="baseline" gap="sm" wrap="nowrap">
        <Text size="xs" fw={600}>{s.title}</Text>
        <Text size="xs" c="blue.5" ff="monospace">
          {s.label.replace('{k}', k).replace('{d}', formatDay(sum.day))}
        </Text>
      </Group>
      <Group gap={8} wrap="nowrap" align="center" mt={6}>
        <Tooltip label={playing ? m.pause : m.play} withArrow>
          <ActionIcon size="md" variant="light" aria-label={playing ? m.pause : m.play} onClick={togglePlay}>
            {playing ? <IconPlayerPause size={15} /> : <IconPlayerPlay size={15} />}
          </ActionIcon>
        </Tooltip>
        <Slider
          style={{ flex: 1 }} size="sm"
          min={0} max={last} step={1} value={k}
          onChange={frame => { setPlaying(false); onView({ frame }) }}
          label={i => `${i}× · ${m.dayN.replace('{d}', formatDay(d.frames[i]?.day ?? 0))}`}
          marks={ticks.map(x => ({ value: x, label: `${x}×` }))
            .concat(firstOut !== null && firstOut > 0 && !ticks.includes(firstOut - 1)
              ? [{ value: firstOut - 1 }] : [])}
          thumbLabel={m.frameSlider}
          mb={14}
        />
      </Group>
      <Group gap={8} wrap="nowrap" align="center" mt={4}>
        <SegmentedControl
          size="xs"
          value={layer}
          onChange={l => onView({ layer: l })}
          data={Object.values(MarkovLayer).map(l => ({
            value: l, label: m.layersShort[l], disabled: !layerAvailable(d, k, l),
          }))}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="10px" c="dimmed" truncate>
            {(d.beaching === false ? m.massOut : m.massOutBeaching)}:{' '}
            <Text span size="10px" c="blue.5" fw={500}>
              {sum.refMassOut !== null && sum.validated
                ? m.massOutBoth.replace('{m}', pct(sum.massOut)).replace('{s}', pct(sum.refMassOut))
                : pct(sum.massOut)}
            </Text>
          </Text>
          {sum.validated
            ? <Text size="10px" c="dimmed" truncate>
                {m.error}:{' '}
                <Text span size="10px" c="blue.5" fw={500}>
                  {m.errorValue.replace('{e}', num(sum.emax)).replace('{mae}', num(sum.mae))}
                </Text>
              </Text>
            : k > 0 && <Text size="10px" c="orange.6" lh={1.3}>{m.noValidation.replace('{d}', d.valid_days)}</Text>}
        </div>
      </Group>
    </Paper>
  )
}
