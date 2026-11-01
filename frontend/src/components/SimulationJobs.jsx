import { Paper, Stack, Group, Text, Button, Progress } from '@mantine/core'
import { Status, errorText, isActive, minutesSince, statusText } from '../scenarios/lifecycle'

/**
 * Simulations queued, running and failed, with Stop and Remove.
 *
 * The state comes from `scenario_status` (the server), not from this page: after a
 * reload or on another device the box is the same. Stop and Remove need full access:
 * without it, the buttons do not appear.
 *
 * @param {[string, object][]} entries   custom scenarios, already with `status`
 * @param {boolean} canManage            full access (Stop, Remove)
 * @param {Set<string>} busyIds          scenarios being stopped or removed
 */
export default function SimulationJobs({ entries, lang, p, canManage, busyIds, onStop, onRemove }) {
  const shown = entries.filter(([, sc]) => isActive(sc.status) || sc.status === Status.FAILED)
  if (!shown.length) return null

  // Running first, then queued in the order in which they will start, then failed.
  const rank = sc => sc.status === Status.RUNNING ? 0 : sc.status === Status.QUEUED ? 1 : 2
  shown.sort(([, a], [, b]) => rank(a) - rank(b) || (a.queue_position ?? 0) - (b.queue_position ?? 0))

  return (
    <Paper p="xs" radius="sm" style={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-divider)' }}>
      <Stack gap={8}>
        <Text size="10px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
          {p.sectionJobs}
        </Text>
        {shown.map(([sid, sc]) => {
          const label   = lang === 'it' ? sc.label_it : sc.label_en
          const busy    = busyIds.has(sid)
          const running = sc.status === Status.RUNNING
          const failed  = sc.status === Status.FAILED
          const minutes = running ? minutesSince(sc.started_at) : null
          const total   = sc.progress?.total ?? 1
          const done    = sc.progress?.done ?? 0
          return (
            <Stack key={sid} gap={3} data-testid={`sim-job-${sid}`}>
              <Group justify="space-between" gap={6} wrap="nowrap">
                <Text size="xs" fw={500} truncate style={{ minWidth: 0 }} title={label}>
                  {label}
                </Text>
                {canManage && (failed || sc.job_id) && (
                  <Button size="compact-xs" variant="subtle" color={failed ? 'gray' : 'red'} type="button"
                          loading={busy} disabled={busy}
                          onClick={() => (failed ? onRemove(sid) : onStop(sid, sc.job_id))}>
                    {failed ? p.btnRemove : p.btnStop}
                  </Button>
                )}
              </Group>
              {/* No icons: text and colour give the state: running in blue (with the bar),
                  queued in grey, failed in red. */}
              <Text size="10px" c={failed ? 'red.5' : running ? 'blue.5' : 'dimmed'} fw={running ? 600 : 400}>
                {statusText(sc, p)}
                {failed && `: ${errorText(sc.error, p.errors)}`}
                {minutes != null && ` · ${p.startedAgo.replace('{min}', minutes)}`}
              </Text>
              {running && total > 1 && (
                <Progress size="xs" value={(done / total) * 100} animated />
              )}
              {running && total <= 1 && <Progress size="xs" value={100} animated striped />}
            </Stack>
          )
        })}
      </Stack>
    </Paper>
  )
}
