import { useEffect, useState } from 'react'
import { Stack, Text, TextInput, NativeSelect, SegmentedControl, Collapse, Group, UnstyledButton } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import { LABEL_STYLES, SectionLabel, lbl } from '../ui'
import RunButton from './RunButton'

// Deve restare allineato a PMAR_RESOLUTIONS in processes/PMARProcess.py
const RESOLUTIONS = [
  { value: '0.1',  label: '0.1°'  },
  { value: '0.05', label: '0.05°' },
]

// σ è la deviazione standard tra i seeding (chiave `std` nel risultato).
const INDICATORS = ['ppi', 'max', 'q90', 'std']

/**
 * "Dispersal from source": mappa dei passaggi per cella pesati dal layer sorgente
 * (processes/PMARProcess.py). MAX, Q90 e σ si calcolano tra i seeding, quindi ci sono
 * solo per una simulazione multi seeding.
 */
export default function DispersalSection({
  ctx, sourcePicker, useSource, geotiff, onRun, loading, stopping, onStop, onMarginChange,
}) {
  const { t, sc, scenarioId, scenarioLabel, scenarioInfo, ready, limitNote, analysesFull } = ctx
  const d = t.analysis.dispersal
  const p = t.pmar
  const [title, setTitle]         = useState('')
  const [indicator, setIndicator] = useState('ppi')
  const [res, setRes]             = useState('0.1')
  const [margin, setMargin]       = useState('1')
  const [advanced, setAdvanced]   = useState(false)
  const multi = sc?.seedings > 1

  // Una simulazione a seeding singolo ha solo PPI.
  useEffect(() => { if (!multi) setIndicator('ppi') }, [multi])

  // L'area della preview EMODnet in App segue il margine dell'analisi.
  const marginValue = Math.max(0, Math.min(parseFloat(margin) || 0, 20))
  useEffect(() => { onMarginChange?.(marginValue) }, [marginValue]) // eslint-disable-line react-hooks/exhaustive-deps

  const indLabel = t.pmarControls[{ ppi: 'indicatorDensity', max: 'indicatorMax', q90: 'indicatorQ90', std: 'indicatorStd' }[indicator]]
  const autoTitle = [indLabel, p.useSources[useSource], scenarioLabel].filter(Boolean).join(' · ')
  const canRun = ready && !loading && !analysesFull && (useSource !== 'geotiff' || !!geotiff.b64)

  function run() {
    if (!canRun) return
    onRun({
      scenario_id: scenarioId,
      res: parseFloat(res),
      margin: marginValue,
      geotiff_b64: useSource === 'geotiff' ? geotiff.b64 : null,
      indicator,
      title: title.trim() || autoTitle,
      info: {
        scenario: scenarioInfo(),
        params: {
          use_source: useSource, res: parseFloat(res), margin: marginValue, indicator,
          ...(useSource === 'geotiff' ? { geotiff_name: geotiff.name } : {}),
        },
      },
    })
    setTitle('')
  }

  return (
    <Stack gap="sm">
      <TextInput size="xs" label={t.analysis.layerTitle} placeholder={autoTitle} value={title}
                 onChange={e => setTitle(e.target.value)} maxLength={80} styles={LABEL_STYLES}
                 onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run() } }} />

      <div>
        <SectionLabel tip={p.tooltips.sectionUse}>{d.source}</SectionLabel>
        <div style={{ marginTop: 6 }}>{sourcePicker}</div>
      </div>

      <div>
        <SectionLabel>{d.indicators}</SectionLabel>
        <SegmentedControl
          mt={6} size="xs" fullWidth
          value={indicator} onChange={setIndicator}
          data={INDICATORS.filter(k => multi || k === 'ppi').map(k => ({
            value: k,
            label: t.pmarControls[{ ppi: 'indicatorDensity', max: 'indicatorMax', q90: 'indicatorQ90', std: 'indicatorStd' }[k]],
          }))}
          aria-label={d.indicators}
        />
        <Text size="10px" c="dimmed" mt={4} lh={1.35}>
          {sc ? (multi ? d.multiNote : d.singleNote) : null}
        </Text>
        {multi && <Text size="10px" c="dimmed" lh={1.35}>{d.indicatorHelp[indicator]}</Text>}
      </div>

      <UnstyledButton onClick={() => setAdvanced(v => !v)} aria-expanded={advanced}>
        <Group gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em', flex: 1 }}>
            {p.advancedLabel}
          </Text>
          <IconChevronDown size={12} style={{ transform: advanced ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        </Group>
      </UnstyledButton>
      <Collapse expanded={advanced}>
        <Stack gap="xs">
          <NativeSelect size="xs" label={lbl(p.labelRes, p.tooltips.labelRes)} value={res}
                        onChange={e => setRes(e.target.value)} data={RESOLUTIONS} styles={LABEL_STYLES} />
          <TextInput type="number" size="xs" label={lbl(p.labelMargin, p.tooltips.labelMargin)}
                     value={margin} min="0" max="20" step="any"
                     onChange={e => setMargin(e.target.value)} styles={LABEL_STYLES} />
        </Stack>
      </Collapse>

      <RunButton labels={t.analysis.runLabels} loading={loading} stopping={stopping} onStop={onStop}
                 disabled={!canRun} onRun={run} limitNote={limitNote}
                 hint={!sc ? p.hintNoScenario : useSource === 'geotiff' && !geotiff.b64 ? d.needTiff : null} />
    </Stack>
  )
}
