import { useState } from 'react'
import {
  Paper, Box, ScrollArea, Stack, Group, Text, Badge, ActionIcon, Tooltip, TextInput,
  SegmentedControl, Switch, Button,
} from '@mantine/core'
import { IconEye, IconEyeOff, IconTrash, IconPencil, IconDownload, IconX } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'
import ToolsPanel from './ToolsPanel'

export const MAX_ANALYSES = 10

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
  analyses, activeId, onActivate, onDelete, onRename, onUpdateView, onDownload, tools,
}) {
  const { t } = useLang()
  const a = t.analyses
  const active = analyses.find(x => x.id === activeId)

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
          <Text size="xs" c={analyses.length >= MAX_ANALYSES ? 'orange.6' : 'dimmed'} fw={600}>
            {analyses.length}/{MAX_ANALYSES}
          </Text>
        </Group>
      </Box>

      <Box style={{ flexShrink: 0 }}>
        <ToolsPanel
          {...tools}
          hasRaster={active?.kind === 'pmar'}
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
        <Badge size="xs" variant="light" color={isPmar ? 'blue' : 'teal'} style={{ flexShrink: 0 }}>
          {isPmar ? a.kindPmar : a.kindConnectivity}
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
  const analysis = an.kind === 'pmar'
    ? [
        [a.sourceLayer, [p.useSources[pr.use_source], pr.geotiff_name].filter(Boolean).join(' · ')],
        [a.resolution,  pr.res != null ? `${pr.res}°` : null],
        [a.margin,      pr.margin != null ? `${pr.margin}°` : null],
      ]
    : [
        [a.mode,      pr.mode === 'transition' ? p.connectivity.modeTransition : p.connectivity.modeTransit],
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
