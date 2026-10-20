import { useEffect, useRef, useState } from 'react'
import { Paper, Group, Text, ActionIcon, Tooltip, Slider } from '@mantine/core'
import { IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { clampFrame, frameCount, frameDay } from '../markov/frames'

// Un passo ogni 0.9 s: abbastanza per leggere giorno e mappa.
const PLAY_INTERVAL_MS = 900

const formatDay = d => (Number.isInteger(d) ? `${d}` : `${+d.toFixed(2)}`)

/**
 * Cursore dei passi di un layer "Propagate forward", in basso al centro della mappa:
 * si vede quando quel layer è l'attivo. Il passo k mostra la previsione dopo k × Δt.
 */
export default function MarkovStepper({ an, onView }) {
  const { t } = useLang()
  const m = t.pmar.markov
  const s = t.stepper
  const d = an.data
  const n = frameCount(d)
  const k = clampFrame(d, an.view.frame)
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
  const last = n - 1
  const ticks = last >= 4 ? [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * last)) : [0, last]

  return (
    <Paper shadow="xl" radius="lg" className="markov-stepper">
      <Group justify="space-between" align="baseline" gap="sm" wrap="nowrap">
        <Text size="xs" fw={600}>{s.title}</Text>
        <Text size="xs" c="blue.5" ff="monospace">
          {s.label.replace('{k}', k).replace('{d}', formatDay(frameDay(d, k)))}
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
          label={i => `${i}× · ${m.dayN.replace('{d}', formatDay(frameDay(d, i)))}`}
          marks={ticks.map(x => ({ value: x, label: `${x}×` }))}
          thumbLabel={m.frameSlider}
          mb={14}
        />
      </Group>
    </Paper>
  )
}
