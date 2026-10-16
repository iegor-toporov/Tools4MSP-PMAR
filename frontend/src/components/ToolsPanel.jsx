import { Tooltip, Button, Badge } from '@mantine/core'
import {
  IconChartBar, IconChartAreaLine, IconWaveSine,
  IconBolt, IconFileTypeCsv, IconStack2, IconTable, IconX,
} from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

/**
 * `needs` names the result a tool operates on, because the two analyses produce
 * different results: every raster tool is useless without a PPI raster, and the
 * connectivity matrix is useless without a connectivity run. A single
 * `hasRaster` gate would have disabled the matrix on a connectivity-only session.
 */
const TOOLS = [
  { key: 'histogram',    Icon: IconChartBar,      labelKey: 'histogramBtn',    needs: 'raster' },
  { key: 'stats',        Icon: IconChartAreaLine, labelKey: 'statsBtn',        needs: 'raster' },
  { key: 'profile',      Icon: IconWaveSine,      labelKey: 'profileBtn',      needs: 'raster' },
  { key: 'threshold',    Icon: IconBolt,          labelKey: 'thresholdBtn',    needs: 'raster' },
  { key: 'csv',          Icon: IconFileTypeCsv,   labelKey: 'csvBtn',          needs: 'raster' },
  { key: 'comparison',   Icon: IconStack2,        labelKey: 'comparisonBtn',   needs: 'raster' },
  { key: 'connectivity', Icon: IconTable,         labelKey: 'connectivityBtn', needs: 'connectivity' },
]

const BTN_WIDTH = 152

export default function ToolsPanel({
  activeMapTool,
  onSetTool,
  hasRaster,
  hasConnectivity = false,
  windowCounts = {},
  openWindowCount = 0,
  onCloseAll,
}) {
  const { t } = useLang()
  const c = t.toolsPanel

  return (
    <div style={{
      position: 'absolute',
      top: '50%',
      transform: 'translateY(-50%)',
      right: 16,
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      alignItems: 'stretch',
      width: BTN_WIDTH,
    }}>
      {TOOLS.map(({ key, Icon, labelKey, needs }) => {
        const enabled  = needs === 'connectivity' ? hasConnectivity : hasRaster
        const isActive = activeMapTool === key
        const count    = windowCounts[key] ?? 0
        return (
          <div key={key} style={{ position: 'relative' }}>
            <Button
              fullWidth
              size="sm"
              radius="md"
              variant={isActive ? 'filled' : 'default'}
              color={isActive ? 'blue' : undefined}
              disabled={!enabled}
              leftSection={<Icon size={15} />}
              onClick={enabled ? () => onSetTool(key) : undefined}
              styles={{ inner: { justifyContent: 'flex-start' } }}
              style={{
                backdropFilter: 'blur(20px) saturate(180%)',
                background: isActive ? undefined : 'var(--panel-bg)',
                border: isActive ? undefined : '1px solid var(--panel-border)',
              }}
            >
              {c[labelKey]}
            </Button>
            {count > 0 && (
              <Badge
                size="xs"
                color="red"
                circle
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -4,
                  fontSize: 8,
                  minWidth: 14,
                  height: 14,
                  padding: 0,
                  pointerEvents: 'none',
                  zIndex: 1,
                }}
              >
                {count}
              </Badge>
            )}
          </div>
        )
      })}

      {openWindowCount > 0 && (
        <>
          <div style={{
            height: 1,
            background: 'var(--panel-border)',
            margin: '2px 0',
          }} />
          <div style={{ position: 'relative' }}>
            <Button
              fullWidth
              size="sm"
              radius="md"
              variant="default"
              color="red"
              leftSection={<IconX size={15} />}
              onClick={onCloseAll}
              styles={{ inner: { justifyContent: 'flex-start' } }}
              style={{
                backdropFilter: 'blur(20px) saturate(180%)',
                background: 'var(--panel-bg)',
                border: '1px solid var(--panel-border)',
              }}
            >
              {c.closeAllBtn}
            </Button>
            <Badge
              size="xs"
              color="red"
              circle
              style={{
                position: 'absolute',
                top: -4,
                right: -4,
                fontSize: 8,
                minWidth: 14,
                height: 14,
                padding: 0,
                pointerEvents: 'none',
                zIndex: 1,
              }}
            >
              {openWindowCount}
            </Badge>
          </div>
        </>
      )}
    </div>
  )
}
