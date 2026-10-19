"""Catene di Markov da traiettorie lagrangiane (Bosi et al., Paper III della tesi).

Il calcolo, senza I/O: posizioni delle particelle in ingresso, matrici e mappe in
uscita. Solo numpy e scipy, così si verifica da solo (vedi la sezione Verifica in
README, "Markov process").

Notazione della tesi:

- griglia regolare di celle; pᵢⱼ = Nᵢⱼ / Nᵢ, frazione delle particelle che a t₀ stanno
  nella cella i e dopo Δt stanno nella cella j (eq. 1);
- rilascio singolo:   q(t₀ + kΔt) = q(t₀) · Mᵏ                       (eq. 2)
- rilascio continuo:  q_acc(t₀ + nΔt) = Σₖ₌₁ⁿ q(t₀) · Mᵏ             (eq. 3)
- con più seeding le matrici si combinano (M̄, eq. 4).

Scelte che vanno oltre la tesi, tutte motivate nel codice:

- **dominio** = celle con almeno una particella a t₀. Una cella senza particelle in
  partenza ha la riga tutta a zero: la massa che ci arriva sparirebbe al passo
  dopo. Togliendola dal dominio, quella massa conta subito come uscita, che è lo
  stato assorbente "fuori dal dominio" dell'eq. 8 (1 − Σⱼ pᵢⱼ);
- **particelle senza posizione** (spiaggiate, o uscite dal forcing: OpenDrift le
  scrive NaN) contano come uscite dal dominio;
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
        righe che sommano a ≤ 1 (il resto è uscito); ``cells`` gli indici di griglia
        delle D celle; ``Ni`` le particelle di ciascuna a t₀.
    """
    c0 = np.concatenate([np.asarray(c) for c in c0_list])
    c1 = np.concatenate([np.asarray(c) for c in c1_list])
    start = c0 >= 0
    Ni_full = np.bincount(c0[start], minlength=n_cells)
    cells = np.flatnonzero(Ni_full)
    if not len(cells):
        raise ValueError('no particle inside the grid at t0')
    to_dom = np.full(n_cells, -1, dtype=np.int64)
    to_dom[cells] = np.arange(len(cells))

    i = to_dom[c0[start]]
    j_cell = c1[start]
    j = np.where(j_cell >= 0, to_dom[np.clip(j_cell, 0, None)], -1)
    stay = j >= 0                       # arrivate in una cella del dominio
    D = len(cells)
    Nij = coo_array((np.ones(int(stay.sum())), (i[stay], j[stay])), shape=(D, D)).tocsr()
    Ni = Ni_full[cells].astype(float)
    M = csr_array(diags(1.0 / Ni) @ Nij)
    return M, cells, Ni


def propagate(M, q0, k_max, continuous=False):
    """Stati q₀·Mᵏ per k = 0..k_max (eq. 2), o cumulati Σᵢ₌₁ᵏ q₀·Mⁱ (eq. 3).

    Il frame 0 è sempre il rilascio q₀. Ogni passo è un prodotto vettore-matrice
    sparso: non si forma mai Mᵏ, che si riempirebbe a ogni potenza.

    Returns:
        list[np.ndarray]: k_max + 1 vettori sul dominio.
    """
    MT = M.T.tocsr()
    q = np.asarray(q0, dtype=float)
    frames = [q.copy()]
    acc = np.zeros_like(q)
    for _ in range(k_max):
        q = MT @ q
        if continuous:
            acc = acc + q
            frames.append(acc.copy())
        else:
            frames.append(q.copy())
    return frames


def particle_weights(c0, cells, Ni, q0, n_cells):
    """Peso di ogni particella perché la simulazione trasporti lo stesso q₀: la
    massa q₀ᵢ di una cella si divide fra le sue Nᵢ particelle (come i pesi PMAR)."""
    c0 = np.asarray(c0)
    to_dom = np.full(n_cells, -1, dtype=np.int64)
    to_dom[cells] = np.arange(len(cells))
    d = np.where(c0 >= 0, to_dom[np.clip(c0, 0, None)], -1)
    w = np.zeros(len(c0), dtype=float)
    ok = d >= 0
    w[ok] = np.asarray(q0, dtype=float)[d[ok]] / np.asarray(Ni, dtype=float)[d[ok]]
    return w


def reference_map(ck_list, w_list, cells, n_cells):
    """Mappa della simulazione: somma dei pesi delle particelle che a quell'istante
    stanno in ciascuna cella del dominio (fuori dominio = uscite)."""
    to_dom = np.full(n_cells, -1, dtype=np.int64)
    to_dom[cells] = np.arange(len(cells))
    out = np.zeros(len(cells), dtype=float)
    for ck, w in zip(ck_list, w_list):
        ck = np.asarray(ck)
        d = np.where(ck >= 0, to_dom[np.clip(ck, 0, None)], -1)
        ok = d >= 0
        out += np.bincount(d[ok], weights=w[ok], minlength=len(cells))
    return out


def error_stats(pred, ref):
    """e_max con segno (come la tesi: >0 la catena sovrastima) ed errore medio assoluto."""
    diff = np.asarray(pred) - np.asarray(ref)
    if not len(diff):
        return 0.0, 0.0
    i = int(np.argmax(np.abs(diff)))
    return float(diff[i]), float(np.mean(np.abs(diff)))


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
