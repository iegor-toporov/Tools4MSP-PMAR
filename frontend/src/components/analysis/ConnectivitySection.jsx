import { useEffect, useRef, useState } from 'react'
import { Stack, Text, TextInput, NativeSelect, Switch, Group, Button } from '@mantine/core'
import { IconFileUpload } from '@tabler/icons-react'
import { Process, executeSync } from '../../api/ogcProcesses'
import { LABEL_STYLES, SectionLabel, RadioCard, InfoTip, lbl } from '../ui'
import RunButton from './RunButton'
import BboxPicker, { bboxOf } from './BboxPicker'

// Limiti del backend (processes/ConnectivityProcess.py).
export const GRID_RES_MIN = 0.05
export const GRID_RES_MAX = 5
const MAX_SEA_CELLS = 300

/**
 * "Structural connectivity": matrice di transizione o di passaggio fra i nodi
 * (processes/ConnectivityProcess.py). I nodi sono i poligoni dell'area di semina della
 * simulazione, quelli di uno shapefile caricato, o le celle di una griglia generata.
 */
export default function ConnectivitySection({ ctx, onRun, loading, stopping, onStop, draw, active }) {
  const { t, sc, scenarioId, scenarioLabel, scenarioInfo, ready, limitNote, analysesFull } = ctx
  const c = t.analysis.connectivity
  const pc = t.pmar.connectivity
  const [title, setTitle]       = useState('')
  const [mode, setMode]         = useState('transition')
  const seedingOk = (sc?.n_seed_polygons ?? 0) >= 2
  const [nodes, setNodes]       = useState(seedingOk ? 'seeding_area' : 'grid')
  const [shp, setShp]           = useState(null)            // { b64, name }
  const [columns, setColumns]   = useState(null)            // colonne dello shapefile, o null
  const [columnsError, setColumnsError] = useState(null)
  const [labelField, setLabelField] = useState('')
  const [res, setRes]           = useState('0.25')
  const [days, setDays]         = useState('')
  const [selfLoops, setSelfLoops] = useState(true)
  const fileRef = useRef(null)

  // Cambiando simulazione, "Use seeding area" può non valere più.
  useEffect(() => {
    if (nodes === 'seeding_area' && sc && !seedingOk) setNodes('grid')
  }, [scenarioId, seedingOk]) // eslint-disable-line react-hooks/exhaustive-deps

  // Il riquadro disegnato si vede solo mentre la griglia è la scelta in vista.
  useEffect(() => {
    draw.onVisible('connBbox', active && nodes === 'grid')
  }, [active, nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleFile(file) {
    const reader = new FileReader()
    reader.onload = async ev => {
      const b64 = ev.target.result.split(',')[1]
      setShp({ b64, name: file.name })
      setColumns(null); setColumnsError(null); setLabelField('')
      try {
        const r = await executeSync(Process.SHAPEFILE_FIELDS, { shapefile_b64: b64 })
        setColumns(r.columns ?? [])
      } catch (err) {
        setColumnsError(err?.detail?.replace(/^Error executing process:\s*/i, '') || c.columnsError)
      }
    }
    reader.readAsDataURL(file)
  }

  const resNum = parseFloat(res)
  const resOk  = resNum >= GRID_RES_MIN && resNum <= GRID_RES_MAX
  const bbox   = bboxOf(draw.shapes.connBbox) ?? sc?.bounds ?? null
  const cells  = resOk && bbox
    ? Math.ceil((bbox[2] - bbox[0]) / resNum - 1e-9) * Math.ceil((bbox[3] - bbox[1]) / resNum - 1e-9)
    : null

  const nodesLabel = nodes === 'grid' ? `${resOk ? res : '?'}° ${c.gridWord}`
                   : nodes === 'shapefile' ? (shp?.name ?? pc.sourceShapefile)
                   : c.useSeeding
  const autoTitle = [mode === 'transition' ? pc.modeTransition : pc.modePassage, nodesLabel, scenarioLabel]
    .filter(Boolean).join(' · ')

  const nodesReady = nodes === 'seeding_area' ? seedingOk
                   : nodes === 'shapefile' ? !!shp && !columnsError
                   : resOk
  const canRun = ready && !loading && !analysesFull && nodesReady

  function run() {
    if (!canRun) return
    const tDays = days ? parseFloat(days) : null
    const drawn = bboxOf(draw.shapes.connBbox)
    onRun({
      scenario_id: scenarioId,
      mode,
      self_loops: selfLoops,
      node_source: nodes === 'shapefile' ? 'polygons' : nodes,
      ...(tDays ? { t_days: tDays } : {}),
      ...(nodes === 'shapefile'
            ? { shapefile_b64: shp.b64, ...(labelField ? { node_label_field: labelField } : {}) } : {}),
      // Senza riquadro disegnato il backend usa l'area dello scenario: è il default mostrato.
      ...(nodes === 'grid' ? { grid_res: resNum, ...(drawn ? { bbox: drawn } : {}) } : {}),
    }, {
      title: title.trim() || autoTitle,
      info: {
        scenario: scenarioInfo(),
        params: {
          mode, self_loops: selfLoops, t_days: tDays ?? sc?.duration_days,
          node_source: nodes === 'shapefile' ? 'polygons' : nodes,
          ...(nodes === 'shapefile' ? { shapefile_name: shp.name, label_field: labelField || null } : {}),
          ...(nodes === 'grid' ? { grid_res: resNum, bbox: drawn } : {}),
        },
      },
    })
    setTitle('')
  }

  const hint = !sc ? t.pmar.hintNoScenario
             : nodes === 'shapefile' && !shp ? pc.hintNoShapefile
             : nodes === 'grid' && !resOk ? c.resRange.replace('{min}', GRID_RES_MIN).replace('{max}', GRID_RES_MAX)
             : null

  return (
    <Stack gap="sm">
      <TextInput size="xs" label={t.analysis.layerTitle} placeholder={autoTitle} value={title}
                 onChange={e => setTitle(e.target.value)} maxLength={80} styles={LABEL_STYLES}
                 onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run() } }} />

      <div>
        <SectionLabel>{c.matrixType}</SectionLabel>
        <Stack gap={6} mt={6} role="radiogroup">
          <RadioCard selected={mode === 'transition'} onSelect={() => setMode('transition')}
                     title={c.transition} tip={c.transitionTip} />
          <RadioCard selected={mode === 'passage'} onSelect={() => setMode('passage')}
                     title={c.passage} tip={c.passageTip} />
        </Stack>
      </div>

      <div>
        <SectionLabel>{c.grid}</SectionLabel>
        <Stack gap={6} mt={6} role="radiogroup">
          <RadioCard selected={nodes === 'seeding_area'} disabled={!seedingOk}
                     onSelect={() => setNodes('seeding_area')}
                     title={c.useSeeding}
                     description={!sc ? null : seedingOk
                       ? c.useSeedingDesc.replace('{n}', sc.n_seed_polygons)
                       : c.useSeedingTooFew} />
          <RadioCard selected={nodes === 'shapefile'} onSelect={() => setNodes('shapefile')}
                     title={c.upload}>
            <Stack gap={6}>
              <Button size="xs" variant="default" type="button" fullWidth
                      leftSection={<IconFileUpload size={13} />} style={{ borderStyle: 'dashed' }}
                      onClick={() => fileRef.current?.click()}>
                <Text size="xs" truncate>{shp?.name ?? c.choose}</Text>
              </Button>
              <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }}
                     onChange={e => { const f = e.target.files[0]; if (f) handleFile(f) }} />
              {columnsError && <Text size="10px" c="red.5" lh={1.35}>{columnsError}</Text>}
              {shp && !columnsError && (
                <NativeSelect
                  size="xs"
                  label={lbl(c.polygonLabel, c.polygonLabelTip)}
                  value={labelField}
                  disabled={!columns}
                  onChange={e => setLabelField(e.target.value)}
                  data={[{ value: '', label: c.labelNone },
                         ...(columns ?? []).map(col => ({
                           value: col.name,
                           label: col.samples?.length ? `${col.name} (${col.samples.join(', ')}…)` : col.name,
                         }))]}
                  styles={LABEL_STYLES}
                />
              )}
            </Stack>
          </RadioCard>
          <RadioCard selected={nodes === 'grid'} onSelect={() => setNodes('grid')} title={c.generate}>
            <Stack gap={6}>
              <BboxPicker
                t={t} res={res} onResChange={setRes} resMin={GRID_RES_MIN} resMax={GRID_RES_MAX}
                shape={draw.shapes.connBbox} defaultBbox={sc?.bounds}
                drawing={draw.target === 'connBbox' && draw.mode === 'rectangle'}
                onDraw={() => draw.onStart('rectangle', 'connBbox')}
                onClear={() => draw.onClear('connBbox')}
              />
              {cells !== null && (
                <Text size="10px" c={cells > MAX_SEA_CELLS ? 'orange.6' : 'dimmed'} lh={1.35}>
                  {pc.cellsEstimate.replace('{n}', cells)}
                  {cells > MAX_SEA_CELLS && ` ${c.tooManyCells.replace('{max}', MAX_SEA_CELLS)}`}
                </Text>
              )}
            </Stack>
          </RadioCard>
        </Stack>
      </div>

      <div>
        <TextInput type="number" size="xs" label={c.interval} value={days} min="1" step="any"
                   placeholder={sc?.duration_days ? String(sc.duration_days) : c.intervalPlaceholder}
                   onChange={e => setDays(e.target.value)} styles={LABEL_STYLES} />
        <Text size="10px" c="dimmed" mt={4}>{c.intervalHint}</Text>
      </div>

      <Group justify="space-between" gap={6} wrap="nowrap">
        <Group gap={2} wrap="nowrap">
          <Text size="xs">{pc.selfLoopsLabel}</Text>
          <InfoTip text={t.pmar.tooltips.connSelfLoops} label={pc.selfLoopsLabel} size={12} />
        </Group>
        <Switch size="sm" checked={selfLoops} onChange={e => setSelfLoops(e.currentTarget.checked)}
                aria-label={pc.selfLoopsLabel} />
      </Group>

      <RunButton labels={t.analysis.runLabels} loading={loading} stopping={stopping} onStop={onStop}
                 disabled={!canRun} onRun={run} hint={hint} limitNote={limitNote} />
    </Stack>
  )
}

