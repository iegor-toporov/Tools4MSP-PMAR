import { Group, Stack, Text, TextInput, Button, ActionIcon, Tooltip } from '@mantine/core'
import { IconSquare, IconX } from '@tabler/icons-react'
import { LABEL_STYLES } from '../ui'

/** Riquadro [lon_min, lat_min, lon_max, lat_max] di un rettangolo disegnato, o null. */
export function bboxOf(shape) {
  if (shape?.type !== 'rectangle') return null
  const r = v => Math.round(v * 1e4) / 1e4
  return [r(shape.lon_min), r(shape.lat_min), r(shape.lon_max), r(shape.lat_max)]
}

export const formatBbox = b => `[${b.map(v => `${+v.toFixed(2)}°`).join(', ')}]`

/**
 * Griglia regolare: risoluzione in gradi e riquadro da disegnare sulla mappa (viola).
 * Senza riquadro vale quello dell'area di semina della simulazione.
 */
export default function BboxPicker({ t, res, onResChange, resMin, resMax, shape, defaultBbox,
                                      drawing, onDraw, onClear, disabled }) {
  const c = t.analysis.grid
  const drawn = bboxOf(shape)
  return (
    <Stack gap={4}>
      <Group gap={6} align="flex-end" wrap="nowrap">
        <TextInput
          type="number" size="xs" style={{ flex: 1 }}
          label={c.resolution} value={res} min={resMin} max={resMax} step="0.01" placeholder="0.1"
          disabled={disabled}
          onChange={e => onResChange(e.target.value)} styles={LABEL_STYLES}
        />
        <Button size="xs" variant={drawing ? 'filled' : 'light'} color="violet" type="button"
                leftSection={<IconSquare size={13} />} onClick={onDraw} disabled={disabled}>
          {c.drawBbox}
        </Button>
      </Group>
      {drawing ? (
        <Text size="10px" c="dimmed">{t.pmar.hintRect}</Text>
      ) : drawn ? (
        <Group gap={4} wrap="nowrap">
          <Text size="10px" c="violet.5" style={{ flex: 1 }}>{formatBbox(drawn)}</Text>
          {!disabled && (
            <Tooltip label={c.clearBbox} withArrow>
              <ActionIcon size={16} variant="subtle" color="gray" aria-label={c.clearBbox} onClick={onClear}>
                <IconX size={11} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ) : (
        <Text size="10px" c="dimmed">
          {defaultBbox ? c.bboxDefault.replace('{b}', formatBbox(defaultBbox)) : c.bboxDefaultPlain}
        </Text>
      )}
    </Stack>
  )
}
