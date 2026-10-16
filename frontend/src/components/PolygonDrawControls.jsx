import { Button, Group, Stack, Text } from '@mantine/core'
import { polygonCounts, formatPolygonCounts } from '../geometry/seedShape'

/**
 * Controlli mostrati mentre si disegnano poligoni: suggerimento, conteggio di
 * quelli già chiusi e le due uscite (togli l'ultimo, oppure concludi).
 *
 * Vive in un componente suo perché serve identico ai due pannelli, PMAR e
 * OpenDrift.
 *
 * @param {object}   props.seedShape area di seeding corrente, o null
 * @param {object}   props.labels    sezione i18n con hintPolygon / seedPolygons /
 *                                   btnUndoPolygon / btnFinishDraw
 * @param {Function} props.onUndo    rimuove l'ultimo poligono chiuso
 * @param {Function} props.onFinish  esce dalla modalità disegno
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
