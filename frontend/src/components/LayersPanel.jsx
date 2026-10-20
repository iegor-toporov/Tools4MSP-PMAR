import { useState } from 'react'
import {
  Paper, Box, Stack, Group, Text, ActionIcon, Tooltip, TextInput,
  SegmentedControl, Switch, Button, Slider, Badge, UnstyledButton, Collapse,
} from '@mantine/core'
import { IconEye, IconEyeOff, IconTrash, IconPencil, IconDownload, IconX,
         IconInfoCircle, IconChevronDown, IconTable } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import { clampFrame, frameSummary } from '../markov/frames'

export const MAX_ANALYSES = 10

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

/** Giorno di un frame: interi senza decimali, frazioni (Δt in ore) con due. */
const formatDay = d => (Number.isInteger(d) ? `${d}` : `${+d.toFixed(2)}`)

/**
 * Pannello di destra "Layers": in alto i layer di base (area di semina, area di
 * studio, layer sorgente, griglia di connettività), sotto i layer creati dalle
 * analisi, il più recente in alto. Solo presentazione: lo stato vive in App.
 */
export default function LayersPanel({
  baseLayers, onToggleBase, baseSubject,
  analyses, activeId, onActivate, onDelete, onClearAll, onRename, onUpdateView,
  onDownload, onOpenMatrix, matrixOpenId, compact,
}) {
  const { t } = useLang()
  const l = t.layers
  const a = t.analyses
  const [baseOpen, setBaseOpen] = useState(true)
  const [anlOpen,  setAnlOpen]  = useState(true)
  // Le analisi restano salvate nel browser: su un portatile condiviso (lo stand di
  // una conferenza) serve un modo rapido per ripartire da zero. Con conferma.
  const [confirmClear, setConfirmClear] = useState(false)
  const full = analyses.length >= MAX_ANALYSES

  return (
    <Paper shadow="xl" radius="lg" p={0} className={`layers-panel${compact ? ' is-compact' : ''}`}>
      <Box px="md" py="sm" style={{ borderBottom: '1px solid var(--modal-divider)', flexShrink: 0 }}>
        <Group justify="space-between" align="center">
          <Text fw={700} size="md">{l.title}</Text>
          {analyses.length > 0 && (
            <Button size="compact-xs" variant="subtle" color="gray" type="button"
                    leftSection={<IconTrash size={12} />} onClick={() => setConfirmClear(v => !v)}>
              {a.clearAll}
            </Button>
          )}
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

      <div className="layers-scroll">
        <SectionHead open={baseOpen} onToggle={() => setBaseOpen(v => !v)} title={l.base} />
        <Collapse expanded={baseOpen}>
          <Stack gap={0} px="xs" pb="xs">
            <Text size="xs" c="dimmed" px={6} pb={4} lh={1.35} truncate>
              {baseSubject ? l.baseFor.replace('{name}', baseSubject) : l.basePreview}
            </Text>
            {baseLayers.map(b => (
              <BaseLayerRow key={b.key} layer={b} onToggle={() => onToggleBase(b.key)} labels={l} />
            ))}
          </Stack>
        </Collapse>

        <Box style={{ borderTop: '1px solid var(--modal-divider)' }}>
          <SectionHead open={anlOpen} onToggle={() => setAnlOpen(v => !v)} title={l.analyses}
                       count={analyses.length ? (full ? `${analyses.length}/${MAX_ANALYSES}` : analyses.length) : null}
                       countColor={full ? 'orange.6' : 'dimmed'} />
          <Collapse expanded={anlOpen}>
            <Stack gap={8} px="xs" pb="sm">
              {analyses.length === 0 && (
                <Text size="xs" c="dimmed" px={6} lh={1.4}>{l.empty}</Text>
              )}
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
                  onOpenMatrix={() => onOpenMatrix(an.id)}
                  matrixOpen={matrixOpenId === an.id}
                />
              ))}
            </Stack>
          </Collapse>
        </Box>
      </div>
    </Paper>
  )
}

function SectionHead({ open, onToggle, title, count, countColor }) {
  return (
    <UnstyledButton className="layers-section-head" onClick={onToggle} aria-expanded={open}>
      <IconChevronDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
      <Text size="sm" fw={600} style={{ flex: 1 }}>{title}</Text>
      {count !== null && count !== undefined && <Text size="xs" c={countColor}>{count}</Text>}
    </UnstyledButton>
  )
}

