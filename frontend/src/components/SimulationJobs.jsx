import { Paper, Stack, Group, Text, Button, Progress } from '@mantine/core'
import { Status, STATUS_ICON, errorText, isActive, minutesSince, statusText } from '../scenarios/lifecycle'

/**
 * Simulazioni in coda, in calcolo e fallite, con Stop e Rimuovi.
 *
 * Lo stato viene da `scenario_status` (il server), non da questa pagina: dopo una
 * ricarica o da un altro dispositivo il riquadro è lo stesso. Stop e Rimuovi
 * richiedono l'accesso pieno: senza, i bottoni non compaiono.
 *
 * @param {[string, object][]} entries   scenari custom, già con `status`
 * @param {boolean} canManage            accesso pieno (Stop, Rimuovi)
 * @param {Set<string>} busyIds          scenari di cui è in corso Stop o rimozione
 */
export default function SimulationJobs({ entries, lang, p, canManage, busyIds, onStop, onRemove }) {
  const shown = entries.filter(([, sc]) => isActive(sc.status) || sc.status === Status.FAILED)
  if (!shown.length) return null

  // In calcolo prima, poi in coda nell'ordine in cui partiranno, poi le fallite.
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
                  {STATUS_ICON[sc.status]} {label}
                </Text>
                {canManage && (failed || sc.job_id) && (
                  <Button size="compact-xs" variant="subtle" color={failed ? 'gray' : 'red'} type="button"
                          loading={busy} disabled={busy}
                          onClick={() => (failed ? onRemove(sid) : onStop(sid, sc.job_id))}>
                    {failed ? p.btnRemove : p.btnStop}
                  </Button>
                )}
              </Group>
              <Text size="10px" c={failed ? 'red.5' : 'dimmed'}>
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
