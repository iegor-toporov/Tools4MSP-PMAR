import { useState } from 'react'
import {
  Paper, Tabs, Box, Button, Group, Stack, Text, TextInput,
  SimpleGrid, ScrollArea, ActionIcon,
} from '@mantine/core'
import { IconX } from '@tabler/icons-react'
import { MODELS, defaultStartTime } from '../constants'
import { useLang } from '../LanguageContext'
import ModelCard from './ModelCard'
import PmarPanel from './PmarPanel'

const SCROLLBAR_STYLES = {
  scrollbar: {
    background: 'transparent',
    '&:hover': { background: 'transparent' },
    '&[data-orientation="vertical"]': { width: 5 },
  },
  thumb: {
    background: 'rgba(10,132,255,0.35)',
    borderRadius: 99,
    '&:hover': { background: 'rgba(10,132,255,0.60)' },
  },
}

const INPUT_LABEL = {
  label: {
    color: 'var(--mantine-color-dimmed)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
}

function formatSeedShape(s) {
  if (!s) return null
  if (s.type === 'circle') {
    const km = (s.radius / 1000).toFixed(1)
    return `${s.lon.toFixed(3)}°E  ${s.lat.toFixed(3)}°N · r = ${km} km`
  }
  return `${s.lon_min.toFixed(2)}°–${s.lon_max.toFixed(2)}°E · ${s.lat_min.toFixed(2)}°–${s.lat_max.toFixed(2)}°N`
}

export default function Panel({
  onRun, onRunPmar,
  loading, onStopOpenDrift, openDriftStopping, status, statusType,
  pmarLoading, onStopPmar, pmarStopping, pmarStatus, pmarStatusType,
  drawMode, onStartDraw, onClearSeedShape, seedShape,
  activeTool, onToolChange,
  useSource, onUseSourceChange,
  windfarmsLoading, windfarmsEmpty,
  offshoreLoading, offshoreEmpty,
  natura2000Loading, natura2000Empty, natura2000Geojson,
  showNatura2000, onFetchNatura2000, onToggleNatura2000,
  hasSeedShape,
}) {
  const { t } = useLang()
  const [selectedModel, setSelectedModel] = useState('OceanDrift')
  const [startTime, setStartTime]         = useState(defaultStartTime())
  const [number,    setNumber]            = useState('100')
  const [duration,  setDuration]          = useState('24')

  function handleSubmit(e) {
    e.preventDefault()
    onRun({
      model:          selectedModel,
      start_time:     startTime ? startTime + ':00' : undefined,
      number:         parseInt(number),
      duration_hours: parseFloat(duration),
    })
  }

  const seedInfo = formatSeedShape(seedShape)
  const p        = t.panel

  return (
    <Paper
      shadow="xl"
      radius="lg"
      p={0}
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        zIndex: 1000,
        width: 310,
        maxHeight: 'calc(100vh - 32px)',
        overflow: 'hidden',
        background: 'var(--panel-bg)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: '1px solid var(--panel-border)',
      }}
    >
      <Tabs value="pmar">

        {/* ── OpenDrift tab ─────────────────────────────────────────── */}
        <Tabs.Panel value="opendrift">
          <ScrollArea
            h="calc(100vh - 80px)"
            scrollbarSize={5}
            type="hover"
            styles={SCROLLBAR_STYLES}
          >
            <div style={{ pointerEvents: openDriftStopping ? 'none' : 'auto', opacity: openDriftStopping ? 0.5 : 1, transition: 'opacity 0.2s' }}>
            <Stack gap="sm" p="md">
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                {p.sectionModel}
              </Text>
              <SimpleGrid cols={2} spacing="xs">
                {MODELS.map(m => (
                  <ModelCard
                    key={m.key}
                    model={{ ...m, name: t.models[m.key].name, desc: t.models[m.key].desc }}
                    active={selectedModel === m.key}
                    onClick={() => setSelectedModel(m.key)}
                  />
                ))}
              </SimpleGrid>

              <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                {p.sectionSeed}
              </Text>
              <Group grow gap="xs">
                <Button
                  size="xs"
                  variant={drawMode === 'circle' ? 'filled' : 'light'}
                  color="blue"
                  onClick={() => onStartDraw('circle')}
                >
                  {p.btnCircle}
                </Button>
                <Button
                  size="xs"
                  variant={drawMode === 'rectangle' ? 'filled' : 'light'}
                  color="blue"
                  onClick={() => onStartDraw('rectangle')}
                >
                  {p.btnRect}
                </Button>
              </Group>

              {drawMode === 'circle' && (
                <Text size="xs" c="dimmed" ta="center">{p.hintCircle}</Text>
              )}
              {drawMode === 'rectangle' && (
                <Text size="xs" c="dimmed" ta="center">{p.hintRect}</Text>
              )}
              {!drawMode && seedInfo && (
                <Group
                  gap={4}
                  align="center"
                  px="xs"
                  py={6}
                  style={{ background: 'rgba(10,132,255,0.08)', borderRadius: 6, border: '1px solid rgba(10,132,255,0.20)' }}
                >
                  <Text size="xs" c="blue.4" style={{ flex: 1, textAlign: 'center' }}>
                    {seedInfo}
                  </Text>
                  <ActionIcon
                    size={16}
                    variant="subtle"
                    color="blue"
                    onClick={onClearSeedShape}
                    style={{ flexShrink: 0, opacity: 0.7 }}
                  >
                    <IconX size={10} />
                  </ActionIcon>
                </Group>
              )}
              {!drawMode && !seedShape && (
                <Text size="xs" c="dimmed" ta="center">{p.hintNoShape}</Text>
              )}

              <form onSubmit={handleSubmit}>
                <Stack gap="xs">
                  <TextInput
                    type="datetime-local"
                    label={p.labelStart}
                    size="xs"
                    value={startTime}
                    onChange={e => setStartTime(e.target.value)}
                    styles={INPUT_LABEL}
                  />
                  <TextInput
                    type="number"
                    label={p.labelParticles}
                    size="xs"
                    value={number}
                    min="1"
                    max="10000"
                    onChange={e => setNumber(e.target.value)}
                    styles={INPUT_LABEL}
                  />
                  <TextInput
                    type="number"
                    label={p.labelDuration}
                    size="xs"
                    value={duration}
                    min="1"
                    max="720"
                    onChange={e => setDuration(e.target.value)}
                    styles={INPUT_LABEL}
                  />
                  {loading ? (
                    <Group grow gap="xs">
                      <Button size="sm" color="blue" disabled>
                        {openDriftStopping ? p.btnStopping : p.btnRunning}
                      </Button>
                      <Button size="sm" color="red" variant="outline" type="button"
                        loading={openDriftStopping}
                        disabled={openDriftStopping}
                        onClick={onStopOpenDrift}
                      >
                        {openDriftStopping ? p.btnStopping : p.btnStop}
                      </Button>
                    </Group>
                  ) : (
                    <Button fullWidth size="sm" type="submit" color="blue" disabled={!seedShape}>
                      {p.btnRun}
                    </Button>
                  )}
                </Stack>
              </form>

              {status && (
                <Text
                  size="xs"
                  ta="center"
                  c={statusType === 'error' ? 'red.4' : statusType === 'ok' ? 'green.4' : 'dimmed'}
                  style={{ lineHeight: 1.4 }}
                >
                  {status}
                </Text>
              )}
            </Stack>
            </div>
          </ScrollArea>
        </Tabs.Panel>

        {/* ── PMAR tab ──────────────────────────────────────────────── */}
        <Tabs.Panel value="pmar">
          <Box
            px="md"
            py="sm"
            style={{ borderBottom: '1px solid var(--modal-divider)', flexShrink: 0 }}
          >
            <Text fw={700} size="md">PMAR</Text>
            <Text size="xs" c="dimmed">Marine pressure assessment tool</Text>
          </Box>
          <ScrollArea
            h="calc(100vh - 130px)"
            scrollbarSize={5}
            type="hover"
            styles={SCROLLBAR_STYLES}
          >
            <PmarPanel
              onRun={onRunPmar}
              loading={pmarLoading}
              onStop={onStopPmar}
              stopping={pmarStopping}
              status={pmarStatus}
              statusType={pmarStatusType}
              drawMode={drawMode}
              onStartDraw={onStartDraw}
              onClearSeedShape={onClearSeedShape}
              seedShape={seedShape}
              useSource={useSource}
              onUseSourceChange={onUseSourceChange}
              windfarmsLoading={windfarmsLoading}
              windfarmsEmpty={windfarmsEmpty}
              offshoreLoading={offshoreLoading}
              offshoreEmpty={offshoreEmpty}
              natura2000Loading={natura2000Loading}
              natura2000Empty={natura2000Empty}
              natura2000Geojson={natura2000Geojson}
              showNatura2000={showNatura2000}
              onFetchNatura2000={onFetchNatura2000}
              onToggleNatura2000={onToggleNatura2000}
              hasSeedShape={hasSeedShape}
            />
          </ScrollArea>
        </Tabs.Panel>
      </Tabs>
    </Paper>
  )
}
