import { Paper, SegmentedControl, ActionIcon, Tooltip, Text, Divider } from '@mantine/core'
import { IconEye, IconEyeOff, IconDownload, IconCircle, IconWind, IconDroplet, IconFish, IconPolygon, IconChartDots3, IconX } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

const INDICATORS_BASE = [
  { key: 'ppi', labelKey: 'indicatorDensity' },
  { key: 'sum',     labelKey: 'indicatorSum' },
  { key: 'max',     labelKey: 'indicatorMax' },
  { key: 'q90',     labelKey: 'indicatorQ90' },
]
const INDICATOR_STD = { key: 'std', labelKey: 'indicatorStd' }

const EDGE_DIRECTIONS = [
  { key: 'both', labelKey: 'edgesBoth' },
  { key: 'in',   labelKey: 'edgesIn'   },
  { key: 'out',  labelKey: 'edgesOut'  },
]

const CONNECTIVITY_METRICS = [
  { key: 'in_strength',  labelKey: 'metricInStrength'  },
  { key: 'out_strength', labelKey: 'metricOutStrength' },
  { key: 'betweenness',  labelKey: 'metricBetweenness' },
]

const LABEL_CELL = { padding: '5px 12px 5px 0', display: 'flex', alignItems: 'center' }
const CTRL_CELL  = {
  padding:     '5px 0 5px 12px',
  display:     'flex',
  alignItems:  'center',
  gap:         6,
  flexWrap:    'wrap',
  borderLeft:  '1px solid var(--panel-border)',
}

/**
 * Una riga della barra: nome a sinistra, controlli a destra.
 *
 * Le due colonne appartengono a un'unica griglia `max-content 1fr`, quindi la
 * linea di separazione cade alla stessa x in tutte le righe: con un divisore per
 * riga, invece, un'etichetta corta avrebbe tirato i suoi controlli più a
 * sinistra delle altre.
 */
