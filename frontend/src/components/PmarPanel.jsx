import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Tabs, Button, Group, Stack, Text, TextInput, Textarea, PasswordInput,
  SimpleGrid, SegmentedControl, NativeSelect, Paper, ScrollArea,
  Switch, Badge, Collapse, ActionIcon, Divider,
} from '@mantine/core'
import { IconInfoCircle, IconX, IconChevronDown, IconChevronUp, IconCircleCheck,
         IconLock, IconLockOpen, IconGridDots, IconWindmill, IconBuildingFactory2,
         IconFish, IconFileUpload, IconPolygon } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useLang } from '../LanguageContext'
import { Process, ACCESS_DENIED, executeSync, executeAsync,
         dismissJob, setAccessToken } from '../api/ogcProcesses'
import { formatSeedShape, geometryPolygonCount, seedShapePolygonCount,
         seedShapeToGeoJSON } from '../geometry/seedShape'
import PolygonDrawControls from './PolygonDrawControls'
import SimulationJobs from './SimulationJobs'
import MarkovControls, { defaultHorizon, markovParamError } from './MarkovControls'
import { POLL_INTERVAL_MS, anyActive, errorText, isActive, statusOf, statusText,
         transitions } from '../scenarios/lifecycle'

function InfoTooltip({ text }) {
  const [anchor, setAnchor] = useState(null)

  return (
    <>
      <span
        onMouseEnter={e => setAnchor({ x: e.clientX, y: e.clientY })}
        onMouseMove={e => setAnchor({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setAnchor(null)}
        style={{ display: 'inline-flex', cursor: 'help', opacity: 0.5, marginLeft: 4, verticalAlign: 'middle', lineHeight: 1 }}
      >
        <IconInfoCircle size={12} />
      </span>
      {anchor && createPortal(
        <div style={{
          position: 'fixed',
          left: anchor.x + 14,
          top: anchor.y - 6,
          maxWidth: 240,
          background: 'var(--mantine-color-dark-6)',
          color: 'var(--mantine-color-gray-3)',
          fontSize: 12,
          lineHeight: 1.5,
          padding: '6px 10px',
          borderRadius: 6,
          boxShadow: '0 4px 20px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.07)',
          zIndex: 99999,
          pointerEvents: 'none',
          wordBreak: 'break-word',
        }}>
          {text}
        </div>,
        document.body
      )}
    </>
  )
}

function lbl(text, tip) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {text}
      {tip && <InfoTooltip text={tip} />}
    </span>
  )
}

const PRESSURES = [
  { key: 'generic', labelKey: 'generic' },
  { key: 'plastic', labelKey: 'plastic' },
  { key: 'oil',     labelKey: 'oil'     },
  { key: 'larvae',  labelKey: 'larvae'  },
]

// Layer sorgente divisi per natura: nessun peso, dati EMODnet scaricati per l'area,
// raster dell'utente. Ogni famiglia ha il suo riquadro nel pannello Analisi.
const EMODNET_SOURCES = [
  { key: 'windfarms',              Icon: IconWindmill },
  { key: 'offshore_installations', Icon: IconBuildingFactory2 },
  { key: 'msp_zones',              Icon: IconFish },
]

const NOTE_WARN = { background: 'rgba(239,68,68,0.07)', borderRadius: 6, borderLeft: '2px solid rgba(239,68,68,0.4)' }

/** Riquadro di una famiglia di layer sorgente: titolo, riga di spiegazione, bottoni. */
function SourceGroup({ title, hint, children }) {
  return (
    <Stack gap={6} p="xs" style={{ border: '1px solid var(--panel-border)', borderRadius: 8 }}>
      <div>
        <Text size="11px" fw={600}>{title}</Text>
        <Text size="10px" c="dimmed" lh={1.35}>{hint}</Text>
      </div>
      {children}
    </Stack>
  )
}

function SourceButton({ active, Icon, loading, onClick, children }) {
  return (
    <Button
      size="xs"
      fullWidth
      justify="flex-start"
      variant={active ? 'filled' : 'light'}
      color="blue"
      leftSection={<Icon size={14} />}
      loading={loading}
      onClick={onClick}
      type="button"
    >
      {children}
    </Button>
  )
}

// Deve restare allineato a PMAR_RESOLUTIONS in processes/PMARProcess.py
const RESOLUTIONS = [
  { value: '0.1',  label: '0.1°'  },
  { value: '0.05', label: '0.05°' },
]

// Deve restare allineato a GRID_RESOLUTIONS in processes/ConnectivityProcess.py
const GRID_RESOLUTIONS = [
  { value: '1.0', label: '1.0°' },
  { value: '0.5', label: '0.5°' },
]

const TIME_STEPS = [
  { value: '1',  label: '1 h'  },
  { value: '3',  label: '3 h'  },
  { value: '6',  label: '6 h'  },
  { value: '12', label: '12 h' },
  { value: '24', label: '24 h' },
]

// Limite di particelle per scenario del backend (PrecomputeProcess).
const MAX_PARTICLES = 100000
// Particelle per poligono: il backend porta i valori fuori da [1, 20000] dentro l'intervallo.
const MAX_PER_POLYGON = 20000

const LABEL_STYLES = {
  label: {
    color: 'var(--mantine-color-dimmed)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
}

function computeDateRange(startDate, seedings, tshift, locale) {
  try {
    const start = new Date(startDate)
    const last  = new Date(start)
    last.setDate(last.getDate() + (parseInt(seedings) - 1) * parseInt(tshift))
    const fmt = d => d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
    return `${fmt(start)} → ${fmt(last)}`
  } catch {
    return ''
  }
}

function defaultStartDate() {
  const d = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
        // Il pannello è un unico <form>: Invio qui non deve lanciare l'analisi.
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onUnlock() } }}
      />
      <Button size="xs" type="button" onClick={onUnlock} loading={pending} disabled={!value.trim()}>
        {a.unlock}
      </Button>
    </Stack>
  )
}

