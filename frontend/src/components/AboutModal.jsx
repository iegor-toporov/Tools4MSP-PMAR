import { Modal, Stack, Text, Anchor, Title } from '@mantine/core'
import { useLang } from '../LanguageContext'

const DOI = '10.1016/j.envsoft.2025.106822'

// Collegamenti fissi: non cambiano con la lingua.
const LINKS = [
  ['tracking',   'OpenDrift', 'https://opendrift.github.io/',                        'opendrift.github.io'],
  ['forcing',    'CMEMS',     'https://data.marine.copernicus.eu/products',          'data.marine.copernicus.eu'],
  ['activities', 'EMODnet',   'https://emodnet.ec.europa.eu/en/human-activities',    'emodnet.ec.europa.eu'],
  ['pmarSource', null,        'https://github.com/CNR-ISMAR/pmar',                   'github.com/CNR-ISMAR/pmar'],
  ['uiSource',   null,        'https://github.com/iegor-toporov/Tools4MSP-PMAR',     'github.com/iegor-toporov/Tools4MSP-PMAR'],
]

/** Crediti, citazione e fonti di dati e software (icona del libro accanto al titolo). */
export default function AboutModal({ opened, onClose }) {
  const { t } = useLang()
  const a = t.about
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      centered
      size="lg"
      zIndex={200000}
      title={
        <div>
          <Title order={3} size="h4">{a.title}</Title>
          <Text size="sm" c="dimmed">{t.header.subtitle}</Text>
        </div>
      }
      closeButtonProps={{ 'aria-label': a.close }}
      styles={{
        content: { background: 'var(--modal-bg)', border: '1px solid var(--modal-border)' },
        header:  { background: 'var(--modal-bg)', alignItems: 'flex-start' },
      }}
    >
      <Stack gap="lg">
        <section>
          <Text fw={600} mb={4}>{a.credits}</Text>
          <Text size="sm">{a.developedAt}</Text>
          {a.institutions.map(i => <Text key={i} size="sm">{i}</Text>)}
        </section>

        <section>
          <Text fw={600} mb={4}>{a.cite}</Text>
          <Text size="sm" lh={1.55}>
            Bosi, S., Raffaetà, A., Simeoni, M., Bobchev, N., Berov, D., Barbanti, A., &amp; Menegon, S.
            (2025). PMAR: A Lagrangian approach to the modelling of anthropogenic pressures for marine
            management. <i>Environmental Modelling &amp; Software</i>, 106822. doi:{' '}
            <Anchor href={`https://doi.org/${DOI}`} target="_blank" rel="noreferrer">{DOI}</Anchor>
          </Text>
        </section>

        <section>
          <Text fw={600} mb={4}>{a.data}</Text>
          <Stack gap={4}>
            {LINKS.map(([key, name, href, text]) => (
              <Text key={key} size="sm">
                {a[key]}{name ? `: ${name} — ` : ': '}
                <Anchor href={href} target="_blank" rel="noreferrer">{text}</Anchor>
              </Text>
            ))}
          </Stack>
        </section>
      </Stack>
    </Modal>
  )
}
