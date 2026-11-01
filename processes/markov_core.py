"""Markov chains from Lagrangian trajectories.

The computation, without I/O: particle positions in, matrix and maps out. Only numpy
and scipy. It computes the same as the PMAR library, checked against `get_cm`,
`get_histogram` and `predict_with_cm` (see the README, "Markov process"):

- a regular grid of cells; pᵢⱼ = Nᵢⱼ / Nᵢ, the share of the particles that are in
  cell i at t₀ and in cell j after Δt (`PMAR.get_cm`);
- initial condition q₀ = particles per cell at t₀ (`PMAR.get_histogram(t=0,
  dim=['trajectory'])`);
- forecast after k steps: q₀ · Mᵏ (`PMAR.predict_with_cm`).

Choices explained in the code:

- **domain** = cells with at least one particle at t₀ or after Δt. The other cells of
  the grid never receive anything and are left out, so the vector stays small. A cell
  reached only after Δt has a zero row, as in `PMAR.get_cm`: the mass that arrives
  there is seen for one step and leaves the chain at the next one;
- **particles without a position** (stranded, or outside the forcing: OpenDrift writes
  them as NaN) and particles outside the grid leave the chain: the rows of M sum to
  less than 1, as in `PMAR.get_cm` without a buffer;
- **several releases**: joint estimate Σₛ Nᵢⱼ / Σₛ Nᵢ, which equals the mean of the
  matrices when the releases put the same particles in the same cells (the case of
  OpenDrift, which seeds on a fixed grid of points) and is more stable when they
  do not.
"""

import math

import numpy as np
from scipy.sparse import coo_array, csr_array, diags


class Grid:
    """Regular lon/lat grid aligned to multiples of `res`. Row 0 = south, as in the
    rasters of the PMAR analysis."""

    def __init__(self, bounds, res):
        lon_min, lat_min, lon_max, lat_max = (float(v) for v in bounds)
        if lon_max <= lon_min or lat_max <= lat_min:
            raise ValueError(f'invalid bounds: {bounds}')
        self.res = float(res)
        # Aligned edges: "round" cells that stay the same from one analysis to the next.
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
        """Flat index (row * nx + column) of each position; -1 if it is outside the
        grid or has no position (NaN)."""
        lon = np.asarray(lon, dtype=float)
        lat = np.asarray(lat, dtype=float)
        col = np.floor((lon - self.lon0) / self.res)
        row = np.floor((lat - self.lat0) / self.res)
        ok = np.isfinite(col) & np.isfinite(row) & (col >= 0) & (col < self.nx) & (row >= 0) & (row < self.ny)
        idx = np.full(lon.shape, -1, dtype=np.int64)
        idx[ok] = (row[ok] * self.nx + col[ok]).astype(np.int64)
        return idx


def transition_matrix(c0_list, c1_list, n_cells):
    """Transition matrix on the domain, from one or more pairs of positions.

    Args:
        c0_list, c1_list: for each release, the cell index of every particle at t₀ and
            after Δt (-1 = outside the grid or without a position).
        n_cells: cells of the grid.

    Returns:
        tuple: ``(M, cells, Ni)``: M (csr, D × D) on the domain cells only, with rows
        that sum to ≤ 1 (the rest has left; 0 for cells empty at t₀); ``cells`` the
        grid indices of the D cells; ``Ni`` the particles of each at t₀, summed over
        the releases (0 for cells reached only after Δt).
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
    stay = j >= 0                       # arrived in a cell of the domain
    D = len(cells)
    Nij = coo_array((np.ones(int(stay.sum())), (i[stay], j[stay])), shape=(D, D)).tocsr()
    Ni = Ni_full[cells].astype(float)
    inv = np.divide(1.0, Ni, out=np.zeros_like(Ni), where=Ni > 0)
    M = csr_array(diags(inv) @ Nij)
    return M, cells, Ni


def propagate(M, q0, k_max):
    """States q₀·Mᵏ for k = 0..k_max.

    Frame 0 is the initial condition. Each step is a sparse vector-matrix product: Mᵏ
    is never formed, because it would fill up at every power (as
    `PMAR.predict_with_cm` also avoids).

    Returns:
        list[np.ndarray]: k_max + 1 vectors on the domain.
    """
    MT = M.T.tocsr()
    q = np.asarray(q0, dtype=float)
    frames = [q.copy()]
    for _ in range(k_max):
        q = MT @ q
        frames.append(q.copy())
    return frames


def round_sig(a, digits=4):
    """Round to `digits` significant digits: the payload stays light without setting
    small values to zero, which on a log map matter as much as large ones."""
    a = np.asarray(a, dtype=float)
    out = np.zeros_like(a)
    nz = np.isfinite(a) & (a != 0)
    mag = np.floor(np.log10(np.abs(a[nz])))
    scale = 10.0 ** (digits - 1 - mag)
    out[nz] = np.round(a[nz] * scale) / scale
    return out
