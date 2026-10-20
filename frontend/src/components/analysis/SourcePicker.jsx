import { useRef } from 'react'
import { Stack, Text, Button, Loader, Group } from '@mantine/core'
import { RadioCard } from '../ui'

const EMODNET_SOURCES = ['windfarms', 'offshore_installations', 'msp_zones']

/**
 * Layer sorgente come lista di schede radio, come nel mockup: Uniform, i layer EMODnet
 * delle attività umane, un layer dell'utente. Per Propagate c'è in più l'area disegnata
 * sulla mappa (`allowArea`). `value` è la chiave scelta ('none', 'windfarms', …, 'area').
 *
 * `emodnet[key]` = { loading, empty, emptyText } dalla preview in App;
 * `geotiff` = { b64, name, onFile(file) }.
 */
export default function SourcePicker({ value, onPick, emodnet, geotiff, allowArea, area, labels }) {
  const s = labels
  const fileRef = useRef(null)

  return (
    <Stack gap={6} role="radiogroup">
      <RadioCard selected={value === 'none'} onSelect={() => onPick('none')}
                 title={s.uniform} description={allowArea ? s.uniformDescMarkov : s.uniformDesc} />

      <Text size="10px" fw={600} c="dimmed" mt={2}>{s.emodnet}</Text>
      {EMODNET_SOURCES.map(key => (
        <RadioCard key={key} selected={value === key} onSelect={() => onPick(key)}
                   title={
                     <Group gap={6} component="span" wrap="nowrap">
                       {s.names[key]}
                       {emodnet[key]?.loading && <Loader size={10} />}
                     </Group>
                   }
                   description={s.emodnetDesc[key]}>
          {emodnet[key]?.empty && (
            <Text size="10px" c="red.5" lh={1.35}>{emodnet[key].emptyText}</Text>
          )}
        </RadioCard>
      ))}

      <Text size="10px" fw={600} c="dimmed" mt={2}>{s.custom}</Text>
      <RadioCard selected={value === 'geotiff'} onSelect={() => onPick('geotiff')}
                 title={s.customName} description={s.customDesc}>
        <Button size="xs" variant="default" fullWidth type="button"
                style={{ borderStyle: 'dashed' }} onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" accept=".tif,.tiff" style={{ display: 'none' }}
                 onChange={e => { const f = e.target.files[0]; if (f) geotiff.onFile(f) }} />
          <Text size="xs" c={geotiff.b64 ? undefined : 'dimmed'} truncate>
            {geotiff.b64 ? geotiff.name : s.chooseTiff}
          </Text>
        </Button>
      </RadioCard>
      {allowArea && (
        <RadioCard selected={value === 'area'} onSelect={() => onPick('area')}
                   title={s.areaName} description={s.areaDesc}>
          {area}
        </RadioCard>
      )}
    </Stack>
  )
}
