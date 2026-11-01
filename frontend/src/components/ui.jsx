import { Tooltip, ActionIcon, Text, Group, UnstyledButton, Stack } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'
import { useLang } from '../LanguageContext'

/** Field labels: small, grey, upper case, as in the rest of the panel. */
export const LABEL_STYLES = {
  label: {
    color: 'var(--mantine-color-dimmed)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
}

/**
 * (i) icon with the explanation on mouse hover or keyboard focus, as in the mockup.
 * It is a button, so it can be reached with Tab.
 */
export function InfoTip({ text, label, size = 13 }) {
  const { t } = useLang()
  if (!text) return null
  const name = label ? t.header.infoAbout.replace('{name}', label) : t.header.info
  return (
    <Tooltip label={text} multiline w={260} withArrow position="bottom-start" withinPortal
             zIndex={100000} events={{ hover: true, focus: true, touch: true }}
             styles={{ tooltip: { fontSize: 12, lineHeight: 1.45, whiteSpace: 'pre-line' } }}>
      <ActionIcon size={18} variant="subtle" color="gray" aria-label={name}
                  onClick={e => e.preventDefault()} style={{ flexShrink: 0 }}>
        <IconInfoCircle size={size} />
      </ActionIcon>
    </Tooltip>
  )
}

/** Label with (i) next to it, for the `label` of Mantine fields. */
export function lbl(text, tip) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {text}
      {tip && <InfoTip text={tip} label={typeof text === 'string' ? text : undefined} size={12} />}
    </span>
  )
}

/** Title of a group of fields, with an optional (i). */
export function SectionLabel({ children, tip }) {
  return (
    <Group gap={2} align="center" wrap="nowrap">
      <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {children}
      </Text>
      {tip && <InfoTip text={tip} label={typeof children === 'string' ? children : undefined} size={12} />}
    </Group>
  )
}

/**
 * Single-choice card: radio circle, title, description and, when chosen, its fields.
 * The cards of a group exclude each other (the caller decides this).
 */
export function RadioCard({ selected, disabled, onSelect, title, description, tip, children }) {
  return (
    <div className={`radio-card${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}>
      <Group gap={4} wrap="nowrap" align="flex-start">
        <UnstyledButton
          className="radio-card-head"
          role="radio"
          aria-checked={selected}
          aria-disabled={disabled || undefined}
          onClick={() => { if (!disabled) onSelect() }}
        >
          <span className="radio-dot" aria-hidden="true" />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="xs" fw={500}>{title}</Text>
            {description && <Text size="10px" c="dimmed" lh={1.35}>{description}</Text>}
          </Stack>
        </UnstyledButton>
        {tip && <InfoTip text={tip} label={typeof title === 'string' ? title : undefined} size={12} />}
      </Group>
      {selected && children && <div className="radio-card-body">{children}</div>}
    </div>
  )
}

/** Read-only grey box: label–value rows. */
export function SummaryRows({ rows }) {
  return rows
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([label, val]) => (
      <Group key={label} justify="space-between" gap="xs" wrap="nowrap">
        <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>{label}</Text>
        <Text size="xs" c="blue.5" fw={500} ta="right" style={{ minWidth: 0 }} truncate>{val}</Text>
      </Group>
    ))
}
