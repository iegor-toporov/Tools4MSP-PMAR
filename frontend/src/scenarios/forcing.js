/**
 * Provenance of the currents of a simulation, in one line: basin, resolution, step and
 * product type of the CMEMS datasets used (`forcing_datasets.cur` of the scenario,
 * written by PrecomputeProcess). Several datasets (regional + global, or reanalysis +
 * analysis) are joined with " + ".
 *
 * Pure module: tested in forcing.test.js.
 */

/** Label, or `labels.unknown` for scenarios without provenance. */
export function forcingLabel(sc, labels) {
  const cur = sc?.forcing_datasets?.cur
  if (!cur?.length) return labels.unknown
  const one = d => {
    const step = d.step_h === 1 ? labels.hourly : d.step_h === 24 ? labels.daily
               : labels.hours.replace('{h}', d.step_h)
    const kind = d.kind === 'my' ? labels.reanalysis : labels.forecast
    return [`${labels.basins[d.basin] ?? d.basin}${d.res ? ` ${d.res}` : ''}`, step, kind].join(' · ')
  }
  return `CMEMS ${cur.map(one).join(' + ')}`
}
