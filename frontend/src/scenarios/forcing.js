/**
 * Provenienza delle correnti di una simulazione, in una riga: bacino, risoluzione,
 * passo e tipo di prodotto dei dataset CMEMS usati (`forcing_datasets.cur` dello
 * scenario, scritto da PrecomputeProcess). Più dataset (regionale + globale, o
 * reanalisi + analisi) si uniscono con " + ".
 *
 * Modulo puro: testato in forcing.test.js.
 */

/** Etichetta, o `labels.unknown` per gli scenari precedenti (senza provenienza). */
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
