import { useEffect, useRef } from 'react'
import { Button, Badge, Text } from '@mantine/core'
import {
  IconChartBar, IconChartAreaLine, IconWaveSine, IconBolt, IconFileTypeCsv, IconStack2,
  IconTable, IconX, IconTool, IconChevronDown, IconChevronUp,
} from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

/**
 * Strumenti divisi per il risultato su cui lavorano: quelli della heatmap PMAR non
 * servono a niente senza un raster PPI, la matrice senza una connettività. Un unico
 * gate su `hasRaster` disabiliterebbe la matrice in una sessione di sola connettività.
 */
const GROUPS = [
  {
    key: 'pmar', titleKey: 'groupPmar', hintKey: 'hintPmar', needs: 'raster',
    tools: [
      { key: 'histogram',  Icon: IconChartBar,      labelKey: 'histogramBtn'  },
      { key: 'stats',      Icon: IconChartAreaLine, labelKey: 'statsBtn'      },
      { key: 'profile',    Icon: IconWaveSine,      labelKey: 'profileBtn'    },
      { key: 'threshold',  Icon: IconBolt,          labelKey: 'thresholdBtn'  },
      { key: 'csv',        Icon: IconFileTypeCsv,   labelKey: 'csvBtn'        },
      { key: 'comparison', Icon: IconStack2,        labelKey: 'comparisonBtn' },
    ],
  },
  {
    key: 'connectivity', titleKey: 'groupConnectivity', hintKey: 'hintConnectivity', needs: 'connectivity',
    tools: [
      { key: 'connectivity', Icon: IconTable, labelKey: 'connectivityTitle' },
    ],
  },
]

export const TOOLS_WIDTH = 216

const COUNT_BADGE = {
  position: 'absolute', top: -4, right: -4, fontSize: 8, minWidth: 14, height: 14,
  padding: 0, pointerEvents: 'none', zIndex: 1,
}

export default function ToolsPanel({
  activeMapTool,
  onSetTool,
  hasRaster,
  hasConnectivity = false,
  windowCounts = {},
  openWindowCount = 0,
  onCloseAll,
  expanded,
  onToggleExpanded,
  onBottomChange,
}) {
  const { t } = useLang()
  const c = t.toolsPanel

  // Dove finisce il pannello: la legenda, sotto, si ferma lì. Cambia aprendo e
  // chiudendo il pannello e con i suggerimenti dei gruppi.
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !onBottomChange) return
    const report = () => onBottomChange(el.getBoundingClientRect().bottom)
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [onBottomChange])

  return (
    <div ref={ref} className="tools-panel" style={{ width: TOOLS_WIDTH }}>
      <button
        type="button"
        className="tools-panel-head"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
      >
        <IconTool size={15} />
        <span className="tools-panel-title">{c.title}</span>
        {openWindowCount > 0 && (
          <Badge size="xs" color="red" circle style={{ fontSize: 8, minWidth: 16, height: 16, padding: 0 }}>
            {openWindowCount}
          </Badge>
        )}
        {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
      </button>

      {expanded && (
        <div className="tools-panel-body">
          {GROUPS.map(group => {
            const enabled = group.needs === 'connectivity' ? hasConnectivity : hasRaster
            return (
              <section key={group.key} className="tools-panel-group">
                <Text size="10px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                  {c[group.titleKey]}
                </Text>
                {!enabled && <Text size="10px" c="dimmed" lh={1.3}>{c[group.hintKey]}</Text>}
                {group.tools.map(({ key, Icon, labelKey }) => {
                  const isActive = activeMapTool === key
                  const count    = windowCounts[key] ?? 0
                  return (
                    <div key={key} style={{ position: 'relative' }}>
                      <Button
                        fullWidth
                        size="xs"
                        radius="md"
                        variant={isActive ? 'filled' : 'light'}
                        color="blue"
                        disabled={!enabled}
                        justify="flex-start"
                        leftSection={<Icon size={14} />}
                        onClick={enabled ? () => onSetTool(key) : undefined}
                      >
                        {c[labelKey]}
                      </Button>
                      {count > 0 && (
                        <Badge size="xs" color="red" circle style={COUNT_BADGE}>{count}</Badge>
                      )}
                    </div>
                  )
                })}
              </section>
            )
          })}

          {openWindowCount > 0 && (
            <Button
              fullWidth
              size="xs"
              radius="md"
              variant="subtle"
              color="red"
              justify="flex-start"
              leftSection={<IconX size={14} />}
              onClick={onCloseAll}
            >
              {c.closeAllBtn}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
