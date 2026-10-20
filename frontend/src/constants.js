export const MODEL_STYLES = {
  OceanDrift: { color: '#0a84ff', fill: '#74b9ff', traj: '#4d9fff', badge: 'rgba(10,132,255,0.18)',  label: 'Tracer'  },
  PlastDrift: { color: '#ff9f0a', fill: '#ffcf6e', traj: '#ffb830', badge: 'rgba(255,159,10,0.18)', label: 'Plastic' },
  LarvalFish: { color: '#30d158', fill: '#86efac', traj: '#5de87a', badge: 'rgba(48,209,88,0.18)',  label: 'Larvae'  },
  OpenOil:    { color: '#ff453a', fill: '#ff8985', traj: '#ff6c67', badge: 'rgba(255,69,58,0.18)',  label: 'Oil'     },
}

export const MODELS = [
  { key: 'OceanDrift', name: 'Tracciante',  desc: 'Correnti superficiali'     },
  { key: 'PlastDrift', name: 'Plastica',    desc: 'Con wind drag e Stokes'    },
  { key: 'LarvalFish', name: 'Larve/uova', desc: 'Galleggiabilità verticale' },
  { key: 'OpenOil',    name: 'Idrocarburi', desc: 'Evaporazione ed emulsione' },
]

export function defaultStartTime() {
  const d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
}

// Composti noti a ChemicalDrift: deve restare allineato a CHEMICAL_COMPOUNDS in
// processes/PMARProcess.py (il primo è il default).
export const CHEMICAL_COMPOUNDS = [
  'Naphthalene', 'C1-Naphthalene', 'C2-Naphthalene', 'C3-Naphthalene',
  'Acenaphthene', 'Acenaphthylene', 'Fluorene', 'Anthracene', 'Phenanthrene',
  'C1-Phenanthrene', 'C2-Phenanthrene', 'C3-Phenanthrene', 'Dibenzothiophene',
  'C1-Dibenzothiophene', 'C2-Dibenzothiophene', 'C3-Dibenzothiophene',
  'Fluoranthene', 'Pyrene', 'Chrysene', 'Benzo-a-anthracene', 'Benzo-b-fluoranthene',
  'Benzo-k-fluoranthene', 'Benzo-a-pyrene', 'Dibenzo-ah-anthracene',
  'Benzo-ghi-perylene', 'Indeno-123cd-pyrene', 'Econea', 'Tralopyril',
]
