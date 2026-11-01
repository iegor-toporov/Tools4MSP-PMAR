import { forwardRef, useLayoutEffect, useEffect, useRef, useState } from 'react'
import Draggable from 'react-draggable'
import { Paper, Group, ActionIcon, Text } from '@mantine/core'
import { IconX } from '@tabler/icons-react'

let _highestZ = 1000

export const FloatingWindow = forwardRef(function FloatingWindow(
  { title, onClose, stackIndex = 0, width, minWidth = 220, children },
  ref
) {
  const nodeRef = useRef(null)
  const [zIndex, setZIndex] = useState(() => ++_highestZ)

  useEffect(() => {
    const el = nodeRef.current
    if (!el) return
    let myZ = _highestZ
    const onDown = () => {
      if (myZ < _highestZ) {
        myZ = ++_highestZ
        el.style.zIndex = myZ
        setZIndex(myZ)
      }
    }
    el.addEventListener('mousedown', onDown, true)
    return () => el.removeEventListener('mousedown', onDown, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = nodeRef.current
    if (!el) return
    const { width: elW, height: elH } = el.getBoundingClientRect()
    const { innerWidth: vw, innerHeight: vh } = window
    // At the bottom, to the left of the analysis panel (16 + 310 + 16 px from the right
    // edge): on top of it, it would cover its controls.
    el.style.top  = `${Math.max(16, vh - 20 - stackIndex * 24 - elH)}px`
    el.style.left = `${Math.max(16, vw - 342 - stackIndex * 16 - elW)}px`
  }, [stackIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // The position is computed when the window opens, but the content can grow later
  // (Compare adds the chart with the second area): without this, the bottom of the
  // window, with the download button, would end up off screen.
  useEffect(() => {
    const el = nodeRef.current
    if (!el) return
    const keepInside = () => {
      const overflow = el.getBoundingClientRect().bottom - (window.innerHeight - 8)
      if (overflow > 0) el.style.top = `${Math.max(8, parseFloat(el.style.top || '0') - overflow)}px`
    }
    const ro = new ResizeObserver(keepInside)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <Draggable nodeRef={nodeRef} handle=".fw-handle" cancel=".fw-cancel">
      <Paper
        ref={el => {
          nodeRef.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        shadow="xl"
        radius="md"
        p={0}
        style={{
          position:              'fixed',
          zIndex,
          width,
          minWidth,
          minHeight:             160,
          resize:                'both',
          overflow:              'hidden',
          background:            'var(--modal-bg)',
          border:                '1px solid var(--modal-border)',
          backdropFilter:        'blur(20px) saturate(180%)',
          WebkitBackdropFilter:  'blur(20px) saturate(180%)',
        }}
      >
        <Group
          className="fw-handle"
          justify="space-between"
          align="center"
          px="sm"
          py={6}
          style={{
            borderBottom: '1px solid var(--modal-divider)',
            cursor:       'grab',
            userSelect:   'none',
          }}
        >
          <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.06em' }}>
            {title}
          </Text>
          <ActionIcon
            className="fw-cancel"
            size="xs"
            variant="subtle"
            c="dimmed"
            onClick={onClose}
          >
            <IconX size={13} />
          </ActionIcon>
        </Group>
        {children}
      </Paper>
    </Draggable>
  )
})
