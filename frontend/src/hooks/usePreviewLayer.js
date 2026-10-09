import { useEffect, useState } from 'react'

import { fetchFeatureLayer } from '../api/ogcProcesses'

/**
 * React adapter over {@link fetchFeatureLayer}: keeps one map overlay in sync with
 * the currently selected seeding area.
 *
 * The three EMODnet overlays differ only by process id, so they share this hook
 * rather than three copies of the same effect.
 *
 * @param {string}   processId        process to run, see `Process` in the API module
 * @param {boolean}  options.enabled  whether this overlay is the one currently selected
 * @param {?object}  options.bounds   bbox to query; must be referentially stable
 *                                    (memoize it) or the effect re-runs on every render
 * @returns {{data: ?object, loading: boolean, isEmpty: boolean}}
 */
export function usePreviewLayer(processId, { enabled, bounds }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [isEmpty, setIsEmpty] = useState(false)

  useEffect(() => {
    if (!enabled || !bounds) {
      setData(null)
      setIsEmpty(false)
      return
    }

    // Abort on re-run so a slow response for a previous area can never overwrite
    // the state of the current one.
    const controller = new AbortController()
    let cancelled = false

    setData(null)
    setIsEmpty(false)
    setLoading(true)

    fetchFeatureLayer(processId, bounds, { signal: controller.signal })
      .then(layer => {
        if (cancelled) return
        if (layer) setData(layer)
        else       setIsEmpty(true)
      })
      .catch(() => { if (!cancelled) setIsEmpty(true) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [processId, enabled, bounds])

  return { data, loading, isEmpty }
}