function BaseLayerRow({ layer, onToggle, labels }) {
  const { title, subtitle, on, available, swatch } = layer
  const label = (on ? labels.hideNamed : labels.showNamed).replace('{name}', title)
  return (
    <Group gap={10} wrap="nowrap" px={6} py={5} className={`base-layer-row${available ? '' : ' is-unavailable'}`}>
      <span className="base-layer-swatch" style={swatch} aria-hidden="true" />
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm">{title}</Text>
        {subtitle && <Text size="xs" c="dimmed" truncate>{subtitle}</Text>}
      </Stack>
      <Tooltip label={label} withArrow disabled={!available}>
        <ActionIcon size="md" variant="subtle" color={on && available ? 'blue' : 'gray'}
                    aria-label={label} aria-pressed={on} disabled={!available} onClick={onToggle}>
          {on ? <IconEye size={16} /> : <IconEyeOff size={16} />}
        </ActionIcon>
      </Tooltip>
    </Group>
  )
}

/** I click sui comandi non devono anche attivare la scheda. */
const stop = e => e.stopPropagation()

function AnalysisCard({ an, active, onActivate, onDelete, onRename, onView, onDownload,
                        onOpenMatrix, matrixOpen }) {
  const { t } = useLang()
  const l = t.layers
  const [editing, setEditing]   = useState(false)
  const [draft, setDraft]       = useState(an.title)
  const [showInfo, setShowInfo] = useState(false)
  const v = an.view
  const opacity = v.opacity ?? 0.8
  // Una connettività su poligoni non è un raster: si scaricano i poligoni con le metriche.
  const asGeojson = an.kind === 'connectivity' && an.data.node_source !== 'grid'

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
      <Group gap={2} wrap="nowrap" align="flex-start">
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
          <Text size="sm" fw={500} lh={1.35} style={{ flex: 1, minWidth: 0, paddingTop: 3 }}
                className="analysis-title">
            {an.title}
          </Text>
        )}
        <CardIcon label={l.details} pressed={showInfo} color={showInfo ? 'blue' : 'gray'}
                  onClick={() => setShowInfo(s => !s)}>
          <IconInfoCircle size={15} />
        </CardIcon>
        {!editing && (
          <CardIcon label={l.rename} color="gray" onClick={() => { setDraft(an.title); setEditing(true) }}>
            <IconPencil size={14} />
          </CardIcon>
        )}
        <CardIcon label={v.visible ? l.hideLayer : l.showLayer} color={v.visible ? 'blue' : 'gray'}
                  onClick={() => onView({ visible: !v.visible })}>
          {v.visible ? <IconEye size={15} /> : <IconEyeOff size={15} />}
        </CardIcon>
        <CardIcon label={l.delete} color="red" onClick={onDelete}>
          <IconTrash size={14} />
        </CardIcon>
      </Group>

      <Collapse expanded={showInfo}>
        <Box mt={6} onClick={stop}><Description an={an} /></Box>
      </Collapse>

      <Stack gap={8} mt={8} onClick={stop} style={{ cursor: 'default' }}>
        {an.kind === 'markov' && <MarkovStepNote an={an} />}
        {an.kind === 'connectivity' && (
          <ConnectivityControls an={an} onView={onView} onOpenMatrix={onOpenMatrix} matrixOpen={matrixOpen} />
        )}
        <Group gap={8} wrap="nowrap" align="center">
          <Text size="xs" c="dimmed" w={56}>{l.opacity}</Text>
          <Slider
            style={{ flex: 1 }} size="sm"
            min={0} max={1} step={0.05} value={opacity}
            onChange={o => onView({ opacity: o })}
            label={null}
            thumbLabel={l.opacity}
          />
          <Text size="xs" ff="monospace" w={36} ta="right">{Math.round(opacity * 100)}%</Text>
        </Group>
        <Button size="xs" variant="light" leftSection={<IconDownload size={13} />} onClick={onDownload}>
          {asGeojson ? l.downloadGeojson : l.download}
        </Button>
      </Stack>
    </Paper>
  )
}

