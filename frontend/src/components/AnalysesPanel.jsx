import { useEffect, useRef, useState } from 'react'
import {
  Paper, Box, ScrollArea, Stack, Group, Text, Badge, ActionIcon, Tooltip, TextInput,
  SegmentedControl, Switch, Button, Slider,
} from '@mantine/core'
import { IconEye, IconEyeOff, IconTrash, IconPencil, IconDownload, IconX,
         IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import ToolsPanel from './ToolsPanel'
import { MarkovLayer, clampFrame, effectiveLayer, firstUnvalidatedFrame, frameCount,
         frameSummary, layerAvailable } from '../markov/frames'

export const MAX_ANALYSES = 10

const KIND_COLORS = { pmar: 'blue', connectivity: 'teal', markov: 'grape' }

const SCROLLBAR_STYLES = {
  scrollbar: { background: 'transparent', '&[data-orientation="vertical"]': { width: 5 } },
  thumb: { background: 'rgba(10,132,255,0.35)', borderRadius: 99 },
}

const INDICATORS = [
  { key: 'ppi', labelKey: 'indicatorDensity' },
  { key: 'sum', labelKey: 'indicatorSum' },
  { key: 'max', labelKey: 'indicatorMax' },
  { key: 'q90', labelKey: 'indicatorQ90' },
]
const METRICS = [
  { key: 'in_strength',  labelKey: 'metricInStrength'  },
  { key: 'out_strength', labelKey: 'metricOutStrength' },
  { key: 'betweenness',  labelKey: 'metricBetweenness' },
]
const EDGE_DIRECTIONS = [
  { key: 'both', labelKey: 'edgesBoth' },
  { key: 'in',   labelKey: 'edgesIn'   },
  { key: 'out',  labelKey: 'edgesOut'  },
]
// Layer EMODnet che un risultato PMAR può portarsi dietro, con l'etichetta della sorgente.
const SOURCE_LAYERS = [
  ['windfarms_geojson',  'windfarms'],
  ['offshore_geojson',   'offshore_installations'],
  ['msp_zones_geojson',  'msp_zones'],
]

/**
 * Pannello di destra con le analisi salvate in sessione: speculare a quello
 * principale. In cima gli strumenti (lavorano sull'analisi attiva), sotto una scheda
 * per analisi, la più recente in alto. Solo presentazione: lo stato vive in App.
 */
export default function AnalysesPanel({
  analyses, activeId, onActivate, onDelete, onClearAll, onRename, onUpdateView, onDownload, tools,
}) {
  const { t } = useLang()
  const a = t.analyses
  const active = analyses.find(x => x.id === activeId)
  // Le analisi restano salvate nel browser: su un portatile condiviso (lo stand di
  // una conferenza) serve un modo rapido per ripartire da zero. Con conferma.
  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <Paper
      shadow="xl"
      radius="lg"
      p={0}
      className="analyses-panel"
      style={{
        position: 'absolute', top: 16, right: 16, zIndex: 1000, width: 310,
        height: 'calc(100vh - 32px)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: 'var(--panel-bg)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <Box px="md" py="sm" style={{ borderBottom: '1px solid var(--modal-divider)', flexShrink: 0 }}>
        <Group justify="space-between" align="baseline">
          <Text fw={700} size="md">{a.title}</Text>
          <Group gap={8} align="baseline">
            <Button size="compact-xs" variant="subtle" color="gray" type="button"
                    leftSection={<IconTrash size={12} />} onClick={() => setConfirmClear(v => !v)}>
              {a.clearAll}
            </Button>
            <Text size="xs" c={analyses.length >= MAX_ANALYSES ? 'orange.6' : 'dimmed'} fw={600}>
              {analyses.length}/{MAX_ANALYSES}
            </Text>
          </Group>
        </Group>
        {confirmClear && (
          <Stack gap={6} mt={8}>
            <Text size="xs">{a.clearConfirm}</Text>
            <Group gap={6} justify="flex-end">
              <Button size="compact-xs" variant="default" type="button" onClick={() => setConfirmClear(false)}>
                {a.cancel}
              </Button>
              <Button size="compact-xs" color="red" type="button"
                      onClick={() => { setConfirmClear(false); onClearAll() }}>
                {a.clearYes}
              </Button>
            </Group>
          </Stack>
        )}
      </Box>

      <Box style={{ flexShrink: 0 }}>
        <ToolsPanel
          {...tools}
          hasRaster={active?.kind === 'pmar' || (active?.kind === 'markov' &&
            effectiveLayer(active.data, active.view.frame, active.view.layer) !== MarkovLayer.DIFFERENCE)}
          hasConnectivity={active?.kind === 'connectivity'}
        />
      </Box>

      <ScrollArea style={{ flex: 1, minHeight: 0 }} scrollbarSize={5} type="hover" styles={SCROLLBAR_STYLES}>
        <Stack gap={8} p="sm">
          {analyses.map(an => (
            <AnalysisCard
              key={an.id}
              an={an}
              active={an.id === activeId}
              onActivate={() => onActivate(an.id)}
              onDelete={() => onDelete(an.id)}
              onRename={title => onRename(an.id, title)}
              onView={patch => onUpdateView(an.id, patch)}
              onDownload={() => onDownload(an)}
            />
          ))}
        </Stack>
      </ScrollArea>
    </Paper>
  )
}

/** I click sui comandi non devono anche attivare/espandere la scheda. */
const stop = e => e.stopPropagation()

function AnalysisCard({ an, active, onActivate, onDelete, onRename, onView, onDownload }) {
  const { t } = useLang()
  const a = t.analyses
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(an.title)
  const v = an.view
  const isPmar = an.kind === 'pmar'

  function commitRename() {
    const title = draft.trim()
    if (title) onRename(title)
    else setDraft(an.title)
    setEditing(false)
  }

  return (
    <Paper
      p="xs"
      radius="md"
      onClick={onActivate}
      className={`analysis-card${active ? ' is-active' : ''}${v.visible ? '' : ' is-hidden'}`}
      data-analysis-id={an.id}
    >
      {/* ── Riga compatta: tipo, titolo, mostra/nascondi, elimina ── */}
      <Group gap={6} wrap="nowrap" align="center">
        <Badge size="xs" variant="light" color={KIND_COLORS[an.kind]} style={{ flexShrink: 0 }}>
          {{ pmar: a.kindPmar, connectivity: a.kindConnectivity, markov: a.kindMarkov }[an.kind]}
        </Badge>
        {editing ? (
          <TextInput
            size="xs"
            value={draft}
            autoFocus
            maxLength={80}
            onClick={stop}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter')  { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { setDraft(an.title); setEditing(false) }
            }}
            style={{ flex: 1 }}
          />
        ) : (
          <Text size="xs" fw={600} lineClamp={active ? 3 : 1} style={{ flex: 1, minWidth: 0 }} className="analysis-title">
            {an.title}
          </Text>
        )}
        {active && !editing && (
          <Tooltip label={a.rename} withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={a.rename}
                        onClick={e => { stop(e); setDraft(an.title); setEditing(true) }}>
              <IconPencil size={13} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label={v.visible ? a.hide : a.show} withArrow>
          <ActionIcon size="sm" variant="subtle" color={v.visible ? 'blue' : 'gray'}
                      aria-label={v.visible ? a.hide : a.show}
                      onClick={e => { stop(e); onView({ visible: !v.visible }) }}>
            {v.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={a.delete} withArrow>
          <ActionIcon size="sm" variant="subtle" color="red" aria-label={a.delete}
                      onClick={e => { stop(e); onDelete() }}>
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* ── Scheda espansa: solo l'analisi attiva ── */}
      {active && (
        <Stack gap={8} mt={8} onClick={stop} style={{ cursor: 'default' }}>
          <Description an={an} />
          {isPmar ? <PmarControls an={an} onView={onView} onDownload={onDownload} />
           : an.kind === 'markov' ? <MarkovCardControls an={an} onView={onView} />
           : <ConnectivityControls an={an} onView={onView} />}
        </Stack>
      )}
    </Paper>
  )
}

function useLabels() {
  const { t } = useLang()
  return { t, a: t.analyses, c: t.pmarControls }
}

function PmarControls({ an, onView, onDownload }) {
  const { t, a, c } = useLabels()
  const v = an.view
  const d = an.data
  const indicators = [
    ...(d.sum_raster_values ? INDICATORS : INDICATORS.slice(0, 1)),
    ...(d.std_raster_values ? [{ key: 'std', labelKey: 'indicatorStd' }] : []),
  ]
  const source = SOURCE_LAYERS.find(([k]) => d[k]?.features?.length)
  return (
    <Stack gap={6}>
      {indicators.length > 1 && (
        <Field label={a.indicator}>
          <SegmentedControl
            size="xs" fullWidth
            value={v.indicator}
            onChange={indicator => onView({ indicator })}
            data={indicators.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
          />
        </Field>
      )}
      <Field label={a.layers}>
        <Stack gap={4}>
          {an.areaGeoJSON && (
            <Switch size="xs" label={a.seedArea} checked={v.showSeedArea}
                    onChange={e => onView({ showSeedArea: e.currentTarget.checked })} />
          )}
          {source && (
            <Switch size="xs" label={t.pmar.useSources[source[1]]} checked={v.showSource}
                    onChange={e => onView({ showSource: e.currentTarget.checked })} />
          )}
        </Stack>
      </Field>
      <Button size="xs" variant="light" leftSection={<IconDownload size={13} />} onClick={onDownload}>
        {c.downloadRaster}
      </Button>
    </Stack>
  )
}

// Un passo del cursore ogni 0.9 s: abbastanza per leggere giorno e mappa.
const PLAY_INTERVAL_MS = 900

/**
 * Comandi di un'analisi Markov: cursore dei frame (con play), livello mostrato
 * (previsione, simulazione, differenza) e riassunto del frame.
 */
function MarkovCardControls({ an, onView }) {
  const { t, a } = useLabels()
  const m = t.pmar.markov
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

  const togglePlay = () => {
    if (!playing && k >= n - 1) onView({ frame: 0 })      // dalla fine si riparte
    setPlaying(p => !p)
  }
  const pct = x => `${(x * 100).toFixed(1)} %`
  // Residui di arrotondamento (1e-17) sono zero: al primo passo l'errore è nullo per costruzione.
  const num = x => (Math.abs(x) < 1e-12 ? 0 : Math.abs(x) >= 0.01 ? +x.toPrecision(3) : x.toExponential(1))

  return (
    <Stack gap={6}>
      <Field label={`${m.dayN.replace('{d}', sum.day)} · ${m.stepN.replace('{k}', k).replace('{n}', n - 1)}`}>
        <Group gap={8} wrap="nowrap" align="center">
          <Tooltip label={playing ? m.pause : m.play} withArrow>
            <ActionIcon size="sm" variant="light" aria-label={playing ? m.pause : m.play} onClick={togglePlay}>
              {playing ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
            </ActionIcon>
          </Tooltip>
          <Slider
            style={{ flex: 1 }} size="sm"
            min={0} max={n - 1} step={1} value={k}
            onChange={frame => { setPlaying(false); onView({ frame }) }}
            label={i => m.dayN.replace('{d}', d.frames[i]?.day ?? '')}
            marks={firstOut !== null && firstOut > 0 ? [{ value: firstOut - 1 }] : []}
            aria-label={m.frameSlider}
          />
        </Group>
      </Field>
      <Field label={a.layers}>
        <SegmentedControl
          size="xs" fullWidth
          value={layer}
          onChange={l => onView({ layer: l })}
          data={Object.values(MarkovLayer).map(l => ({
            value: l, label: m.layersShort[l], disabled: !layerAvailable(d, k, l),
          }))}
        />
      </Field>
      <div className="analysis-desc-block markov-summary">
        <Row k={m.massOut} v={sum.refMassOut !== null && sum.validated
          ? m.massOutBoth.replace('{m}', pct(sum.massOut)).replace('{s}', pct(sum.refMassOut))
          : pct(sum.massOut)} />
        {sum.validated
          ? <Row k={m.error} v={m.errorValue.replace('{e}', num(sum.emax)).replace('{mae}', num(sum.mae))} />
          : k > 0 && <Text size="10px" c="orange.6">{m.noValidation.replace('{d}', d.valid_days)}</Text>}
        {k === 1 && sum.validated && <Text size="10px" c="dimmed">{m.firstStepExact}</Text>}
      </div>
      <Field label={a.layers}>
        <Stack gap={4}>
          {an.areaGeoJSON && (
            <Switch size="xs" label={a.seedArea} checked={v.showSeedArea}
                    onChange={e => onView({ showSeedArea: e.currentTarget.checked })} />
          )}
          {d.source_geojson && (
            <Switch size="xs" label={m.sourceShown} checked={v.showSource}
                    onChange={e => onView({ showSource: e.currentTarget.checked })} />
          )}
        </Stack>
      </Field>
    </Stack>
  )
}

function Row({ k, v }) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Text size="10px" c="dimmed">{k}</Text>
      <Text size="xs" c="blue.5" fw={500} ta="right">{v}</Text>
    </Group>
  )
}

function ConnectivityControls({ an, onView }) {
  const { a, c } = useLabels()
  const v = an.view
  const labels = an.data.node_labels ?? []
  return (
    <Stack gap={6}>
      <Field label={a.metric}>
        <SegmentedControl
          size="xs" fullWidth
          value={v.metric}
          onChange={metric => onView({ metric })}
          data={METRICS.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
        />
      </Field>
      <Field label={a.layers}>
        <Stack gap={4}>
          {an.areaGeoJSON && (
            <Switch size="xs" label={a.seedArea} checked={v.showSeedArea}
                    onChange={e => onView({ showSeedArea: e.currentTarget.checked })} />
          )}
          <Switch size="xs" label={a.polygons} checked={v.showPolygons}
                  onChange={e => onView({ showPolygons: e.currentTarget.checked })} />
          <Switch size="xs" label={a.arrows} checked={v.showEdges}
                  onChange={e => onView({ showEdges: e.currentTarget.checked })} />
        </Stack>
      </Field>
      {v.selectedNode !== null && (
        <Field label={c.selectionLabel}>
          <Group gap={6} wrap="nowrap">
            <Badge size="sm" variant="light" color="gray">{labels[v.selectedNode] ?? v.selectedNode}</Badge>
            <SegmentedControl
              size="xs" style={{ flex: 1 }}
              value={v.edgeDirection}
              onChange={edgeDirection => onView({ edgeDirection })}
              data={EDGE_DIRECTIONS.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
            />
            <Tooltip label={c.clearSelection} withArrow>
              <ActionIcon size="sm" variant="subtle" color="gray" aria-label={c.clearSelection}
                          onClick={() => onView({ selectedNode: null })}>
                <IconX size={13} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Field>
      )}
    </Stack>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <Text size="10px" fw={600} c="dimmed" tt="uppercase" mb={3} style={{ letterSpacing: '0.05em' }}>{label}</Text>
      {children}
    </div>
  )
}

/** Descrizione automatica: dati della simulazione usata e parametri dell'analisi. */
function Description({ an }) {
  const { t, lang } = useLang()
  const a = t.analyses
  const p = t.pmar
  const sc = an.info?.scenario ?? {}
  const pr = an.info?.params ?? {}
  const loc = (it, en) => (lang === 'it' ? it : en) || it || en
  const area = loc(sc.area_it, sc.area_en)

  const simulation = [
    [a.scenario,  loc(sc.label_it, sc.label_en)],
    [a.area,      area && !/^(Area personalizzata|Custom area)$/.test(area) ? area : null],
    [a.pressure,  p.pressures[sc.pressure]],
    [a.start,     sc.start_time?.slice(0, 10)],
    [a.duration,  sc.duration_days != null ? `${sc.duration_days} d` : null],
    [a.particles, sc.pnum?.toLocaleString()],
    [a.seedings,  sc.seedings > 1 ? `${sc.seedings}× / ${sc.tshift} d` : null],
    [a.timeStep,  sc.time_step_hours != null ? `${sc.time_step_hours} h` : null],
  ]
  const m = p.markov
  const analysis = an.kind === 'markov'
    ? [
        [a.sourceLayer, [pr.source === 'area' ? m.sourceArea
                          : p.useSources[pr.source === 'uniform' ? 'none' : pr.source],
                         pr.geotiff_name].filter(Boolean).join(' · ')],
        [m.labelRelease, pr.release === 'continuous' ? m.releaseContinuous : m.releaseSingle],
        [m.dt,          an.data.dt_days != null ? `${+an.data.dt_days.toFixed(3)} d` : null],
        [a.horizon,     an.data.horizon_days != null ? `${an.data.horizon_days} d` : null],
        [a.resolution,  an.data.res != null ? `${an.data.res}°` : null],
        [m.cells,       an.data.cells?.length?.toLocaleString()],
        [m.unit,        an.data.unit === 'relative' ? m.unitRelative : m.unitFraction],
      ]
    : an.kind === 'pmar'
    ? [
        [a.sourceLayer, [p.useSources[pr.use_source], pr.geotiff_name].filter(Boolean).join(' · ')],
        [a.resolution,  pr.res != null ? `${pr.res}°` : null],
        [a.margin,      pr.margin != null ? `${pr.margin}°` : null],
      ]
    : [
        [a.mode,      pr.mode === 'transition' ? p.connectivity.modeTransition : p.connectivity.modePassage],
        [a.horizon,   pr.t_days != null ? `${pr.t_days} d` : null],
        [a.nodes,     pr.node_source === 'grid'
                        ? `${p.connectivity.sourceGrid} ${pr.grid_res}°`
                        : [p.connectivity.sourceShapefile, pr.shapefile_name].filter(Boolean).join(' · ')],
        [a.nNodes,    an.data.node_labels?.length],
        [a.selfLoops, pr.self_loops ? a.yes : a.no],
      ]

  return (
    <div className="analysis-desc">
      <DescBlock title={a.simulation} rows={simulation} />
      <DescBlock title={a.analysis} rows={analysis} />
    </div>
  )
}

function DescBlock({ title, rows }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '')
  if (!shown.length) return null
  return (
    <div className="analysis-desc-block">
      <Text size="10px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>{title}</Text>
      {shown.map(([k, val]) => (
        <Group key={k} justify="space-between" gap="xs" wrap="nowrap">
          <Text size="10px" c="dimmed">{k}</Text>
          <Text size="xs" c="blue.5" fw={500} ta="right" style={{ minWidth: 0 }} truncate>{val}</Text>
        </Group>
      ))}
    </div>
  )
}
