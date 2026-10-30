import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, Group, Stack, Text, TextInput, Textarea, PasswordInput,
  SegmentedControl, NativeSelect, Paper, ScrollArea, Switch, Collapse, ActionIcon,
  Accordion, UnstyledButton,
} from '@mantine/core'
import { IconX, IconChevronDown, IconCircleCheck, IconLock, IconLockOpen } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useLang } from '../LanguageContext'
import { Process, ACCESS_DENIED, executeSync, executeAsync,
         dismissJob, setAccessToken } from '../api/ogcProcesses'
import { formatSeedShape, geometryPolygonCount, seedShapePolygonCount,
         seedShapeToGeoJSON } from '../geometry/seedShape'
import { CHEMICAL_COMPOUNDS } from '../constants'
import { forcingLabel } from '../scenarios/forcing'
import { MAX_RELEASES, MIN_RELEASES, formatDay, releaseSchedule } from '../scenarios/releases'
import PolygonDrawControls from './PolygonDrawControls'
import SimulationJobs from './SimulationJobs'
import { LABEL_STYLES, InfoTip, SectionLabel, SummaryRows, lbl } from './ui'
import SourcePicker from './analysis/SourcePicker'
import DispersalSection from './analysis/DispersalSection'
import ConnectivitySection from './analysis/ConnectivitySection'
import PropagateSection from './analysis/PropagateSection'
import { formatBbox } from './analysis/BboxPicker'
import { POLL_INTERVAL_MS, anyActive, errorText, isActive, statusOf, statusText,
         transitions } from '../scenarios/lifecycle'

// Tipi di tracciante nell'ordine del mockup (chiavi di PRESSURE_MODELS nel backend).
const PRESSURES = ['generic', 'plastic', 'oil', 'chemical', 'larvae']

const TIME_STEPS = [
  { value: '1',  label: '1 h'  },
  { value: '3',  label: '3 h'  },
  { value: '6',  label: '6 h'  },
  { value: '12', label: '12 h' },
  { value: '24', label: '24 h' },
]

// Byte per particella e passo del file NetCDF temporaneo, per tipo di tracciante.
const NC_BYTES_PER_STEP = { generic: 40, plastic: 60, oil: 160, chemical: 120, larvae: 120 }

// Limite di particelle per scenario del backend (PrecomputeProcess).
const MAX_PARTICLES = 100000
// Particelle per poligono: il backend porta i valori fuori da [1, 20000] dentro l'intervallo.
const MAX_PER_POLYGON = 20000

function defaultStartDate() {
  const d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatNcSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
  return (bytes / 1e3).toFixed(0) + ' KB'
}

// Il token della modalità demo vive in sessionStorage: sopravvive a un ricarica,
// sparisce chiudendo la scheda — quel che serve su un portatile da stand.
const TOKEN_KEY = 'pmar.accessToken'

function readStoredToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}

function storeToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch { /* storage non disponibile: si resta sbloccati solo fino al ricarica */ }
}

/** Sostituisce il form di nuova simulazione quando la demo è bloccata. */
function SimulationLock({ a, value, onChange, onUnlock, pending, error }) {
  return (
    <Stack gap="xs" style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 8 }}>
      <Group gap={6}>
        <IconLock size={14} style={{ color: 'var(--mantine-color-blue-4)' }} />
        <Text size="xs" fw={700} c="blue.4" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
          {a.title}
        </Text>
      </Group>
      <Text size="xs" c="dimmed">{a.body}</Text>
      <PasswordInput
        size="xs"
        placeholder={a.placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        error={error ? a.wrongToken : null}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onUnlock() } }}
      />
      <Button size="xs" type="button" onClick={onUnlock} loading={pending} disabled={!value.trim()}>
        {a.unlock}
      </Button>
    </Stack>
  )
}

const BOX_STYLE = { background: 'var(--modal-bg)', border: '1px solid var(--modal-divider)' }
const CELL = { padding: '2px 6px', textAlign: 'right' }
const HEAD = { ...CELL, fontWeight: 600, color: 'var(--mantine-color-dimmed)',
               borderBottom: '1px solid var(--modal-divider)' }

/**
 * Multi seeding in un riquadro: l'interruttore, le due impostazioni e il
 * calendario dei rilasci che ne risulta, con le date vere di inizio e fine.
 */