function CardIcon({ label, color, pressed, onClick, children }) {
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon size={28} variant={pressed ? 'light' : 'subtle'} color={color} aria-label={label}
                  aria-pressed={pressed} onClick={e => { stop(e); onClick() }}>
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

function MarkovStepNote({ an }) {
  const { t } = useLang()
  const k = clampFrame(an.data, an.view.frame)
  const day = frameSummary(an.data, k).day
  return (
    <Text size="xs" c="dimmed" lh={1.35}>
      {t.layers.markovStep.replace('{k}', k).replace('{d}', formatDay(day))}
    </Text>
  )
}

function ConnectivityControls({ an, onView, onOpenMatrix, matrixOpen }) {
  const { t } = useLang()
  const c = t.pmarControls
  const l = t.layers
  const v = an.view
  const labels = an.data.node_labels ?? []
  return (
    <Stack gap={6}>
      <SegmentedControl
        size="xs" fullWidth
        value={v.metric}
        onChange={metric => onView({ metric })}
        data={METRICS.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
        aria-label={t.analyses.metric}
      />
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Switch size="xs" label={t.analyses.arrows} checked={v.showEdges}
                onChange={e => onView({ showEdges: e.currentTarget.checked })} />
        <Button size="compact-xs" variant={matrixOpen ? 'filled' : 'light'} type="button"
                leftSection={<IconTable size={12} />} onClick={onOpenMatrix}>
          {l.matrix}
        </Button>
      </Group>
      {v.selectedNode !== null && (
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
      )}
    </Stack>
  )
}

/** Riassunto automatico: dati della simulazione usata e parametri dell'analisi. */
function Description({ an }) {
  const { t, lang } = useLang()
  const a = t.analyses
  const p = t.pmar
  const sc = an.info?.scenario ?? {}
  const pr = an.info?.params ?? {}
  const loc = (it, en) => (lang === 'it' ? it : en) || it || en
  const area = loc(sc.area_it, sc.area_en)
  const ind = { ppi: 'indicatorDensity', max: 'indicatorMax', q90: 'indicatorQ90', std: 'indicatorStd' }

  const simulation = [
    [a.scenario,  loc(sc.label_it, sc.label_en)],
    [a.area,      area && !/^(Area personalizzata|Custom area)$/.test(area) ? area : null],
    [a.pressure,  p.pressures[sc.pressure]],
    [a.compound,  sc.pressure === 'chemical' ? sc.chemical_compound : null],
    [a.start,     sc.start_time?.slice(0, 10)],
    [a.duration,  sc.duration_days != null ? `${sc.duration_days} d` : null],
    [a.particles, sc.pnum?.toLocaleString()],
    [a.seedings,  sc.seedings > 1 ? `${sc.seedings}× / ${sc.tshift} d` : null],
    [a.timeStep,  sc.time_step_hours != null ? `${sc.time_step_hours} h` : null],
    // Assente nelle analisi salvate prima dell'opzione: non si mostra.
    [p.labelBeaching, sc.beaching === undefined ? null : sc.beaching === false ? a.no : a.yes],
  ]
  const m = p.markov
  const d = an.data
  const analysis = an.kind === 'markov'
    ? [
        [a.sourceLayer, [pr.source === 'area' ? m.sourceArea
                          : p.useSources[pr.source === 'uniform' ? 'none' : pr.source],
                         pr.geotiff_name].filter(Boolean).join(' · ')],
        [m.labelRelease, pr.release === 'continuous' ? m.releaseContinuous : m.releaseSingle],
        [a.matrix,      pr.matrix_from ?? null],
        [m.dt,          d.dt_days != null ? `${+d.dt_days.toFixed(3)} d` : null],
        [a.steps,       d.steps ?? (d.frames ? d.frames.length - 1 : null)],
        [a.horizon,     d.horizon_days != null ? `${d.horizon_days} d` : null],
        [a.resolution,  d.res != null ? `${d.res}°` : null],
        [m.cells,       d.cells?.length?.toLocaleString()],
        [m.unit,        d.unit === 'relative' ? m.unitRelative : m.unitFraction],
      ]
    : an.kind === 'pmar'
    ? [
        [a.sourceLayer, [p.useSources[pr.use_source], pr.geotiff_name].filter(Boolean).join(' · ')],
        [a.indicator,   t.pmarControls[ind[an.view.indicator ?? 'ppi']]],
        [a.resolution,  pr.res != null ? `${pr.res}°` : null],
        [a.margin,      pr.margin != null ? `${pr.margin}°` : null],
      ]
    : [
        [a.mode,      pr.mode === 'transition' ? p.connectivity.modeTransition : p.connectivity.modePassage],
        [a.horizon,   pr.t_days != null ? `${pr.t_days} d` : null],
        [a.nodes,     pr.node_source === 'grid'
                        ? `${p.connectivity.sourceGrid} ${pr.grid_res}°`
                        : pr.node_source === 'seeding_area' ? t.analysis.connectivity.useSeeding
                        : [p.connectivity.sourceShapefile, pr.shapefile_name].filter(Boolean).join(' · ')],
        [a.nNodes,    d.node_labels?.length],
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
