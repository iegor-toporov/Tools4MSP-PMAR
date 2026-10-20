import { Button, Badge, Text, SimpleGrid, Group, Paper } from '@mantine/core'
import {
  IconChartBar, IconChartAreaLine, IconWaveSine, IconBolt, IconFileTypeCsv, IconStack2, IconX,
} from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

/**
 * Riquadro "Analysis tools" in basso a destra, sotto il pannello Layers. Gli
 * strumenti lavorano sulla heatmap del layer attivo (PMAR, o Markov sul frame
 * mostrato): senza un raster restano disattivati. La matrice di connettività ha il
 * suo bottone nella scheda del layer.
 */
const TOOLS = [
  { key: 'histogram',  Icon: IconChartBar,      labelKey: 'histogramBtn'  },
  { key: 'stats',      Icon: IconChartAreaLine, labelKey: 'statsBtn'      },
  { key: 'profile',    Icon: IconWaveSine,      labelKey: 'profileBtn'    },
  { key: 'threshold',  Icon: IconBolt,          labelKey: 'thresholdBtn'  },
  { key: 'csv',        Icon: IconFileTypeCsv,   labelKey: 'csvBtn'        },
  { key: 'comparison', Icon: IconStack2,        labelKey: 'comparisonBtn' },
]

const COUNT_BADGE = {
  position: 'absolute', top: -4, right: -4, fontSize: 8, minWidth: 14, height: 14,
  padding: 0, pointerEvents: 'none', zIndex: 1,
}

export default function ToolsPanel({
  activeMapTool, onSetTool, hasRaster, windowCounts = {}, openWindowCount = 0, onCloseAll,
}) {
  const { t } = useLang()
  const c = t.toolsPanel

  return (
    <Paper shadow="xl" radius="lg" className="tools-panel">
      <Group justify="space-between" align="center" mb={2}>
        <Text fw={700} size="md">{c.title}</Text>
        {openWindowCount > 0 && (
          <Button size="compact-xs" variant="subtle" color="red" type="button"
                  leftSection={<IconX size={12} />} onClick={onCloseAll}>
            {c.closeAllBtn} ({openWindowCount})
          </Button>
        )}
      </Group>
      <Text size="10px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
        {c.groupPmar}
      </Text>
      {!hasRaster && <Text size="10px" c="dimmed" lh={1.3}>{c.hintPmar}</Text>}
      <SimpleGrid cols={3} spacing={6} verticalSpacing={6} mt={4}>
        {TOOLS.map(({ key, Icon, labelKey }) => {
          const count = windowCounts[key] ?? 0
          return (
            <div key={key} style={{ position: 'relative' }}>
              <Button
                fullWidth
                size="xs"
                radius="md"
                px={4}
                variant={activeMapTool === key ? 'filled' : 'light'}
                color="blue"
                disabled={!hasRaster}
                leftSection={<Icon size={13} />}
                styles={{ section: { marginInlineEnd: 4 } }}
                onClick={hasRaster ? () => onSetTool(key) : undefined}
              >
                {c[labelKey]}
              </Button>
              {count > 0 && <Badge size="xs" color="red" circle style={COUNT_BADGE}>{count}</Badge>}
            </div>
          )
        })}
      </SimpleGrid>
    </Paper>
  )
}