function MultiSeedingBox({ p, locale, enabled, onToggle, releases, onReleases,
                           shift, onShift, startDate, duration }) {
  const schedule = enabled ? releaseSchedule(startDate, duration, releases, shift) : []
  const fmt = d => formatDay(d, locale)
  const days = schedule.length ? Math.round((schedule[0].end - schedule[0].start) / 86400000) : 0
  return (
    <Paper p="xs" radius="sm" style={BOX_STYLE}>
      <Stack gap="xs">
        <Switch
          size="xs"
          label={lbl(p.multiSeedingToggle, p.tooltips.multiSeeding)}
          checked={enabled}
          onChange={e => onToggle(e.currentTarget.checked)}
        />
        {enabled && (
          <>
            <Group grow gap="xs" align="flex-start">
              <TextInput type="number" size="xs" label={lbl(p.seedingsLabel, p.tooltips.seedingsCount)}
                         value={releases} min={MIN_RELEASES} max={MAX_RELEASES}
                         onChange={e => onReleases(e.target.value)} styles={LABEL_STYLES} />
              <TextInput type="number" size="xs" label={lbl(p.tshiftLabel, p.tooltips.tshift)}
                         value={shift} min="1" max="365"
                         onChange={e => onShift(e.target.value)} styles={LABEL_STYLES} />
            </Group>
            {schedule.length > 0 && (
              <>
                <ScrollArea.Autosize mah={170} type="auto">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11,
                                  fontVariantNumeric: 'tabular-nums' }}>
                    <thead>
                      <tr>
                        <th style={{ ...HEAD, textAlign: 'left' }}>{p.releaseCol}</th>
                        <th style={HEAD}>{p.releaseStart}</th>
                        <th style={HEAD}>{p.releaseEnd}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedule.map(r => (
                        <tr key={r.n}>
                          <td style={{ ...CELL, textAlign: 'left' }}>{r.n}</td>
                          <td style={CELL}>{fmt(r.start)}</td>
                          <td style={CELL}>{fmt(r.end)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea.Autosize>
                <Text size="10px" c="dimmed">
                  {p.releasesSummary
                    .replace('{n}', schedule.length)
                    .replace('{d}', days)
                    .replace('{from}', fmt(schedule[0].start))
                    .replace('{to}', fmt(schedule[schedule.length - 1].end))}
                </Text>
              </>
            )}
          </>
        )}
      </Stack>
    </Paper>
  )
}

/** Riquadro grigio coi dati di una simulazione. */
function ScenarioCard({ rows, description }) {
  return (
    <Paper p="xs" radius="sm" style={BOX_STYLE}>
      <Stack gap={4}>
        <SummaryRows rows={rows} />
        {description && (
          <Text size="xs" c="dimmed" mt={4} style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 4, lineHeight: 1.5 }}>
            {description}
          </Text>
        )}
      </Stack>
    </Paper>
  )
}

/** Testata di una sezione dell'Analisi: titolo che apre/chiude e (i) accanto. */
function SectionControl({ title, tip }) {
  return (
    <Group wrap="nowrap" gap={0} pr={6}>
      <Accordion.Control style={{ flex: 1 }}>
        <Text size="sm" fw={600}>{title}</Text>
      </Accordion.Control>
      <InfoTip text={tip} label={title} size={15} />
    </Group>
  )
}

