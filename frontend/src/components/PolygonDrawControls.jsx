import { Button, Group, Stack, Text } from '@mantine/core'
import { polygonCounts, formatPolygonCounts } from '../geometry/seedShape'

/**
 * Controls shown while polygons are drawn: a hint, the count of polygons already
 * closed and the two ways out (remove the last one, or finish).
 *
 * It is a component of its own because the two panels, PMAR and OpenDrift, need it
 * identical.
 *
 * @param {object}   props.seedShape current release area, or null
 * @param {object}   props.labels    i18n section with hintPolygon / seedPolygons /
 *                                   btnUndoPolygon / btnFinishDraw
 * @param {Function} props.onUndo    removes the last closed polygon
 * @param {Function} props.onFinish  leaves drawing mode
 */
export default function PolygonDrawControls({ seedShape, labels, onUndo, onFinish }) {
  const { n } = polygonCounts(seedShape)

  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed" ta="center">{labels.hintPolygon}</Text>

      {n > 0 && (
        <>
          <Text size="xs" c="blue.4" ta="center">
            {formatPolygonCounts(seedShape, {
              polygons:    labels.seedPolygons,
              polygonsOne: labels.seedPolygonOne,
            })}
          </Text>
          <Group grow gap="xs">
            <Button size="xs" variant="light" color="gray" onClick={onUndo}>
              {labels.btnUndoPolygon}
            </Button>
            <Button size="xs" variant="filled" color="blue" onClick={onFinish}>
              {labels.btnFinishDraw}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  )
}
