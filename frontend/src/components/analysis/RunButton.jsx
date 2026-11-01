import { Button, Group, Stack, Text } from '@mantine/core'

/**
 * "Run analysis" at the bottom of a section: while running it becomes "…" + Stop.
 * `hint` explains why the button is disabled (e.g. the shapefile is missing).
 */
export default function RunButton({ labels, loading, stopping, onStop, disabled, onRun, hint, limitNote }) {
  return (
    <Stack gap={6} mt={4}>
      {loading ? (
        <Group grow gap="xs">
          <Button size="sm" color="blue" disabled type="button">
            {stopping ? labels.stopping : labels.running}
          </Button>
          <Button size="sm" color="red" variant="outline" type="button"
                  loading={stopping} disabled={stopping} onClick={onStop}>
            {stopping ? labels.stopping : labels.stop}
          </Button>
        </Group>
      ) : (
        <Button size="sm" color="blue" fullWidth type="button" disabled={disabled} onClick={onRun}>
          {labels.run}
        </Button>
      )}
      {!loading && disabled && hint && <Text size="xs" c="dimmed" ta="center">{hint}</Text>}
      {limitNote}
    </Stack>
  )
}
