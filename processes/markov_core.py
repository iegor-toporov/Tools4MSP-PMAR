"""Catene di Markov da traiettorie lagrangiane.

Il calcolo, senza I/O: posizioni delle particelle in ingresso, matrice e mappe in
uscita. Solo numpy e scipy. Fa lo stesso conto della libreria PMAR, verificato con
`get_cm`, `get_histogram` e `predict_with_cm` (vedi README, "Markov process"):

- griglia regolare di celle; pᵢⱼ = Nᵢⱼ / Nᵢ, frazione delle particelle che a t₀ stanno
  nella cella i e dopo Δt stanno nella cella j (`PMAR.get_cm`);
- condizione iniziale q₀ = particelle per cella a t₀ (`PMAR.get_histogram(t=0,
  dim=['trajectory'])`);
- previsione dopo k passi: q₀ · Mᵏ (`PMAR.predict_with_cm`).

Scelte motivate nel codice:

- **dominio** = celle con almeno una particella a t₀ o dopo Δt. Le altre celle della
  griglia non ricevono mai niente e restano fuori, così il vettore resta piccolo. Una
  cella raggiunta solo dopo Δt ha la riga a zero, come in `PMAR.get_cm`: la massa che
  ci arriva si vede per un passo e al passo dopo esce dalla catena;
- **particelle senza posizione** (spiaggiate, o uscite dal forcing: OpenDrift le
  scrive NaN) e quelle uscite dalla griglia escono dalla catena: le righe di M
  sommano a meno di 1, come in `PMAR.get_cm` senza buffer;
- **più seeding**: stima congiunta Σₛ Nᵢⱼ / Σₛ Nᵢ, che coincide con la media delle
  matrici quando i seeding rilasciano le stesse particelle nelle stesse celle (il
  caso di OpenDrift, che semina su una griglia di punti fissa) ed è più stabile
  quando non è così.
"""

import math

import numpy as np
from scipy.sparse import coo_array, csr_array, diags


class Grid:
    """Griglia regolare lon/lat allineata a multipli di `res`. Riga 0 = sud,
    come i raster dell'analisi PMAR."""

    def __init__(self, bounds, res):
        lon_min, lat_min, lon_max, lat_max = (float(v) for v in bounds)
        if lon_max <= lon_min or lat_max <= lat_min:
            raise ValueError(f'invalid bounds: {bounds}')
        self.res = float(res)
        # Bordi allineati: celle "tonde" e stabili fra un'analisi e l'altra.
        self.lon0 = math.floor(lon_min / res + 1e-9) * res
        self.lat0 = math.floor(lat_min / res + 1e-9) * res
        self.nx = max(1, math.ceil((lon_max - self.lon0) / res - 1e-9))
        self.ny = max(1, math.ceil((lat_max - self.lat0) / res - 1e-9))

    @property
    def size(self):
        return self.nx * self.ny

    @property
    def lon_centers(self):
        return self.lon0 + (np.arange(self.nx) + 0.5) * self.res

    @property
    def lat_centers(self):
        return self.lat0 + (np.arange(self.ny) + 0.5) * self.res

    def cell_index(self, lon, lat):
        """Indice piatto (riga * nx + colonna) di ogni posizione; -1 se è fuori dalla
        griglia o non ha posizione (NaN)."""
        lon = np.asarray(lon, dtype=float)
        lat = np.asarray(lat, dtype=float)
        col = np.floor((lon - self.lon0) / self.res)
        row = np.floor((lat - self.lat0) / self.res)
        ok = np.isfinite(col) & np.isfinite(row) & (col >= 0) & (col < self.nx) & (row >= 0) & (row < self.ny)
        idx = np.full(lon.shape, -1, dtype=np.int64)
        idx[ok] = (row[ok] * self.nx + col[ok]).astype(np.int64)
        return idx


def transition_matrix(c0_list, c1_list, n_cells):
    """Matrice di transizione sul dominio, da una o più coppie di posizioni.

    Args:
        c0_list, c1_list: per ogni seeding, indice di cella di ogni particella a t₀ e
            dopo Δt (-1 = fuori griglia o senza posizione).
        n_cells: celle della griglia.

    Returns:
        tuple: ``(M, cells, Ni)`` — M (csr, D × D) sulle sole celle del dominio, con
        righe che sommano a ≤ 1 (il resto è uscito; 0 per le celle vuote a t₀);
        ``cells`` gli indici di griglia delle D celle; ``Ni`` le particelle di
        ciascuna a t₀, sommate sui seeding (0 per le celle raggiunte solo dopo Δt).
    """
    c0 = np.concatenate([np.asarray(c) for c in c0_list])
    c1 = np.concatenate([np.asarray(c) for c in c1_list])
    start = c0 >= 0
    Ni_full = np.bincount(c0[start], minlength=n_cells)
    if not Ni_full.any():
        raise ValueError('no particle inside the grid at t0')
    reached = np.bincount(c1[c1 >= 0], minlength=n_cells)
    cells = np.flatnonzero((Ni_full > 0) | (reached > 0))
    to_dom = np.full(n_cells, -1, dtype=np.int64)
    to_dom[cells] = np.arange(len(cells))

    i = to_dom[c0[start]]
    j_cell = c1[start]
    j = np.where(j_cell >= 0, to_dom[np.clip(j_cell, 0, None)], -1)
    stay = j >= 0                       # arrivate in una cella del dominio
    D = len(cells)
    Nij = coo_array((np.ones(int(stay.sum())), (i[stay], j[stay])), shape=(D, D)).tocsr()
    Ni = Ni_full[cells].astype(float)
    inv = np.divide(1.0, Ni, out=np.zeros_like(Ni), where=Ni > 0)
    M = csr_array(diags(inv) @ Nij)
    return M, cells, Ni


def propagate(M, q0, k_max):
    """Stati q₀·Mᵏ per k = 0..k_max.

    Il frame 0 è la condizione iniziale. Ogni passo è un prodotto vettore-matrice
    sparso: non si forma mai Mᵏ, che si riempirebbe a ogni potenza (come fa
    `PMAR.predict_with_cm`).

    Returns:
        list[np.ndarray]: k_max + 1 vettori sul dominio.
    """
    MT = M.T.tocsr()
    q = np.asarray(q0, dtype=float)
    frames = [q.copy()]
    for _ in range(k_max):
        q = MT @ q
        frames.append(q.copy())
    return frames


def round_sig(a, digits=4):
    """Arrotonda a `digits` cifre significative: il payload resta leggero senza
    azzerare i valori piccoli, che su una mappa log contano quanto quelli grandi."""
    a = np.asarray(a, dtype=float)
    out = np.zeros_like(a)
    nz = np.isfinite(a) & (a != 0)
    mag = np.floor(np.log10(np.abs(a[nz])))
    scale = 10.0 ** (digits - 1 - mag)
    out[nz] = np.round(a[nz] * scale) / scale
    return out