export default function PmarPanel({
  onRun, loading, onStop, stopping, status, statusType,
  drawMode, onStartDraw, onFinishDraw, onUndoLastPolygon, onClearSeedShape, seedShape,
  useSource, onUseSourceChange,
  windfarmsLoading, windfarmsEmpty,
  offshoreLoading, offshoreEmpty,
  mspZonesLoading, mspZonesEmpty,
  natura2000Loading, natura2000Empty, natura2000Geojson,
  showNatura2000, onFetchNatura2000, onToggleNatura2000,
  hasSeedShape, onT4mspPreview, onScenarioArea, onAnalysisMarginChange,
  onRunConnectivity, connectivityLoading, connectivityStopping, onStopConnectivity,
  markov = {}, drawTarget = 'seed',
  actionsTarget, analysesFull = false,
}) {
  const { t, lang } = useLang()
  const p = t.pmar

  const [runMode,       setRunMode]       = useState('custom')
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
  // totale della semina per connettività. null finché la geometria non è arrivata.
  const [t4mspPolygons,     setT4mspPolygons]     = useState(null)
  const [t4mspSearch,       setT4mspSearch]       = useState('')

  const [customLabel,   setCustomLabel]   = useState('')
  const [customDesc,    setCustomDesc]    = useState('')
  const [seedAreaName,  setSeedAreaName]  = useState('')
  const [cmemsMargin,   setCmemsMargin]   = useState('1')
  const [multiSeeding,  setMultiSeeding]  = useState(false)
  const [connSeeding,    setConnSeeding]    = useState(false)
  const [pnumPerPolygon, setPnumPerPolygon] = useState('500')
  const [seedings,      setSeedings]      = useState('3')
  const [tshift,        setTshift]        = useState('30')
  const [pressure,      setPressure]      = useState('generic')
  const [startDate,     setStartDate]     = useState(defaultStartDate())
  const [durationDays,  setDurationDays]  = useState('30')
  const [pnum,          setPnum]          = useState('1000')
  const [timeStepHours, setTimeStepHours] = useState('1')

  const [res,         setRes]         = useState('0.1')
  const [margin,      setMargin]      = useState('1')
  const [geotiffB64,  setGeotiffB64]  = useState(null)
  const [geotiffName, setGeotiffName] = useState('')
  const geotiffRef = useRef(null)

  // Sotto-tab dell'Analisi: 'sources' (PPI pesato) | 'connectivity'
  const [analysisMode,   setAnalysisMode]   = useState('sources')
  const [connShpB64,     setConnShpB64]     = useState(null)
  const [connShpName,    setConnShpName]    = useState('')
  // Titolo dell'analisi che si sta per lanciare; vuoto = titolo automatico.
  const [analysisTitle,  setAnalysisTitle]  = useState('')
  const [connMode,       setConnMode]       = useState('transition')
  const [connDays,       setConnDays]       = useState('')
  const [connLabelField, setConnLabelField] = useState('')
  const [connSelfLoops,  setConnSelfLoops]  = useState(true)
  // Nodi della rete: i poligoni di uno shapefile, oppure una griglia regolare
  // di celle di mare su un riquadro (la terraferma la esclude il backend).
  const [connSource,     setConnSource]     = useState('shapefile')
  const [connRes,        setConnRes]        = useState('0.5')
  const [connBbox,       setConnBbox]       = useState(['', '', '', ''])
  const connFileRef = useRef(null)

  // Sotto-tab Markov (processes/MarkovProcess.py). La sorgente riusa `useSource` (stessi
  // riquadri e anteprime EMODnet della PMAR); `markovArea` la sostituisce con un'area
  // disegnata sulla mappa, che vale solo qui.
  const [mkDt,       setMkDt]       = useState('10')
  const [mkHorizon,  setMkHorizon]  = useState('')
  const [mkRelease,  setMkRelease]  = useState('single')
  const [mkRes,      setMkRes]      = useState('0.25')
  const [markovArea, setMarkovArea] = useState(false)

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
  }, [runMode, refetchFlag])

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

  useEffect(() => { onT4mspPreview?.(null) }, [runMode])

  // L'area della preview EMODnet in App segue il margine dell'analisi.
  const marginValue = Math.max(0, Math.min(parseFloat(margin) || 0, 20))
  useEffect(() => { onAnalysisMarginChange?.(marginValue) }, [marginValue])

  // Area della simulazione scelta, evidenziata sulla mappa. La geometria si
  // chiede solo alla selezione: la mappa di stato viene ripolled, e leggere
  // tutti gli shapefile a ogni giro costerebbe troppo.
  useEffect(() => {
    let annullato = false
    if (!scenarioId) { onScenarioArea?.(null); return }

    const invia = geo => {
      if (annullato || !geo) return
      onScenarioArea?.({ type: 'FeatureCollection',
                         features: [{ type: 'Feature', geometry: geo, properties: {} }] }, scenarioId)
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
    if (drawMode && drawTarget !== 'markov') setScenarioId('')
  }, [drawMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // L'area di rilascio Markov si vede solo dove la si sceglie.
  useEffect(() => {
    markov.onShapeVisible?.(runMode === 'scenario' && analysisMode === 'markov' && markovArea)
  }, [runMode, analysisMode, markovArea]) // eslint-disable-line react-hooks/exhaustive-deps

  // Δt non può superare la simulazione: scegliendone una più corta lo si riduce.
  useEffect(() => {
    const dur = scenarioStatuses[scenarioId]?.duration_days
    if (dur && parseFloat(mkDt) > dur) setMkDt(String(Math.min(10, dur)))
  }, [scenarioId, scenarioStatuses]) // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-compila il riquadro con l'area di semina dello scenario scelto. Gli
  // scenari creati prima che i bounds venissero registrati non ne hanno: il
  // backend in quel caso ricade comunque sull'area dello scenario.
  useEffect(() => {
    const b = scenarioStatuses[scenarioId]?.bounds
    setConnBbox(b?.length === 4 ? b.map(v => String(v)) : ['', '', '', ''])
  }, [scenarioId, scenarioStatuses])

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
      ...(shapefileB64       ? { shapefile_b64: shapefileB64 }       : {}),
      ...(selectedT4mspArea  ? { t4msp_area_id: selectedT4mspArea }  : {}),
      ...(seedAreaMode === 'draw' && seedAreaName.trim()
            ? { area_name: seedAreaName.trim() } : {}),
      cmems_margin: parseFloat(cmemsMargin) || 5.0,
      ...(customDesc.trim() ? { description: customDesc.trim() } : {}),
      ...(multiSeeding ? { seedings: parseInt(seedings) || 3, tshift: parseInt(tshift) || 30 } : {}),
      ...(usesPerPolygon ? { pnum_per_polygon: parseInt(pnumPerPolygon) || 500 } : {}),
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

  function handleFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setShapefileB64(ev.target.result.split(',')[1])
      setShapefileName(file.name)
    }
    reader.readAsDataURL(file)
  }

  function handleGeotiffChange(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setGeotiffB64(ev.target.result.split(',')[1])
      setGeotiffName(file.name)
    }
    reader.readAsDataURL(file)
  }

  function handleConnFileChange(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      setConnShpB64(ev.target.result.split(',')[1])
      setConnShpName(file.name)
    }
    reader.readAsDataURL(file)
  }

  /**
   * Dati per la scheda dell'analisi nel pannello di destra: lo scenario usato e i
   * parametri. Si salvano i valori grezzi (anche le etichette in entrambe le lingue),
   * così la descrizione segue la lingua corrente anche dopo.
   */
  function scenarioInfo() {
    const sc = scenarioStatuses[scenarioId] ?? {}
    return {
      id: scenarioId, label_it: sc.label_it, label_en: sc.label_en,
      area_it: sc.area_it, area_en: sc.area_en, pressure: sc.pressure,
      start_time: sc.start_time, duration_days: sc.duration_days, pnum: sc.pnum,
      seedings: sc.seedings, tshift: sc.tshift, time_step_hours: sc.time_step_hours,
    }
  }

  function handleRunConnectivity() {
    if (!canRunConnectivity) return
    const title = analysisTitle.trim() || autoTitle
    setAnalysisTitle('')
    onRunConnectivity({
      scenario_id:      scenarioId,
      mode:             connMode,
      self_loops:       connSelfLoops,
      ...(connDays                ? { t_days: parseFloat(connDays) }             : {}),
      ...(connSource === 'shapefile'
            ? { shapefile_b64: connShpB64,
                ...(connLabelField.trim() ? { node_label_field: connLabelField.trim() } : {}) }
            : { grid_res: parseFloat(connRes),
                // Senza riquadro il backend usa l'area dello scenario, che è
                // esattamente il default che i campi mostrano.
                ...(connBboxValid ? { bbox: connBbox.map(Number) } : {}) }),
    }, {
      title,
      info: {
        scenario: scenarioInfo(),
        params: {
          mode: connMode, self_loops: connSelfLoops,
          t_days: connDays ? parseFloat(connDays) : scenarioStatuses[scenarioId]?.duration_days,
          node_source: connSource,
          ...(connSource === 'shapefile'
                ? { shapefile_name: connShpName, label_field: connLabelField.trim() || null }
                : { grid_res: parseFloat(connRes), bbox: connBboxValid ? connBbox.map(Number) : null }),
        },
      },
    })
  }

  function handleSubmit(e) {
    e.preventDefault()
    // Il pannello è un unico <form>: Invio in un campo della sotto-tab Connettività
    // (titolo, riquadro, orizzonte) non deve lanciare l'analisi delle sorgenti.
    if (runMode !== 'scenario' || analysisMode !== 'sources' || !canSubmit) return
    const title = analysisTitle.trim() || autoTitle
    setAnalysisTitle('')
    onRun({
      scenario_id: scenarioId,
      res: parseFloat(res),
      margin: parseFloat(margin) || 0,
      geotiff_b64: useSource === 'geotiff' ? geotiffB64 : null,
      title,
      info: {
        scenario: scenarioInfo(),
        params: {
          use_source: useSource, res: parseFloat(res), margin: parseFloat(margin) || 0,
          ...(useSource === 'geotiff' ? { geotiff_name: geotiffName } : {}),
        },
      },
    })
  }

  const seedInfo = seedAreaMode === 'draw'
    ? formatSeedShape(seedShape, { polygons: p.seedPolygons, polygonsOne: p.seedPolygonOne })
    : null

  // Semina per connettività: vale per ogni modo di definire l'area e, quando è
  // attiva, è lei a determinare il numero di particelle (pnum viene ignorato).
  // Il totale si conosce prima dell'invio per le aree disegnate e per quelle
  // Tools4MSP; per uno shapefile lo calcola il backend, che rifiuta subito la
  // richiesta oltre il limite.
  const usesPerPolygon  = connSeeding
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

  // Il riquadro vale solo se i quattro campi sono numeri e non è degenere.
  const connBboxNums  = connBbox.map(Number)
  const connBboxValid =
    connBbox.every(v => v !== '' && Number.isFinite(Number(v))) &&
    connBboxNums[2] > connBboxNums[0] && connBboxNums[3] > connBboxNums[1]

  // Stima grossolana: il backend scarta poi le celle sulla terraferma, quindi il
  // numero reale è sempre minore. Serve solo a evitare richieste assurde.
  const connCellsEstimate = connBboxValid
    ? Math.ceil((connBboxNums[2] - connBboxNums[0]) / parseFloat(connRes)) *
      Math.ceil((connBboxNums[3] - connBboxNums[1]) / parseFloat(connRes))
    : null

  const canRunConnectivity =
    !connectivityLoading && !analysesFull && runMode === 'scenario' &&
    !!scenarioId && scenarioStatuses[scenarioId]?.status === 'ready' &&
    (connSource === 'shapefile' ? !!connShpB64 : !!connRes)

  // Titolo proposto quando il campo è vuoto: tipo di analisi, dettaglio, scenario.
  const scenarioLabel = (() => {
    const sc = scenarioStatuses[scenarioId]
    return sc ? (lang === 'it' ? sc.label_it : sc.label_en) : ''
  })()
  const markovSource = markovArea ? 'area' : useSource === 'none' ? 'uniform' : useSource
  const markovSourceLabel = markovArea ? p.markov.sourceArea : p.useSources[useSource]
  const autoTitle = (analysisMode === 'connectivity'
    ? [p.connectivity.subTabConnectivity,
       connSource === 'grid' ? `${p.connectivity.sourceGrid} ${connRes}°` : (connShpName || p.connectivity.sourceShapefile),
       scenarioLabel]
    : analysisMode === 'markov'
    ? ['Markov', markovSourceLabel, `Δt ${mkDt} d`, scenarioLabel]
    : ['PPI', p.useSources[useSource], scenarioLabel]
  ).filter(Boolean).join(' · ')

  /**
   * Riquadri del layer sorgente, comuni a PPI e Markov. Per la Markov c'è in più l'area
   * disegnata, e un bottone è acceso solo se l'area non è scelta.
   */
  function renderSourceGroups(forMarkov) {
    const on = key => useSource === key && !(forMarkov && markovArea)
    const pick = key => { if (forMarkov) setMarkovArea(false); onUseSourceChange(key) }
    return (
      <>
        <SourceGroup title={p.useGroups.uniform}
                     hint={forMarkov ? p.markov.uniformHint : p.useGroups.uniformHint}>
          <SourceButton active={on('none')} Icon={IconGridDots} onClick={() => pick('none')}>
            {p.useSources.none}
          </SourceButton>
        </SourceGroup>

        <SourceGroup title={p.useGroups.emodnet}
                     hint={forMarkov ? p.markov.emodnetHint : p.useGroups.emodnetHint}>
          {EMODNET_SOURCES.map(({ key, Icon }) => (
            <SourceButton key={key} active={on(key)} Icon={Icon}
                          loading={emodnetState[key].loading}
                          onClick={() => pick(key)}>
              {p.useSources[key]}
            </SourceButton>
          ))}
          {/* Solo l'avviso di area senza dati: cosa fa il layer lo dice già il titolo. */}
          {EMODNET_SOURCES.some(({ key }) => on(key)) && emodnetState[useSource].empty && (
            <Text size="xs" p="xs" c="red.4" style={NOTE_WARN}>
              {emodnetState[useSource].emptyText}
            </Text>
          )}
        </SourceGroup>

        <SourceGroup title={p.useGroups.custom}
                     hint={forMarkov ? p.markov.customHint : p.useGroups.customHint}>
          <SourceButton active={on('geotiff')} Icon={IconFileUpload} onClick={() => pick('geotiff')}>
            {p.useSources.geotiff}
          </SourceButton>
          {on('geotiff') && (
            <Button
              size="xs"
              variant="default"
              fullWidth
              onClick={() => geotiffRef.current?.click()}
              style={{ height: 'auto', padding: '10px 8px', borderStyle: 'dashed' }}
              type="button"
            >
              <input ref={geotiffRef} type="file" accept=".tif,.tiff" style={{ display: 'none' }} onChange={handleGeotiffChange} />
              {geotiffB64
                ? <Text size="xs">{geotiffName}</Text>
                : <Text size="xs" c="dimmed">{p.geotiffUploadHint}</Text>}
            </Button>
          )}
          {forMarkov && (
            <SourceButton active={markovArea} Icon={IconPolygon} onClick={() => setMarkovArea(true)}>
              {p.markov.sourceArea}
            </SourceButton>
          )}
        </SourceGroup>
      </>
    )
  }

  // ── Markov: parametri, validità, avvio ─────────────────────────────────────
  const mkScenario = scenarioStatuses[scenarioId]
  const mkDtNum    = parseFloat(mkDt)
  const mkHorizonDefault = defaultHorizon(mkDtNum, mkScenario?.duration_days)
  const mkHorizonNum = parseFloat(mkHorizon) || mkHorizonDefault
  const mkError = mkScenario
    ? markovParamError({ dt: mkDtNum, horizon: mkHorizonNum, simDays: mkScenario.duration_days,
                         stepHours: mkScenario.time_step_hours }, p.markov)
    : null
  const mkSteps = mkHorizonNum > 0 && mkDtNum > 0 ? Math.floor(mkHorizonNum / mkDtNum + 1e-9) : 0
  const mkValidUntil = mkScenario
    ? Math.min(mkSteps, Math.floor(mkScenario.duration_days / mkDtNum + 1e-9)) * mkDtNum : 0
  const canRunMarkov =
    !markov.loading && !analysesFull && runMode === 'scenario' && !!scenarioId &&
    mkScenario?.status === 'ready' && !mkError &&
    (markovSource !== 'geotiff' || !!geotiffB64) &&
    (markovSource !== 'area' || !!markov.shape)

  function handleRunMarkov() {
    if (!canRunMarkov) return
    const title = analysisTitle.trim() || autoTitle
    setAnalysisTitle('')
    markov.onRun({
      scenario_id:  scenarioId,
      res:          parseFloat(mkRes),
      dt_days:      mkDtNum,
      horizon_days: mkHorizonNum,
      release:      mkRelease,
      source:       markovSource,
      ...(markovSource === 'geotiff' ? { geotiff_b64: geotiffB64 } : {}),
      ...(markovSource === 'area' ? { area_geojson: JSON.stringify(seedShapeToGeoJSON(markov.shape)) } : {}),
    }, {
      title,
      info: {
        scenario: scenarioInfo(),
        params: {
          source: markovSource, res: parseFloat(mkRes), dt_days: mkDtNum,
          horizon_days: mkHorizonNum, release: mkRelease,
          ...(markovSource === 'geotiff' ? { geotiff_name: geotiffName } : {}),
        },
      },
    })
  }

  const limitNote = analysesFull && (
    <Text size="xs" c="orange.6" ta="center">{t.analyses.limitReached}</Text>
  )

  const emodnetState = {
    windfarms:              { loading: windfarmsLoading, empty: windfarmsEmpty, emptyText: p.useWindfarmsEmpty },
    offshore_installations: { loading: offshoreLoading,  empty: offshoreEmpty,  emptyText: p.useOffshoreEmpty },
    msp_zones:              { loading: mspZonesLoading,  empty: mspZonesEmpty,  emptyText: p.useMspZonesEmpty },
  }

  const canSubmit = !loading && !analysesFull && runMode === 'scenario' &&
    !!scenarioId && scenarioStatuses[scenarioId]?.status === 'ready' &&
    (useSource !== 'geotiff' || !!geotiffB64)

  const ncBytesPerStep  = pressure === 'oil' ? 160 : pressure === 'larvae' ? 120 : pressure === 'plastic' ? 60 : 40
  const stepsPerDay     = 24 / parseInt(timeStepHours || 1)
  const ncSeedingsCount = multiSeeding ? (parseInt(seedings) || 1) : 1
  const ncParticles     = usesPerPolygon ? (perPolygonTotal ?? perPolygon) : parseInt(pnum || 0)
  const ncEstimateBytes = ncParticles * parseInt(durationDays || 0) * stepsPerDay * ncBytesPerStep * ncSeedingsCount
  function formatNcSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
    return (bytes / 1e3).toFixed(0) + ' KB'
  }
  const ncColor  = ncEstimateBytes > 2e9 ? 'red.4' : ncEstimateBytes > 5e8 ? 'yellow.4' : 'dimmed'
  const ncBg     = ncEstimateBytes > 2e9 ? 'rgba(239,68,68,0.07)' : ncEstimateBytes > 5e8 ? 'rgba(245,158,11,0.07)' : 'rgba(10,132,255,0.05)'
  const ncBorder = ncEstimateBytes > 2e9 ? '#ef4444' : ncEstimateBytes > 5e8 ? '#f59e0b' : 'rgba(10,132,255,0.30)'

  const customEntries = Object.entries(scenarioStatuses).filter(([, sc]) => sc.source === 'custom')

  const searchLow     = t4mspSearch.toLowerCase()
  const filteredAreas = searchLow
    ? t4mspAreas.filter(a => a.label.toLowerCase().includes(searchLow))
    : t4mspAreas

  const isBlocked = stopping

  // I bottoni di avvio stanno in una barra fissa in fondo al pannello (Panel.jsx),
  // fuori dall'area che scorre: per lanciare non serve scorrere fino in fondo.
  // Lo stato resta qui; il portal sposta solo dove vengono disegnati.
  let actions = null
  if (runMode === 'custom' && canSimulate) {
    actions = (
      <Stack gap={6}>
        <Button
          size="sm"
          color="blue"
          fullWidth
          disabled={!canPrecompute}
          onClick={handleCustomCompute}
          type="button"
        >
          {p.btnPrecompute}
        </Button>
        {hasActive && <Text size="xs" c="dimmed" ta="center">{p.queueHint}</Text>}
        {customPrecomputeError && (
          <Text size="xs" c="red">{describePrecomputeError(customPrecomputeError)}</Text>
        )}
      </Stack>
    )
  } else if (runMode === 'scenario' && analysisMode === 'sources') {
    actions = (
      <Stack gap={6}>
        {loading ? (
          <Group grow gap="xs">
            <Button size="sm" color="blue" disabled>
              {stopping ? p.btnStopping : p.btnRunning}
            </Button>
            <Button size="sm" color="red" variant="outline" type="button"
              loading={stopping}
              disabled={stopping}
              onClick={onStop}
            >
              {stopping ? p.btnStopping : p.btnStop}
            </Button>
          </Group>
        ) : (
          <Button size="sm" color="blue" fullWidth type="submit" form="pmar-form" disabled={!canSubmit}>
            {p.btnRun}
          </Button>
        )}
        {limitNote}
      </Stack>
    )
  } else if (runMode === 'scenario' && analysisMode === 'markov') {
    actions = (
      <Stack gap={6}>
        {markov.loading ? (
          <Group grow gap="xs">
            <Button size="sm" color="blue" disabled type="button">
              {markov.stopping ? p.btnStopping : p.markov.btnRunning}
            </Button>
            <Button size="sm" color="red" variant="outline" type="button"
                    loading={markov.stopping} disabled={markov.stopping} onClick={markov.onStop}>
              {markov.stopping ? p.btnStopping : p.btnStop}
            </Button>
          </Group>
        ) : (
          <Button size="sm" color="blue" fullWidth type="button"
                  disabled={!canRunMarkov} onClick={handleRunMarkov}>
            {p.markov.btnRun}
          </Button>
        )}
        {markovSource === 'area' && !markov.shape && (
          <Text size="xs" c="dimmed" ta="center">{p.markov.areaHint}</Text>
        )}
        {limitNote}
      </Stack>
    )
  } else if (runMode === 'scenario' && analysisMode === 'connectivity') {
    actions = (
      <Stack gap={6}>
        {connectivityLoading ? (
          <Group grow gap="xs">
            <Button size="sm" color="blue" disabled type="button">
              {connectivityStopping ? p.btnStopping : p.connectivity.btnRunning}
            </Button>
            <Button
              size="sm"
              color="red"
              variant="outline"
              type="button"
              loading={connectivityStopping}
              disabled={connectivityStopping}
              onClick={onStopConnectivity}
            >
              {connectivityStopping ? p.btnStopping : p.btnStop}
            </Button>
          </Group>
        ) : (
          <Button
            size="sm"
            color="blue"
            fullWidth
            type="button"
            disabled={!canRunConnectivity}
            onClick={handleRunConnectivity}
          >
            {p.connectivity.btnRun}
          </Button>
        )}

        {connSource === 'shapefile' && !connShpB64 && (
          <Text size="xs" c="dimmed" ta="center">{p.connectivity.hintNoShapefile}</Text>
        )}
        {limitNote}
      </Stack>
    )
  }

  return (
    <form id="pmar-form" onSubmit={handleSubmit}>
      <div style={{ pointerEvents: isBlocked ? 'none' : 'auto', opacity: isBlocked ? 0.5 : 1, transition: 'opacity 0.2s' }}>
      <Stack gap="sm" p="md">

        <Tabs value={runMode} onChange={setRunMode}>
          <Tabs.List grow>
            <Tabs.Tab value="custom" fz="xs">{p.modeCustomBtn}</Tabs.Tab>
            <Tabs.Tab value="scenario" fz="xs">{p.modeScenarioBtn}</Tabs.Tab>
          </Tabs.List>

          {/* ══════════════════════════════════════════════════════════ */}
          {/* ── TAB SIMULAZIONE ─────────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════ */}
          <Tabs.Panel value="custom">
            <Stack gap="sm" pt="sm">

              {/* ── Simulazioni esistenti ────────────────────────── */}
              <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                {p.sectionExisting}
              </Text>
              {customEntries.length === 0 ? (
                <Text size="xs" c="dimmed" ta="center">{p.noExisting}</Text>
              ) : (
                <>
                  <NativeSelect
                    size="xs"
                    value={scenarioId}
                    onChange={e => setScenarioId(e.target.value)}
                    data={[
                      { value: '', label: p.scenarioNone },
                      ...customEntries.map(([sid, sc]) => {
                        const label   = lang === 'it' ? sc.label_it : sc.label_en
                        const multi   = sc.seedings > 1 ? ` [${sc.seedings}×]` : ''
                        const state   = sc.status === 'ready' ? '' : ` — ${statusText(sc, p)}`
                        return { value: sid, label: `${label}${multi}${state}` }
                      })
                    ]}
                  />
                  {(() => {
                    const sc = scenarioId ? scenarioStatuses[scenarioId] : null
                    if (sc) {
                      const areaName = lang === 'it'
                        ? (sc.area_it || p.areaUndefined)
                        : (sc.area_en || p.areaUndefined)
                      const isCustomArea = areaName === 'Area personalizzata' || areaName === 'Custom area'
                      return (
                        <Paper p="xs" radius="sm" style={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-divider)' }}>
                          <Stack gap={4}>
                            {[
                              [p.seedAreaName,        isCustomArea ? p.areaUndefined : areaName],
                              [p.sectionPressure,     p.pressures[sc.pressure]],
                              [p.labelStart,          sc.start_time],
                              [p.labelDuration,       `${sc.duration_days} d`],
                              [p.labelParticles,      sc.pnum?.toLocaleString()],
                              [p.labelTimeStep,       `${sc.time_step_hours} h`],
                            ].map(([label, val]) => (
                              <Group key={label} justify="space-between" gap="xs">
                                <Text size="10px" c="dimmed">{label}</Text>
                                <Text size="xs" c="blue.5" fw={500}>{val}</Text>
                              </Group>
                            ))}
                            {sc.seedings > 1 && (
                              <Group justify="space-between" gap="xs" mt={2}>
                                <Text size="10px" c="dimmed">{p.labelMultiSeeding}</Text>
                                <Badge size="xs" variant="light" color="violet">{sc.seedings}× / {sc.tshift}d</Badge>
                              </Group>
                            )}
                            {sc.description && (
                              <Text size="xs" c="dimmed" mt={4} style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 4, lineHeight: 1.5 }}>
                                {sc.description}
                              </Text>
                            )}
                          </Stack>
                        </Paper>
                      )
                    }
                    return <Text size="xs" c="dimmed" ta="center">{p.sectionExistingDesc}</Text>
                  })()}
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
                  {/* ── Nuova simulazione ──────────────────────────── */}
                  <Group justify="space-between" gap="xs" style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 8 }}>
                    <Text size="xs" fw={700} c="blue.4" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                      {p.sectionNewScenario}
                    </Text>
                    {access.locked && (
                      <Button size="compact-xs" variant="subtle" color="gray" type="button"
                              leftSection={<IconLockOpen size={12} />} onClick={handleLock}>
                        {p.access.lock}
                      </Button>
                    )}
                  </Group>

                  <TextInput
                    size="xs"
                    label={p.labelTitle}
                    placeholder={p.labelTitleHint}
                    value={customLabel}
                    onChange={e => setCustomLabel(e.target.value)}
                    styles={LABEL_STYLES}
                  />

                  <Textarea
                    size="xs"
                    label={p.labelDesc}
                    placeholder={p.labelDescHint}
                    value={customDesc}
                    onChange={e => setCustomDesc(e.target.value)}
                    autosize
                    minRows={2}
                    styles={LABEL_STYLES}
                  />

                  {/* ── Multi-seeding ─────────────────────────────── */}
                  <Switch
                    size="xs"
                    label={lbl(p.multiSeedingToggle, p.tooltips.multiSeeding)}
                    checked={multiSeeding}
                    onChange={e => setMultiSeeding(e.currentTarget.checked)}
                    styles={{ label: { ...LABEL_STYLES.label, cursor: 'pointer' } }}
                  />
                  {multiSeeding && (
                    <Stack gap="xs">
                      <Group grow gap="xs">
                        <TextInput
                          type="number"
                          size="xs"
                          label={lbl(p.seedingsLabel, p.tooltips.seedingsCount)}
                          value={seedings}
                          min="2"
                          max="12"
                          onChange={e => setSeedings(e.target.value)}
                          styles={LABEL_STYLES}
                        />
                        <TextInput
                          type="number"
                          size="xs"
                          label={lbl(p.tshiftLabel, p.tooltips.tshift)}
                          value={tshift}
                          min="1"
                          max="365"
                          onChange={e => setTshift(e.target.value)}
                          styles={LABEL_STYLES}
                        />
                      </Group>
                      <Text size="10px" c="dimmed" ta="center">
                        {computeDateRange(startDate, seedings, tshift, t.controls.locale)}
                        {' · '}{seedings} run × {tshift} gg
                      </Text>
                    </Stack>
                  )}


                  {/* ── Area di seeding ───────────────────────────── */}
                  <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                    {p.seedAreaLabel}
                  </Text>
                  <SegmentedControl
                    size="xs"
                    fullWidth
                    value={seedAreaMode}
                    onChange={mode => {
                      setSeedAreaMode(mode)
                      if (mode !== 'draw') onClearSeedShape()
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
                      <Group grow gap="xs">
                        <Button
                          size="xs"
                          variant={drawMode === 'circle' ? 'filled' : 'light'}
                          color="blue"
                          px={4}
                          fz={11}
                          onClick={() => onStartDraw('circle')}
                        >
                          {p.btnCircle}
                        </Button>
                        <Button
                          size="xs"
                          variant={drawMode === 'rectangle' ? 'filled' : 'light'}
                          color="blue"
                          px={4}
                          fz={11}
                          onClick={() => onStartDraw('rectangle')}
                        >
                          {p.btnRect}
                        </Button>
                        <Button
                          size="xs"
                          variant={drawMode === 'polygon' ? 'filled' : 'light'}
                          color="blue"
                          px={4}
                          fz={11}
                          onClick={() => onStartDraw('polygon')}
                        >
                          {p.btnPolygon}
                        </Button>
                      </Group>
                      {drawMode === 'circle'    && <Text size="xs" c="dimmed" ta="center">{p.hintCircle}</Text>}
                      {drawMode === 'rectangle' && <Text size="xs" c="dimmed" ta="center">{p.hintRect}</Text>}
                      {drawMode === 'polygon'   && (
                        <PolygonDrawControls
                          seedShape={seedShape}
                          labels={p}
                          onUndo={onUndoLastPolygon}
                          onFinish={onFinishDraw}
                        />
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
                      {!drawMode && !seedShape && <Text size="xs" c="dimmed" ta="center">{p.hintNoShape}</Text>}
                      <TextInput
                        size="xs"
                        label={p.labelSeedName}
                        placeholder={p.labelSeedNameHint}
                        value={seedAreaName}
                        onChange={e => setSeedAreaName(e.target.value)}
                        styles={LABEL_STYLES}
                      />
                    </Stack>
                  )}

                  {seedAreaMode === 'upload' && (
                    <Button
                      size="xs"
                      variant="light"
                      color="blue"
                      fullWidth
                      onClick={() => fileRef.current?.click()}
                      style={{ height: 'auto', padding: '12px 8px' }}
                    >
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
                                } catch {}
                              }}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '6px 10px',
                                border: 'none',
                                borderBottom: '1px solid var(--modal-divider)',
                                background: selectedT4mspArea === area.id ? 'rgba(10,132,255,0.14)' : 'transparent',
                                color: selectedT4mspArea === area.id ? '#64d2ff' : 'var(--text-secondary)',
                                fontSize: 12,
                                cursor: 'pointer',
                                textAlign: 'left',
                                width: '100%',
                              }}
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

                  {/* ── Semina per connettività (ogni modo di definire l'area) ── */}
                  <Switch
                    size="xs"
                    label={lbl(p.connSeedingToggle, p.tooltips.connSeeding)}
                    checked={connSeeding}
                    onChange={e => setConnSeeding(e.currentTarget.checked)}
                    styles={{ label: { ...LABEL_STYLES.label, cursor: 'pointer' } }}
                  />
                  {connSeeding && (
                    <Stack gap={4}>
                      <TextInput
                        type="number"
                        size="xs"
                        label={lbl(p.connSeedingLabel, p.tooltips.connSeedingNum)}
                        value={pnumPerPolygon}
                        min="10"
                        max={MAX_PER_POLYGON}
                        onChange={e => setPnumPerPolygon(e.target.value)}
                        styles={LABEL_STYLES}
                      />
                      <Text size="10px" c="dimmed">{p.connSeedingHint}</Text>
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

                  {/* ── Tipo di pressione ─────────────────────────── */}
                  <Group gap={4} align="center">
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                      {p.sectionPressure}
                    </Text>
                    <InfoTooltip text={p.tooltips.sectionPressure} />
                  </Group>
                  <SimpleGrid cols={2} spacing="xs">
                    {PRESSURES.map(pr => (
                      <Button
                        key={pr.key}
                        size="xs"
                        variant={pressure === pr.key ? 'filled' : 'light'}
                        color="blue"
                        onClick={() => setPressure(pr.key)}
                      >
                        {p.pressures[pr.key]}
                      </Button>
                    ))}
                  </SimpleGrid>

                  {/* ── Parametri ──────────────────────────────────── */}
                  <TextInput
                    type="date"
                    size="xs"
                    label={lbl(p.labelStart, p.tooltips.labelStart)}
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    styles={LABEL_STYLES}
                  />
                  <Group grow gap="xs">
                    <TextInput
                      type="number"
                      size="xs"
                      label={lbl(p.labelDuration, p.tooltips.labelDuration)}
                      value={durationDays}
                      min="1"
                      max="730"
                      onChange={e => setDurationDays(e.target.value)}
                      styles={LABEL_STYLES}
                    />
                    <TextInput
                      type="number"
                      size="xs"
                      label={lbl(p.labelParticles, p.tooltips.labelParticles)}
                      value={usesPerPolygon ? '' : pnum}
                      placeholder={usesPerPolygon ? p.connSeedingOverride : undefined}
                      disabled={usesPerPolygon}
                      min="10"
                      max={MAX_PARTICLES}
                      onChange={e => setPnum(e.target.value)}
                      styles={LABEL_STYLES}
                    />
                  </Group>
                  <Group
                    gap={4}
                    align="center"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setShowAdvanced(v => !v)}
                  >
                    <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em', flex: 1 }}>
                      {p.advancedLabel}
                    </Text>
                    {showAdvanced
                      ? <IconChevronUp size={12} style={{ color: 'var(--text-secondary)' }} />
                      : <IconChevronDown size={12} style={{ color: 'var(--text-secondary)' }} />}
                  </Group>
                  <Collapse expanded={showAdvanced}>
                    <Stack gap="xs">
                      <NativeSelect
                        size="xs"
                        label={lbl(p.labelTimeStep, p.tooltips.labelTimeStep)}
                        value={timeStepHours}
                        onChange={e => setTimeStepHours(e.target.value)}
                        data={TIME_STEPS}
                        styles={LABEL_STYLES}
                      />
                      <TextInput
                        type="number"
                        size="xs"
                        label={lbl(p.labelCmemsMargin, p.tooltips.labelCmemsMargin)}
                        value={cmemsMargin}
                        min="0"
                        max="20"
                        step="any"
                        onChange={e => setCmemsMargin(e.target.value)}
                        styles={LABEL_STYLES}
                      />
                    </Stack>
                  </Collapse>

                  <Text
                    size="10px"
                    c={ncColor}
                    p="xs"
                    style={{ background: ncBg, borderRadius: 6, borderLeft: `2px solid ${ncBorder}`, lineHeight: 1.4 }}
                  >
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
          </Tabs.Panel>

          {/* ══════════════════════════════════════════════════════════ */}
          {/* ── TAB ANALISI ─────────────────────────────────────────── */}
          {/* ══════════════════════════════════════════════════════════ */}
          <Tabs.Panel value="scenario">
            <Stack gap="sm" pt="sm">

              {/* ── Info simulazione selezionata ─────────────── */}
              {(() => {
                const sc = scenarioStatuses[scenarioId]
                if (!sc || sc.status !== 'ready') {
                  return <Text size="xs" c="dimmed" ta="center">{p.hintNoScenario}</Text>
                }
                const areaName = lang === 'it'
                  ? (sc.area_it || p.areaUndefined)
                  : (sc.area_en || p.areaUndefined)
                const isCustomArea = areaName === 'Area personalizzata' || areaName === 'Custom area'
                return (
                  <Paper p="xs" radius="sm" style={{ background: 'var(--modal-bg)', border: '1px solid var(--modal-divider)' }}>
                    <Stack gap={4}>
                      {[
                        [p.seedAreaName,          isCustomArea ? p.areaUndefined : areaName],
                        [p.sectionPressure,        p.pressures[sc.pressure]],
                        [p.labelStart,             sc.start_time],
                        [p.labelDuration,          `${sc.duration_days} d`],
                        [p.labelParticles,         sc.pnum?.toLocaleString()],
                        // Solo per gli scenari seminati per poligono: è l'informazione
                        // che dice se lo scenario è un buon input per la connettività.
                        ...(sc.seeding_mode === 'per_polygon'
                          ? [[p.labelSeedingPerPoly,
                              `${sc.pnum_per_polygon?.toLocaleString()} × ${sc.n_polygons}`]]
                          : []),
                        [p.labelTimeStep,          `${sc.time_step_hours} h`],
                      ].map(([label, val]) => (
                        <Group key={label} justify="space-between" gap="xs">
                          <Text size="10px" c="dimmed">{label}</Text>
                          <Text size="xs" c="blue.5" fw={500}>{val}</Text>
                        </Group>
                      ))}
                      {sc.seedings > 1 && (
                        <Group justify="space-between" gap="xs" mt={2}>
                          <Text size="10px" c="dimmed">{p.labelMultiSeeding}</Text>
                          <Badge size="xs" variant="light" color="violet">{sc.seedings}× / {sc.tshift}d</Badge>
                        </Group>
                      )}
                      {sc.description && (
                        <Text size="xs" c="dimmed" mt={4} style={{ borderTop: '1px solid var(--modal-divider)', paddingTop: 4, lineHeight: 1.5 }}>
                          {sc.description}
                        </Text>
                      )}
                    </Stack>
                  </Paper>
                )
              })()}

              {/* ── Titolo dell'analisi (comune a Sorgenti e Connettività) ── */}
              <TextInput
                size="xs"
                label={t.analyses.titleLabel}
                placeholder={autoTitle}
                value={analysisTitle}
                onChange={e => setAnalysisTitle(e.target.value)}
                maxLength={80}
                styles={LABEL_STYLES}
              />

              {/* ── Sotto-tab: Sorgenti | Connettività ─────────── */}
              <Tabs value={analysisMode} onChange={setAnalysisMode} variant="pills" radius="sm">
                <Tabs.List grow style={{ flexWrap: 'nowrap' }}>
                  <Tabs.Tab value="sources" fz="xs" px={6}>{p.connectivity.subTabSources}</Tabs.Tab>
                  <Tabs.Tab value="connectivity" fz="xs" px={6}>{p.connectivity.subTabConnectivity}</Tabs.Tab>
                  <Tabs.Tab value="markov" fz="xs" px={6}>{p.markov.subTab}</Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="sources">
                  <Stack gap="sm" pt="sm">

              {/* ── Layer sorgente ────────────────────────────── */}
              <Group gap={4} align="center">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                  {p.sectionUse}
                </Text>
                <InfoTooltip text={p.tooltips.sectionUse} />
              </Group>
              {renderSourceGroups(false)}

              {/* ── Risoluzione + Margine ─────────────────────── */}
              <NativeSelect
                size="xs"
                label={lbl(p.labelRes, p.tooltips.labelRes)}
                value={res}
                onChange={e => setRes(e.target.value)}
                data={RESOLUTIONS}
                styles={LABEL_STYLES}
              />
              <TextInput
                type="number"
                size="xs"
                label={lbl(p.labelMargin, p.tooltips.labelMargin)}
                value={margin}
                min="0"
                max="20"
                step="any"
                onChange={e => setMargin(e.target.value)}
                styles={LABEL_STYLES}
              />
                  </Stack>
                </Tabs.Panel>

                {/* ── Sotto-tab Connettività ───────────────────── */}
                <Tabs.Panel value="connectivity">
                  <Stack gap="sm" pt="sm">

                    {/* Da dove vengono i nodi della rete */}
                    <SegmentedControl
                      size="xs"
                      fullWidth
                      value={connSource}
                      onChange={setConnSource}
                      data={[
                        { value: 'shapefile', label: p.connectivity.sourceShapefile },
                        { value: 'grid',      label: p.connectivity.sourceGrid },
                      ]}
                      color="teal"
                    />

                    {connSource === 'shapefile' ? (
                      <>
                        <Button
                          size="xs"
                          variant="light"
                          color={connShpB64 ? 'teal' : 'blue'}
                          type="button"
                          onClick={() => connFileRef.current?.click()}
                        >
                          {connShpName || p.connectivity.uploadHint}
                        </Button>
                        <input
                          ref={connFileRef}
                          type="file"
                          accept=".zip"
                          style={{ display: 'none' }}
                          onChange={handleConnFileChange}
                        />
                      </>
                    ) : (
                      <Stack gap="xs">
                        <NativeSelect
                          size="xs"
                          label={lbl(p.connectivity.gridResLabel, p.tooltips.connGridRes)}
                          value={connRes}
                          onChange={e => setConnRes(e.target.value)}
                          data={GRID_RESOLUTIONS}
                          styles={LABEL_STYLES}
                        />
                        <Text size="11px" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                          {lbl(p.connectivity.bboxLabel, p.tooltips.connBbox)}
                        </Text>
                        <SimpleGrid cols={2} spacing={6}>
                          {[0, 1, 2, 3].map(i => (
                            <TextInput
                              key={i}
                              type="number"
                              size="xs"
                              step="any"
                              placeholder={p.connectivity.bboxFields[i]}
                              value={connBbox[i]}
                              onChange={e => setConnBbox(b => b.map((v, j) => (j === i ? e.target.value : v)))}
                              styles={LABEL_STYLES}
                            />
                          ))}
                        </SimpleGrid>
                        <Text size="10px" c={connCellsEstimate > 300 ? 'orange.4' : 'dimmed'}>
                          {connBboxValid
                            ? p.connectivity.cellsEstimate.replace('{n}', connCellsEstimate)
                            : p.connectivity.bboxEmptyHint}
                        </Text>
                      </Stack>
                    )}

                    <SegmentedControl
                      size="xs"
                      fullWidth
                      value={connMode}
                      onChange={setConnMode}
                      data={[
                        { value: 'transition', label: p.connectivity.modeTransition },
                        { value: 'passage',    label: p.connectivity.modePassage },
                      ]}
                    />

                    <TextInput
                      type="number"
                      size="xs"
                      label={lbl(p.connectivity.horizonLabel, p.tooltips.connHorizon)}
                      value={connDays}
                      min="1"
                      step="any"
                      placeholder={String(scenarioStatuses[scenarioId]?.duration_days ?? '')}
                      onChange={e => setConnDays(e.target.value)}
                      styles={LABEL_STYLES}
                    />

                    {/* Le celle della griglia hanno già un'etichetta r<riga>c<colonna> */}
                    {connSource === 'shapefile' && (
                      <TextInput
                        size="xs"
                        label={lbl(p.connectivity.labelFieldLabel, p.tooltips.connLabelField)}
                        value={connLabelField}
                        placeholder={p.connectivity.labelFieldPlaceholder}
                        onChange={e => setConnLabelField(e.target.value)}
                        styles={LABEL_STYLES}
                      />
                    )}

                    <Group gap={6} align="center">
                      <Switch
                        size="xs"
                        checked={connSelfLoops}
                        onChange={e => setConnSelfLoops(e.currentTarget.checked)}
                      />
                      <Text size="xs" c="dimmed">{p.connectivity.selfLoopsLabel}</Text>
                      <InfoTooltip text={p.tooltips.connSelfLoops} />
                    </Group>
                  </Stack>
                </Tabs.Panel>

                {/* ── Sotto-tab Markov ─────────────────────────── */}
                <Tabs.Panel value="markov">
                  <MarkovControls
                    m={p.markov} p={p} lbl={lbl} labelStyles={LABEL_STYLES} sc={mkScenario}
                    dt={mkDt} onDtChange={setMkDt}
                    horizon={mkHorizon}
                    horizonPlaceholder={mkHorizonDefault ? String(mkHorizonDefault) : ''}
                    onHorizonChange={setMkHorizon}
                    release={mkRelease} onReleaseChange={setMkRelease}
                    res={mkRes} onResChange={setMkRes}
                    sourceGroups={renderSourceGroups(true)}
                    area={markovArea}
                    draw={markov}
                    error={mkError}
                    steps={mkSteps}
                    validUntil={+mkValidUntil.toFixed(2)}
                  />
                </Tabs.Panel>
              </Tabs>

              {/* ── Layer aggiuntivi ──────────────────────────── */}
              <Divider my={4} />
              <Stack gap="xs">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
                  {t.layersPanel.title}
                </Text>

                <Group gap="xs" align="center">
                  <Button
                    size="xs"
                    variant="light"
                    color="teal"
                    flex={1}
                    loading={natura2000Loading}
                    disabled={!hasSeedShape || natura2000Loading}
                    onClick={onFetchNatura2000}
                    type="button"
                  >
                    {t.layersPanel.natura2000Btn}
                  </Button>
                  {natura2000Geojson && (
                    <Switch
                      size="xs"
                      checked={showNatura2000}
                      onChange={onToggleNatura2000}
                    />
                  )}
                </Group>

                {!hasSeedShape && (
                  <Text size="xs" c="dimmed" ta="center">{t.layersPanel.noAreaWarning}</Text>
                )}
                {hasSeedShape && natura2000Empty && (
                  <Text size="xs" c="red.4" p="xs" style={{ background: 'rgba(239,68,68,0.07)', borderRadius: 6, borderLeft: '2px solid rgba(239,68,68,0.4)' }}>
                    {t.layersPanel.natura2000Empty}
                  </Text>
                )}
                {hasSeedShape && natura2000Geojson && !natura2000Empty && (
                  <Text size="xs" c="teal.4" p="xs" style={{ background: 'rgba(20,184,166,0.07)', borderRadius: 6, borderLeft: '2px solid rgba(20,184,166,0.45)' }}>
                    {t.layersPanel.natura2000Info}
                  </Text>
                )}
              </Stack>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Stack>
      </div>
      {actionsTarget && createPortal(actions, actionsTarget)}
    </form>
  )
}