export default function PmarPanel({
  onRun, loading, onStop, stopping,
  drawMode, onStartDraw, onFinishDraw, onUndoLastPolygon, onClearSeedShape, seedShape,
  useSource, onUseSourceChange,
  windfarmsLoading, windfarmsEmpty,
  offshoreLoading, offshoreEmpty,
  mspZonesLoading, mspZonesEmpty,
  onT4mspPreview, onScenarioArea, onAnalysisMarginChange,
  onRunConnectivity, connectivityLoading, connectivityStopping, onStopConnectivity,
  markov = {}, draw, matrices = [], runMode = 'custom',
  actionsTarget, analysesFull = false,
}) {
  const { t, lang } = useLang()
  const p = t.pmar
  const sim = t.simulation

  const [showAdvanced,  setShowAdvanced]  = useState(false)

  const [seedAreaMode,      setSeedAreaMode]      = useState('draw')
  const [shapefileB64,      setShapefileB64]      = useState(null)
  const [shapefileName,     setShapefileName]     = useState('')
  const fileRef = useRef(null)
  const geoCache = useRef({})
  const scenarioGeoCache = useRef({})

  const [t4mspAreas,        setT4mspAreas]        = useState([])
  const [selectedT4mspArea, setSelectedT4mspArea] = useState(null)
  // Poligoni dell'area Tools4MSP scelta, dalla geometria della preview: servono al
  // totale della semina per poligono. null finché la geometria non è arrivata.
  const [t4mspPolygons,     setT4mspPolygons]     = useState(null)
  const [t4mspSearch,       setT4mspSearch]       = useState('')

  const [customLabel,   setCustomLabel]   = useState('')
  const [customDesc,    setCustomDesc]    = useState('')
  const [seedAreaName,  setSeedAreaName]  = useState('')
  const [cmemsMargin,   setCmemsMargin]   = useState('1')
  const [multiSeeding,  setMultiSeeding]  = useState(false)
  // Distribuzione delle particelle: 'even' (in proporzione all'area) o 'poly' (lo
  // stesso numero in ogni poligono, come serve alla connettività).
  const [distribution,   setDistribution]   = useState('even')
  const [pnumPerPolygon, setPnumPerPolygon] = useState('500')
  // Tracciante conservativo per Propagate: niente spiaggiamento.
  const [noBeaching,     setNoBeaching]     = useState(false)
  const [seedings,      setSeedings]      = useState('3')
  const [tshift,        setTshift]        = useState('30')
  const [pressure,      setPressure]      = useState('generic')
  const [compound,      setCompound]      = useState(CHEMICAL_COMPOUNDS[0])
  const [startDate,     setStartDate]     = useState(defaultStartDate())
  const [durationDays,  setDurationDays]  = useState('30')
  const [pnum,          setPnum]          = useState('1000')
  const [timeStepHours, setTimeStepHours] = useState('1')

  // Layer sorgente GeoTIFF dell'utente, per Dispersal (come `useSource`).
  const [geotiffB64,  setGeotiffB64]  = useState(null)
  const [geotiffName, setGeotiffName] = useState('')

  // Sezioni aperte dell'Analisi: all'avvio tutte chiuse, così si vedono tutte e tre.
  const [openSections, setOpenSections] = useState([])

  const [scenarioStatuses, setScenarioStatuses] = useState({})
  const [scenarioId,       setScenarioId]       = useState('')

  const [customPrecomputeError, setCustomPrecomputeError] = useState(null)
  const [refetchFlag,           setRefetchFlag]           = useState(0)
  // Scenari di cui è in corso uno Stop o una rimozione (bottone in attesa).
  const [busyScenarioIds,       setBusyScenarioIds]       = useState(() => new Set())
  // Lettura precedente dell'elenco, per notificare i cambi di stato (pronta, fallita).
  const prevStatusesRef  = useRef(null)
  // Job lanciati da questa pagina: quando finiscono, la simulazione si seleziona da sola.
  const submittedJobsRef = useRef(new Set())

  // Modalità demo: finché il backend non risponde si assume l'accesso pieno, che è
  // anche il comportamento senza token configurato.
  const [access, setAccess] = useState(() => {
    setAccessToken(readStoredToken())
    return { locked: false, unlocked: true }
  })
  const [tokenInput,    setTokenInput]    = useState('')
  const [unlockPending, setUnlockPending] = useState(false)
  const [unlockError,   setUnlockError]   = useState(false)
  const pendingTokenRef = useRef(null)
  const canSimulate = !access.locked || access.unlocked

  useEffect(() => {
    executeSync(Process.SCENARIO_STATUS, {})
      .then(data => {
        const resp    = (data.scenarios !== undefined) ? data : { scenarios: data, t4msp_areas: [] }
        const s = {}
        for (const [id, info] of Object.entries(resp.scenarios)) {
          s[id] = { ...info, status: statusOf(info) }
        }
        notifyTransitions(prevStatusesRef.current, s)
        prevStatusesRef.current = s
        setScenarioStatuses(s)
        // Stop o rimozione conclusi: lo scenario non c'è più, o non è più attivo.
        setBusyScenarioIds(ids => {
          const keep = [...ids].filter(id => s[id] && (isActive(s[id].status) || s[id].status === 'failed'))
          return keep.length === ids.size ? ids : new Set(keep)
        })
        // Bloccando, lo scenario selezionato può non essere più visibile.
        setScenarioId(id => (id && !s[id] ? '' : id))
        setT4mspAreas(resp.t4msp_areas ?? [])

        const acc   = resp.access ?? { locked: false, unlocked: true }
        const tried = pendingTokenRef.current
        pendingTokenRef.current = null
        if (acc.locked && !acc.unlocked) {
          // Token rifiutato (sbagliato, o cambiato sul server): si torna visitatori.
          setAccessToken(null)
          storeToken(null)
          if (tried) setUnlockError(true)
        } else if (tried) {
          storeToken(tried)
          setTokenInput('')
          setUnlockError(false)
        }
        setAccess(acc)
      })
      .catch(() => {})
      .finally(() => setUnlockPending(false))
  }, [runMode, refetchFlag]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleUnlock() {
    const token = tokenInput.trim()
    if (!token) return
    pendingTokenRef.current = token
    setAccessToken(token)
    setUnlockPending(true)
    setUnlockError(false)
    setRefetchFlag(f => f + 1)
  }

  function handleLock() {
    setAccessToken(null)
    storeToken(null)
    setRefetchFlag(f => f + 1)
  }

  // I processi sincroni arrivano col prefisso di pygeoapi ("Error executing process: …").
  const describePrecomputeError = msg => {
    const clean = msg?.replace(/^Error executing process:\s*/i, '')
    return clean === ACCESS_DENIED ? p.access.denied : clean
  }

  // Finché qualcosa è in coda o in calcolo l'elenco si rilegge da solo: stato,
  // avanzamento e notifiche vengono dal server, quindi sopravvivono a una ricarica.
  const hasActive = anyActive(scenarioStatuses)
  useEffect(() => {
    if (!hasActive) return
    const iv = setInterval(() => setRefetchFlag(f => f + 1), POLL_INTERVAL_MS)
    return () => clearInterval(iv)
  }, [hasActive])

  function notifyTransitions(prev, next) {
    for (const { id, to } of transitions(prev, next)) {
      const sc    = next[id] ?? prev[id]
      const label = (lang === 'it' ? sc.label_it : sc.label_en) ?? ''
      if (to === 'ready') {
        notifications.show({
          title:     p.simReadyTitle,
          message:   p.simReadyBody.replace('{label}', label),
          color:     'teal',
          icon:      <IconCircleCheck size={18} />,
          autoClose: 20000,
        })
        if (submittedJobsRef.current.has(prev[id]?.job_id)) setScenarioId(id)
      } else if (to === 'failed') {
        notifications.show({
          title:     p.simFailedTitle,
          message:   p.simFailedBody.replace('{label}', label).replace('{error}', errorText(sc.error, p.errors)),
          color:     'red',
          autoClose: false,
        })
      }
    }
  }

  const setBusy = (id, on) => setBusyScenarioIds(ids => {
    const next = new Set(ids)
    if (on) next.add(id); else next.delete(id)
    return next
  })

  async function handleStopSimulation(id, jobId) {
    setBusy(id, true)
    if (!(await dismissJob(jobId))) {
      setBusy(id, false)
      notifications.show({ message: p.stopError, color: 'red' })
    }
    setRefetchFlag(f => f + 1)
  }

  async function handleRemoveSimulation(id) {
    setBusy(id, true)
    try {
      await executeSync(Process.SCENARIO_STATUS, { remove_scenario: id })
    } catch (err) {
      setBusy(id, false)
      notifications.show({ message: describePrecomputeError(err.detail) || p.removeError, color: 'red' })
    }
    setRefetchFlag(f => f + 1)
  }

  useEffect(() => { onT4mspPreview?.(null) }, [runMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Area della simulazione scelta, evidenziata sulla mappa. La geometria si
  // chiede solo alla selezione: la mappa di stato viene ripolled, e leggere
  // tutti gli shapefile a ogni giro costerebbe troppo.
  useEffect(() => {
    let annullato = false
    if (!scenarioId) { onScenarioArea?.(null); return }

    const invia = geo => {
      if (annullato || !geo) return
      onScenarioArea?.({ type: 'FeatureCollection',
                         features: [{ type: 'Feature', geometry: geo, properties: {} }] },
                       scenarioId, scenarioStatuses[scenarioId] ?? null)
    }

    if (scenarioGeoCache.current[scenarioId]) {
      invia(scenarioGeoCache.current[scenarioId])
    } else {
      executeSync(Process.SCENARIO_STATUS, { scenario_id: scenarioId })
        .then(({ geo }) => { scenarioGeoCache.current[scenarioId] = geo; invia(geo) })
        .catch(() => {})
    }
    return () => { annullato = true }
  }, [scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Disegnare una nuova area e analizzarne una esistente sono due lavori
  // diversi: iniziare un disegno lascia la simulazione selezionata, così sulla
  // mappa resta evidenziata una sola area per volta.
  useEffect(() => {
    if (drawMode) setScenarioId('')
  }, [drawMode])

  async function handleCustomCompute() {
    setCustomPrecomputeError(null)
    const geojson = seedAreaMode === 'draw' ? seedShapeToGeoJSON(seedShape) : null

    const startIso = startDate + 'T00:00:00'
    const label    = customLabel.trim() || `${p.pressures[pressure]} — ${startDate}`
    const inputs   = {
      pressure,
      start_time:      startIso,
      duration_days:   parseInt(durationDays),
      pnum:            parseInt(pnum),
      time_step_hours: parseInt(timeStepHours),
      label,
      ...(geojson            ? { geojson: JSON.stringify(geojson) }  : {}),
      ...(shapefileB64 && seedAreaMode === 'upload' ? { shapefile_b64: shapefileB64 } : {}),
      ...(selectedT4mspArea && seedAreaMode === 't4msp' ? { t4msp_area_id: selectedT4mspArea } : {}),
      ...(seedAreaName.trim() ? { area_name: seedAreaName.trim() } : {}),
      ...(pressure === 'chemical' ? { chemical_compound: compound } : {}),
      cmems_margin: parseFloat(cmemsMargin) || 5.0,
      ...(customDesc.trim() ? { description: customDesc.trim() } : {}),
      ...(multiSeeding ? { seedings: parseInt(seedings) || 3, tshift: parseInt(tshift) || 30 } : {}),
      ...(usesPerPolygon ? { pnum_per_polygon: parseInt(pnumPerPolygon) || 500 } : {}),
      ...(noBeaching ? { beaching: false } : {}),
    }
    try {
      // Il backend registra subito lo scenario come `queued`: compare nell'elenco
      // alla prossima lettura, e da lì in poi lo stato lo dà il server.
      const jobId = await executeAsync(Process.PRECOMPUTE, inputs)
      submittedJobsRef.current.add(jobId)
      notifications.show({
        title:     p.simSubmittedTitle,
        message:   p.simSubmittedBody.replace('{label}', label),
        color:     'blue',
        autoClose: 8000,
      })
      setRefetchFlag(f => f + 1)
    } catch (err) {
      // Input non validi o accesso negato arrivano subito, come errore HTTP.
      setCustomPrecomputeError(err?.detail || p.computeStartError)
    }
  }

  function readFile(file, onDone) {
    const reader = new FileReader()
    reader.onload = ev => onDone(ev.target.result.split(',')[1])
    reader.readAsDataURL(file)
  }

  function handleFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    readFile(file, b64 => { setShapefileB64(b64); setShapefileName(file.name) })
  }

  const geotiff = {
    b64: geotiffB64, name: geotiffName,
    onFile: file => readFile(file, b64 => { setGeotiffB64(b64); setGeotiffName(file.name) }),
  }

  // ── Simulazione selezionata (Analisi) ─────────────────────────────────────
  const selected = scenarioStatuses[scenarioId]
  const sc = selected?.status === 'ready' ? selected : null
  const scenarioLabel = sc ? (lang === 'it' ? sc.label_it : sc.label_en) : ''

  /**
   * Dati per la scheda del layer nel pannello di destra: lo scenario usato e i
   * parametri. Si salvano i valori grezzi (anche le etichette in entrambe le lingue),
   * così la descrizione segue la lingua corrente anche dopo.
   */
  function scenarioInfo() {
    const s = scenarioStatuses[scenarioId] ?? {}
    return {
      id: scenarioId, label_it: s.label_it, label_en: s.label_en,
      area_it: s.area_it, area_en: s.area_en, pressure: s.pressure,
      chemical_compound: s.chemical_compound,
      start_time: s.start_time, duration_days: s.duration_days, pnum: s.pnum,
      seedings: s.seedings, tshift: s.tshift, time_step_hours: s.time_step_hours,
      beaching: s.beaching, bounds: s.bounds, cmems_margin: s.cmems_margin,
      forcing_datasets: s.forcing_datasets,
    }
  }

  const limitNote = analysesFull && (
    <Text size="xs" c="orange.6" ta="center">{t.analyses.limitReached}</Text>
  )

  const emodnetState = {
    windfarms:              { loading: windfarmsLoading, empty: windfarmsEmpty, emptyText: p.useWindfarmsEmpty },
    offshore_installations: { loading: offshoreLoading,  empty: offshoreEmpty,  emptyText: p.useOffshoreEmpty },
    msp_zones:              { loading: mspZonesLoading,  empty: mspZonesEmpty,  emptyText: p.useMspZonesEmpty },
  }
  const renderSourcePicker = ({ value, onPick }) => (
    <SourcePicker value={value} onPick={onPick} emodnet={emodnetState} geotiff={geotiff}
                  labels={t.analysis.sources} />
  )

  const ctx = { t, sc, scenarioId, scenarioLabel, scenarioInfo, ready: !!sc, limitNote, analysesFull, geotiff }
  const sectionActive = key => runMode === 'scenario' && openSections.includes(key)

  // ── Nuova simulazione ─────────────────────────────────────────────────────
  const seedInfo = seedAreaMode === 'draw'
    ? formatSeedShape(seedShape, { polygons: p.seedPolygons, polygonsOne: p.seedPolygonOne })
    : null

  // Distribuzione per poligono: vale per ogni modo di definire l'area e, quando è
  // attiva, è lei a determinare il numero di particelle (pnum viene ignorato).
  // Il totale si conosce prima dell'invio per le aree disegnate e per quelle
  // Tools4MSP; per uno shapefile lo calcola il backend, che rifiuta subito la
  // richiesta oltre il limite.
  const usesPerPolygon  = distribution === 'poly'
  const seedPolygons    = seedAreaMode === 'draw'  ? (seedShapePolygonCount(seedShape) || null)
                        : seedAreaMode === 't4msp' ? (selectedT4mspArea ? t4mspPolygons : null)
                        : null
  const perPolygon      = Math.max(1, Math.min(parseInt(pnumPerPolygon) || 0, MAX_PER_POLYGON))
  const perPolygonTotal = usesPerPolygon && seedPolygons ? perPolygon * seedPolygons : null
  const perPolygonTooMany = perPolygonTotal != null && perPolygonTotal > MAX_PARTICLES

  const canPrecompute = !perPolygonTooMany && (
    (seedAreaMode === 'draw'   && !!seedShape) ||
    (seedAreaMode === 'upload' && !!shapefileB64) ||
    (seedAreaMode === 't4msp'  && !!selectedT4mspArea)
  )

  const stepsPerDay     = 24 / parseInt(timeStepHours || 1)
  const ncSeedingsCount = multiSeeding ? (parseInt(seedings) || 1) : 1
  const ncParticles     = usesPerPolygon ? (perPolygonTotal ?? perPolygon) : parseInt(pnum || 0)
  const ncEstimateBytes = ncParticles * parseInt(durationDays || 0) * stepsPerDay * NC_BYTES_PER_STEP[pressure] * ncSeedingsCount
  const ncColor  = ncEstimateBytes > 2e9 ? 'red.4' : ncEstimateBytes > 5e8 ? 'yellow.4' : 'dimmed'
  const ncBg     = ncEstimateBytes > 2e9 ? 'rgba(239,68,68,0.07)' : ncEstimateBytes > 5e8 ? 'rgba(245,158,11,0.07)' : 'rgba(10,132,255,0.05)'
  const ncBorder = ncEstimateBytes > 2e9 ? '#ef4444' : ncEstimateBytes > 5e8 ? '#f59e0b' : 'rgba(10,132,255,0.30)'

  const customEntries = Object.entries(scenarioStatuses).filter(([, s]) => s.source === 'custom')

  const searchLow     = t4mspSearch.toLowerCase()
  const filteredAreas = searchLow
    ? t4mspAreas.filter(a => a.label.toLowerCase().includes(searchLow))
    : t4mspAreas
  const selectedT4msp = t4mspAreas.find(a => a.id === selectedT4mspArea)

  const areaOf = s => {
    const name = lang === 'it' ? s.area_it : s.area_en
    return !name || name === 'Area personalizzata' || name === 'Custom area' ? p.areaUndefined : name
  }
  const tracerOf = s => [p.pressures[s.pressure], s.pressure === 'chemical' ? s.chemical_compound : null]
    .filter(Boolean).join(' · ')

  // Il bottone di avvio della simulazione sta in una barra fissa in fondo al pannello
  // (Panel.jsx), fuori dall'area che scorre. In Analisi ogni sezione ha il suo.
  const actions = runMode === 'custom' && canSimulate ? (
    <Stack gap={6}>
      <Button size="sm" color="blue" fullWidth disabled={!canPrecompute} onClick={handleCustomCompute} type="button">
        {p.btnPrecompute}
      </Button>
      {hasActive && <Text size="xs" c="dimmed" ta="center">{p.queueHint}</Text>}
      {customPrecomputeError && (
        <Text size="xs" c="red">{describePrecomputeError(customPrecomputeError)}</Text>
      )}
    </Stack>
  ) : null

  const drawButtons = (
    <Group grow gap="xs">
      {['circle', 'rectangle', 'polygon'].map(mode => (
        <Button key={mode} size="xs" px={4} fz={11} color="blue" type="button"
                variant={drawMode === mode ? 'filled' : 'light'}
                onClick={() => onStartDraw(mode)}>
          {{ circle: p.btnCircle, rectangle: p.btnRect, polygon: p.btnPolygon }[mode]}
        </Button>
      ))}
    </Group>
  )

  return (
    <div style={{ pointerEvents: stopping ? 'none' : 'auto', opacity: stopping ? 0.5 : 1, transition: 'opacity 0.2s' }}>
      <Stack gap="sm" p="md">

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── SIMULATION ──────────────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}
        {runMode === 'custom' && (
          <Stack gap="sm">
            <SectionLabel>{p.sectionExisting}</SectionLabel>
            {customEntries.length === 0 ? (
              <Text size="xs" c="dimmed" ta="center">{p.noExisting}</Text>
            ) : (
              <>
                <NativeSelect
                  size="xs"
                  value={scenarioId}
                  onChange={e => setScenarioId(e.target.value)}
                  aria-label={p.sectionExisting}
                  data={[
                    { value: '', label: p.scenarioNone },
                    ...customEntries.map(([sid, s]) => {
                      const label = lang === 'it' ? s.label_it : s.label_en
                      const multi = s.seedings > 1 ? ` [${s.seedings}×]` : ''
                      const state = s.status === 'ready' ? '' : ` — ${statusText(s, p)}`
                      return { value: sid, label: `${label}${multi}${state}` }
                    }),
                  ]}
                />
                {selected ? (
                  <ScenarioCard
                    rows={[
                      [p.seedAreaName,      areaOf(selected)],
                      [sim.tracerType,      tracerOf(selected)],
                      [p.labelStart,        selected.start_time],
                      [p.labelDuration,     `${selected.duration_days} d`],
                      [p.labelParticles,    selected.pnum?.toLocaleString()],
                      [p.labelTimeStep,     `${selected.time_step_hours} h`],
                      [p.labelMultiSeeding, selected.seedings > 1 ? p.releasesShort.replace('{n}', selected.seedings).replace('{s}', selected.tshift) : null],
                      [p.labelBeaching,     selected.beaching === false ? t.analyses.no : t.analyses.yes],
                      [t.analysis.summary.forcing, selected.forcing_datasets ? forcingLabel(selected, t.analysis.forcingLabels) : null],
                    ]}
                    description={selected.description}
                  />
                ) : (
                  <Text size="xs" c="dimmed" ta="center">{p.sectionExistingDesc}</Text>
                )}
              </>
            )}

            <SimulationJobs
              entries={customEntries}
              lang={lang}
              p={p}
              canManage={canSimulate}
              busyIds={busyScenarioIds}
              onStop={handleStopSimulation}
              onRemove={handleRemoveSimulation}
            />

            {canSimulate ? (
              <>
                <Group justify="space-between" gap="xs" style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 10 }}>
                  <Text size="sm" fw={700}>{p.sectionNewScenario}</Text>
                  {access.locked && (
                    <Button size="compact-xs" variant="subtle" color="gray" type="button"
                            leftSection={<IconLockOpen size={12} />} onClick={handleLock}>
                      {p.access.lock}
                    </Button>
                  )}
                </Group>

                <TextInput size="xs" label={p.labelTitle} placeholder={p.labelTitleHint}
                           value={customLabel} onChange={e => setCustomLabel(e.target.value)} styles={LABEL_STYLES} />
                <Textarea size="xs" label={p.labelDesc} placeholder={p.labelDescHint}
                          value={customDesc} onChange={e => setCustomDesc(e.target.value)}
                          autosize minRows={2} styles={LABEL_STYLES} />

                {/* ── Area di semina ─────────────────────────────── */}
                <SectionLabel>{p.seedAreaLabel}</SectionLabel>
                <SegmentedControl
                  size="xs"
                  fullWidth
                  value={seedAreaMode}
                  onChange={mode => {
                    setSeedAreaMode(mode)
                    if (mode !== 'draw') onClearSeedShape()
                    if (mode !== 't4msp') { setSelectedT4mspArea(null); setT4mspPolygons(null); onT4mspPreview?.(null) }
                  }}
                  data={[
                    { value: 'draw',   label: p.seedAreaDraw },
                    { value: 'upload', label: p.seedAreaUpload },
                    { value: 't4msp',  label: p.seedAreaT4msp },
                  ]}
                  color="blue"
                />

                {seedAreaMode === 'draw' && (
                  <Stack gap="xs">
                    {drawButtons}
                    {drawMode === 'circle'    && <Text size="xs" c="dimmed" ta="center">{p.hintCircle}</Text>}
                    {drawMode === 'rectangle' && <Text size="xs" c="dimmed" ta="center">{p.hintRect}</Text>}
                    {drawMode === 'polygon'   && (
                      <PolygonDrawControls seedShape={seedShape} labels={p}
                                           onUndo={() => onUndoLastPolygon()} onFinish={onFinishDraw} />
                    )}
                    {!drawMode && seedInfo && (
                      <Group gap={4} align="center" px="xs" py={6}
                             style={{ background: 'rgba(10,132,255,0.08)', borderRadius: 6, border: '1px solid rgba(10,132,255,0.20)' }}>
                        <Text size="xs" c="blue.4" style={{ flex: 1, textAlign: 'center' }}>{seedInfo}</Text>
                        <ActionIcon size={16} variant="subtle" color="blue" aria-label={p.clearArea}
                                    onClick={() => onClearSeedShape()} style={{ flexShrink: 0, opacity: 0.7 }}>
                          <IconX size={10} />
                        </ActionIcon>
                      </Group>
                    )}
                    {!drawMode && !seedShape && <Text size="xs" c="dimmed" ta="center">{p.hintNoShape}</Text>}
                  </Stack>
                )}

                {seedAreaMode === 'upload' && (
                  <Button size="xs" variant="light" color="blue" fullWidth type="button"
                          onClick={() => fileRef.current?.click()} style={{ height: 'auto', padding: '12px 8px' }}>
                    <input ref={fileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleFileChange} />
                    {shapefileB64
                      ? <Text size="xs">{shapefileName}</Text>
                      : <Text size="xs" c="dimmed">{p.uploadHint}</Text>}
                  </Button>
                )}

                {seedAreaMode === 't4msp' && (
                  <Stack gap="xs">
                    <TextInput
                      size="xs"
                      placeholder={p.t4mspSearchHint}
                      value={t4mspSearch}
                      onChange={e => { setT4mspSearch(e.target.value); setSelectedT4mspArea(null); setT4mspPolygons(null); onT4mspPreview?.(null) }}
                    />
                    <ScrollArea h={140} style={{ border: '1px solid var(--modal-border)', borderRadius: 6 }}>
                      <Stack gap={0}>
                        {filteredAreas.map(area => (
                          <button
                            key={area.id}
                            type="button"
                            onClick={async () => {
                              const next = selectedT4mspArea === area.id ? null : area.id
                              setSelectedT4mspArea(next)
                              setT4mspPolygons(next && geoCache.current[area.id]
                                ? geometryPolygonCount(geoCache.current[area.id]) : null)
                              if (!next) { onT4mspPreview?.(null); return }
                              if (geoCache.current[area.id]) {
                                onT4mspPreview?.({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geoCache.current[area.id], properties: {} }] })
                                return
                              }
                              try {
                                const { geo } = await executeSync(Process.SCENARIO_STATUS, { area_id: area.id })
                                if (geo) {
                                  geoCache.current[area.id] = geo
                                  setT4mspPolygons(geometryPolygonCount(geo))
                                  onT4mspPreview?.({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geo, properties: {} }] })
                                }
                              } catch { /* l'area resta scelta, senza anteprima */ }
                            }}
                            className={`t4msp-area${selectedT4mspArea === area.id ? ' is-selected' : ''}`}
                          >
                            <span>{area.label}</span>
                            {selectedT4mspArea === area.id && <span style={{ fontSize: 10 }}>✓</span>}
                          </button>
                        ))}
                        {filteredAreas.length === 0 && (
                          <Text size="xs" c="dimmed" ta="center" p="sm">···</Text>
                        )}
                      </Stack>
                    </ScrollArea>
                  </Stack>
                )}

                <TextInput
                  size="xs"
                  label={p.labelSeedName}
                  placeholder={seedAreaMode === 't4msp' && selectedT4msp ? selectedT4msp.label : p.labelSeedNameHint}
                  value={seedAreaName}
                  onChange={e => setSeedAreaName(e.target.value)}
                  styles={LABEL_STYLES}
                />

                {/* ── Tracciante ─────────────────────────────────── */}
                <NativeSelect
                  size="xs"
                  label={lbl(sim.tracerType, sim.tracerTip)}
                  value={pressure}
                  onChange={e => setPressure(e.target.value)}
                  data={PRESSURES.map(k => ({ value: k, label: p.pressures[k] }))}
                  styles={LABEL_STYLES}
                />
                {pressure === 'chemical' && (
                  <NativeSelect
                    size="xs"
                    label={lbl(sim.compound, sim.compoundTip)}
                    value={compound}
                    onChange={e => setCompound(e.target.value)}
                    data={CHEMICAL_COMPOUNDS}
                    styles={LABEL_STYLES}
                  />
                )}

                {/* ── Tempi e particelle ─────────────────────────── */}
                <SectionLabel>{sim.timing}</SectionLabel>
                <Group grow gap="xs" align="flex-start">
                  <TextInput type="date" size="xs" label={lbl(p.labelStart, p.tooltips.labelStart)}
                             value={startDate} onChange={e => setStartDate(e.target.value)} styles={LABEL_STYLES} />
                  <TextInput type="number" size="xs" label={lbl(p.labelDuration, p.tooltips.labelDuration)}
                             value={durationDays} min="1" max="730"
                             onChange={e => setDurationDays(e.target.value)} styles={LABEL_STYLES} />
                </Group>
                <Group grow gap="xs" align="flex-start">
                  <TextInput type="number" size="xs" label={lbl(p.labelParticles, p.tooltips.labelParticles)}
                             value={usesPerPolygon ? '' : pnum}
                             placeholder={usesPerPolygon ? p.connSeedingOverride : undefined}
                             disabled={usesPerPolygon} min="10" max={MAX_PARTICLES}
                             onChange={e => setPnum(e.target.value)} styles={LABEL_STYLES} />
                  <NativeSelect size="xs" label={lbl(p.labelTimeStep, p.tooltips.labelTimeStep)}
                                value={timeStepHours} onChange={e => setTimeStepHours(e.target.value)}
                                data={TIME_STEPS} styles={LABEL_STYLES} />
                </Group>

                <div>
                  <SectionLabel tip={sim.distributionTip}>{sim.distribution}</SectionLabel>
                  <SegmentedControl
                    mt={6} size="xs" fullWidth value={distribution} onChange={setDistribution}
                    data={[{ value: 'even', label: sim.distEven }, { value: 'poly', label: sim.distPoly }]}
                    aria-label={sim.distribution}
                  />
                </div>
                {usesPerPolygon && (
                  <Stack gap={4}>
                    <TextInput type="number" size="xs" label={lbl(p.connSeedingLabel, p.tooltips.connSeedingNum)}
                               value={pnumPerPolygon} min="10" max={MAX_PER_POLYGON}
                               onChange={e => setPnumPerPolygon(e.target.value)} styles={LABEL_STYLES} />
                    {perPolygonTotal != null ? (
                      <Text size="10px" c={perPolygonTooMany ? 'red.5' : 'blue.5'} fw={500}>
                        {(seedPolygons === 1 ? p.connSeedingTotalOne : p.connSeedingTotal)
                          .replace('{total}', perPolygonTotal.toLocaleString())
                          .replace('{n}', seedPolygons)}
                        {perPolygonTooMany && ` ${p.connSeedingTooMany.replace('{max}', MAX_PARTICLES.toLocaleString())}`}
                      </Text>
                    ) : seedAreaMode === 'upload' && (
                      <Text size="10px" c="dimmed">{p.connSeedingUploadTotal.replace('{max}', MAX_PARTICLES.toLocaleString())}</Text>
                    )}
                  </Stack>
                )}

                {/* ── Avanzate ───────────────────────────────────── */}
                <UnstyledButton onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}>
                  <Group gap={4}>
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em', flex: 1 }}>
                      {p.advancedLabel}
                    </Text>
                    <IconChevronDown size={12} style={{ transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                  </Group>
                </UnstyledButton>
                <Collapse expanded={showAdvanced}>
                  <Stack gap="xs">
                    <MultiSeedingBox
                      p={p}
                      locale={t.controls.locale}
                      enabled={multiSeeding}
                      onToggle={setMultiSeeding}
                      releases={seedings}
                      onReleases={setSeedings}
                      shift={tshift}
                      onShift={setTshift}
                      startDate={startDate}
                      duration={durationDays}
                    />
                    <TextInput type="number" size="xs" label={lbl(p.labelCmemsMargin, p.tooltips.labelCmemsMargin)}
                               value={cmemsMargin} min="0" max="20" step="any"
                               onChange={e => setCmemsMargin(e.target.value)} styles={LABEL_STYLES} />
                    <Switch
                      size="xs"
                      label={lbl(p.noBeachingToggle, p.tooltips.noBeaching)}
                      checked={noBeaching}
                      onChange={e => setNoBeaching(e.currentTarget.checked)}
                    />
                  </Stack>
                </Collapse>

                <Text size="10px" c={ncColor} p="xs"
                      style={{ background: ncBg, borderRadius: 6, borderLeft: `2px solid ${ncBorder}`, lineHeight: 1.4 }}>
                  {p.ncSizeHint.replace('{size}', formatNcSize(ncEstimateBytes))}
                  {usesPerPolygon && perPolygonTotal == null && ` ${p.ncSizePerPolygon}`}
                </Text>
              </>
            ) : (
              <SimulationLock
                a={p.access}
                value={tokenInput}
                onChange={setTokenInput}
                onUnlock={handleUnlock}
                pending={unlockPending}
                error={unlockError}
              />
            )}
          </Stack>
        )}

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── ANALYSIS ────────────────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}
        {runMode === 'scenario' && (
          <Stack gap="sm">
            {sc ? (
              <ScenarioCard
                rows={[
                  [t.analysis.summary.simulation, scenarioLabel],
                  [t.analysis.summary.bbox,       sc.bounds ? formatBbox(sc.bounds) : null],
                  [sim.tracerType,                tracerOf(sc)],
                  [t.analysis.summary.forcing,    forcingLabel(sc, t.analysis.forcingLabels)],
                  [p.labelStart,                  sc.start_time],
                  [p.labelDuration,               `${sc.duration_days} d`],
                  [p.labelParticles,              sc.pnum?.toLocaleString()],
                  // Solo per gli scenari seminati per poligono: è l'informazione
                  // che dice se lo scenario è un buon input per la connettività.
                  [p.labelSeedingPerPoly,         sc.seeding_mode === 'per_polygon'
                    ? `${sc.pnum_per_polygon?.toLocaleString()} × ${sc.n_polygons}` : null],
                  [p.labelTimeStep,               `${sc.time_step_hours} h`],
                  [p.labelMultiSeeding,           sc.seedings > 1 ? p.releasesShort.replace('{n}', sc.seedings).replace('{s}', sc.tshift) : t.analyses.no],
                ]}
                description={sc.description}
              />
            ) : (
              <Text size="xs" c="dimmed" ta="center">{p.hintNoScenario}</Text>
            )}

            <Accordion multiple value={openSections} onChange={setOpenSections} variant="separated"
                       radius="md" chevronPosition="left" className="analysis-accordion">
              <Accordion.Item value="dispersal">
                <SectionControl title={t.analysis.dispersal.title} tip={t.analysis.dispersal.tip} />
                <Accordion.Panel>
                  <DispersalSection
                    ctx={ctx}
                    sourcePicker={renderSourcePicker({ value: useSource, onPick: onUseSourceChange })}
                    useSource={useSource}
                    geotiff={geotiff}
                    onRun={onRun}
                    loading={loading}
                    stopping={stopping}
                    onStop={onStop}
                    onMarginChange={onAnalysisMarginChange}
                  />
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="connectivity">
                <SectionControl title={t.analysis.connectivity.title} tip={t.analysis.connectivity.tip} />
                <Accordion.Panel>
                  <ConnectivitySection
                    ctx={ctx}
                    onRun={onRunConnectivity}
                    loading={connectivityLoading}
                    stopping={connectivityStopping}
                    onStop={onStopConnectivity}
                    draw={draw}
                    active={sectionActive('connectivity')}
                  />
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="propagate">
                <SectionControl title={t.analysis.propagate.title} tip={t.analysis.propagate.tip} />
                <Accordion.Panel>
                  <PropagateSection
                    ctx={ctx}
                    markov={markov}
                    draw={draw}
                    matrices={matrices}
                    active={sectionActive('propagate')}
                  />
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          </Stack>
        )}
      </Stack>
      {actionsTarget && createPortal(actions, actionsTarget)}
    </div>
  )
}
