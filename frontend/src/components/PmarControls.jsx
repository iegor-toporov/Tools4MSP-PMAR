import { Paper, Stack, Group, SegmentedControl, ActionIcon, Tooltip, Text, Divider } from '@mantine/core'
import { IconEye, IconEyeOff, IconDownload, IconCircle, IconWind, IconDroplet, IconFish } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

const INDICATORS_BASE = [
  { key: 'ppi', labelKey: 'indicatorDensity' },
  { key: 'sum',     labelKey: 'indicatorSum' },
  { key: 'max',     labelKey: 'indicatorMax' },
  { key: 'q90',     labelKey: 'indicatorQ90' },
]
const INDICATOR_STD = { key: 'std', labelKey: 'indicatorStd' }

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
      <Stack gap={4}>
        {/* Row 1: PMAR label + SegmentedControl */}
        <Group gap="sm" align="center" wrap="nowrap">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em', flexShrink: 0 }}>
            PMAR
          </Text>
          {hasIndicators && (
            <>
              <Divider orientation="vertical" color="var(--modal-divider)" />
              <SegmentedControl
                size="xs"
                value={activeIndicator}
                onChange={onIndicatorChange}
                data={indicators.map(({ key, labelKey }) => ({ value: key, label: c[labelKey] }))}
                color="blue"
              />
            </>
          )}
        </Group>

        {/* Row 2: visibility toggles + download */}
        <Group gap="xs" align="center" wrap="nowrap" justify="center">
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

          <Divider orientation="vertical" color="var(--modal-divider)" />
          <Tooltip label={c.downloadRaster} withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={onDownloadPmar}>
              <IconDownload size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Stack>
    </Paper>
  )
}