function Row({ label, color = 'dimmed', children }) {
  return (
    <>
      <div style={LABEL_CELL}>
        <Text size="xs" fw={700} c={color} tt="uppercase"
              style={{ letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
          {label}
        </Text>
      </div>
      <div style={CTRL_CELL}>{children}</div>
    </>
  )
}

export default function PmarControls({
  showPmarRaster,
  onTogglePmarRaster,
  showSeedShape,
  onToggleSeedShape,
  showWindFarms,
  onToggleWindFarms,
  hasWindFarms,
  showOffshoreInstallations,
  onToggleOffshoreInstallations,
  hasOffshoreInstallations,
  showMspZones,
  onToggleMspZones,
  hasMspZones,
  onDownloadPmar,
  elevated,
  activeIndicator,
  onIndicatorChange,
  hasIndicators,
  hasStdRaster,
  hasRaster,
  hasSeedingArea,
  hasConnectivity,
  connectivityMetric,
  onConnectivityMetricChange,
  showConnectivity,
  onToggleConnectivity,
  showConnEdges,
  onToggleConnEdges,
  selectedNodeLabel,
  edgeDirection,
  onEdgeDirectionChange,
  onClearSelection,
}) {
  const { t } = useLang()
  const c = t.pmarControls

  const indicators = hasStdRaster
    ? [...INDICATORS_BASE, INDICATOR_STD]
    : INDICATORS_BASE

  return (
    <Paper
      shadow="xl"
      radius="lg"
      style={{
        position: 'absolute',
        bottom: elevated ? 90 : 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: 'var(--panel-bg)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid var(--panel-border)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.16)',
        transition: 'bottom 0.2s',
      }}
      px="md"
      py="xs"
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', alignItems: 'center' }}>

        {/* Indicatore del raster PMAR */}
        {hasRaster && (
          <Row label="PMAR">
            {hasIndicators && (
              <SegmentedControl
                size="xs"
                value={activeIndicator}
                onChange={onIndicatorChange}
                data={indicators.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
                color="blue"
              />
            )}
          </Row>
        )}

        {/* Metrica di connettività */}
        {hasConnectivity && (
          <Row label={c.connectivityLabel}>
            <SegmentedControl
              size="xs"
              value={connectivityMetric}
              onChange={onConnectivityMetricChange}
              data={CONNECTIVITY_METRICS.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
              color="teal"
            />
          </Row>
        )}

        {/* Poligono selezionato — solo a selezione attiva, così la barra non resta
            occupata da un controllo che non avrebbe su cosa agire */}
        {hasConnectivity && selectedNodeLabel && (
          <Row label={c.selectionLabel}>
            <Text size="xs" fw={700} c="teal.4" style={{ letterSpacing: '0.04em', marginRight: 2 }}>
              {selectedNodeLabel}
            </Text>
            <SegmentedControl
              size="xs"
              value={edgeDirection}
              onChange={onEdgeDirectionChange}
              data={EDGE_DIRECTIONS.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
              color="teal"
            />
            <Tooltip label={c.clearSelection} withArrow>
              <ActionIcon size="sm" variant="subtle" color="gray" onClick={onClearSelection}>
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          </Row>
        )}

        {/* Visibilità dei layer + download */}
        <Row label={c.visibilityLabel}>
          {hasRaster && (
            <Tooltip label={showPmarRaster ? c.hideRaster : c.showRaster} withArrow>
              <ActionIcon
                size="sm"
                variant={showPmarRaster ? 'filled' : 'subtle'}
                color="blue"
                onClick={onTogglePmarRaster}
              >
                {showPmarRaster ? <IconEye size={14} /> : <IconEyeOff size={14} />}
              </ActionIcon>
            </Tooltip>
          )}

          {/* Vale per qualunque area di semina a schermo — quella che accompagna un
              raster PMAR, quella della simulazione scelta, quella disegnata — e non
              solo per la prima, com'era prima: durante la connettività il tasto
              spariva proprio mentre un'area c'era. */}
          {hasSeedingArea && (
            <Tooltip label={showSeedShape ? c.hideSeed : c.showSeed} withArrow>
              <ActionIcon
                size="sm"
                variant={showSeedShape ? 'filled' : 'subtle'}
                color="blue"
                onClick={onToggleSeedShape}
              >
                <IconCircle size={14} />
              </ActionIcon>
            </Tooltip>
          )}

          {hasConnectivity && (
            <>
              <Tooltip label={showConnectivity ? c.hideConnectivity : c.showConnectivity} withArrow>
                <ActionIcon
                  size="sm"
                  variant={showConnectivity ? 'filled' : 'subtle'}
                  color="teal"
                  onClick={onToggleConnectivity}
                >
                  <IconPolygon size={14} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={`${showConnEdges ? c.hideEdges : c.showEdges} — ${c.edgesHint}`} withArrow>
                <ActionIcon
                  size="sm"
                  variant={showConnEdges ? 'filled' : 'subtle'}
                  color="teal"
                  onClick={onToggleConnEdges}
                >
                  <IconChartDots3 size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          )}

          {hasWindFarms && (
            <Tooltip label={showWindFarms ? c.hideWindFarms : c.showWindFarms} withArrow>
              <ActionIcon
                size="sm"
                variant={showWindFarms ? 'filled' : 'subtle'}
                color="blue"
                onClick={onToggleWindFarms}
              >
                <IconWind size={14} />
              </ActionIcon>
            </Tooltip>
          )}

          {hasOffshoreInstallations && (
            <Tooltip label={showOffshoreInstallations ? c.hideOffshore : c.showOffshore} withArrow>
              <ActionIcon
                size="sm"
                variant={showOffshoreInstallations ? 'filled' : 'subtle'}
                color="blue"
                onClick={onToggleOffshoreInstallations}
              >
                <IconDroplet size={14} />
              </ActionIcon>
            </Tooltip>
          )}

          {hasMspZones && (
            <Tooltip label={showMspZones ? c.hideMspZones : c.showMspZones} withArrow>
              <ActionIcon
                size="sm"
                variant={showMspZones ? 'filled' : 'subtle'}
                color="blue"
                onClick={onToggleMspZones}
              >
                <IconFish size={14} />
              </ActionIcon>
            </Tooltip>
          )}

          {hasRaster && (
            <>
              <Divider orientation="vertical" color="var(--modal-divider)" style={{ height: 18 }} />
              <Tooltip label={c.downloadRaster} withArrow>
                <ActionIcon size="sm" variant="subtle" color="gray" onClick={onDownloadPmar}>
                  <IconDownload size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </Row>
      </div>
    </Paper>
  )
}
