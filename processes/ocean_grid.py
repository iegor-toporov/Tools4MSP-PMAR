"""PMAR's `make_grid`, with the coastline read once and cut to the area.

`pmar.utils.make_grid` masks the land with the Natural Earth 10 m ocean polygons: at
every call it reads the shapefile again and clips the grid against the ocean polygon
of the whole world (about 450 000 vertices), which costs about 7 s even for a grid of
a few cells. A density analysis calls it several times (the starting grid, one per
release, and `get_histogram` builds it again inside), so with the library function
most of the time of an analysis is spent here, three times as much with four
releases.

`make_grid` below is the library code with two differences: the ocean polygons come
from a cache, and before the clip they are cut to a box that contains the grid with a
margin of two cells. Inside the grid the geometry is the same, so the mask is
identical. Importing the module also installs it in `pmar.utils` and `pmar.pmar`, so
PMAR's internal calls (`get_histogram`, `get_cm`) use it too. The original function
stays in `LIBRARY_MAKE_GRID`, for comparisons with the library as it is.
"""
import functools

import geopandas as gpd
import numpy as np
import xarray as xr
import rioxarray  # noqa: F401 — registers the .rio accessor
from shapely import box
import pmar.pmar
import pmar.utils

LIBRARY_MAKE_GRID = pmar.utils.make_grid


@functools.lru_cache(maxsize=1)
def _ocean():
    from cartopy.io import shapereader
    return gpd.read_file(shapereader.natural_earth(resolution='10m',
                                                   category='physical', name='ocean'))


def make_grid(res, study_area, crs='epsg:4326'):
    """As `pmar.utils.make_grid`, with the coastline from the cache of `_ocean`."""
    ocean = _ocean()

    xmin, ymin, xmax, ymax = study_area
    cols = np.arange(xmin, xmax + res, res)
    rows = np.arange(ymin, ymax + res, res)

    x_e = cols
    y_e = rows
    x_c = (x_e + res/2)[:-1]
    y_c = (y_e + res/2)[:-1]

    grid = xr.Dataset(coords={'x_e': x_e, 'y_e': y_e, 'x_c': x_c, 'y_c': y_c}).rio.write_crs(crs, inplace=True)
    grid['dx'] = grid['dy'] = res

    Xc, Yc = np.meshgrid(grid.x_c, grid.y_c)
    grid = grid.assign({'Xc': (('y_c', 'x_c'), Xc), 'Yc': (('y_c', 'x_c'), Yc)})

    # only the part of the ocean around the grid; the margin keeps the new edges of
    # the cut away from every cell, so all_touched does not see them
    m = 2 * res
    near = ocean.geometry.intersection(box(x_e[0] - m, y_e[0] - m, x_e[-1] + m, y_e[-1] + m))
    mask = xr.ones_like(grid.Xc).rename({'x_c': 'x', 'y_c': 'y'}).rio.clip(
        near, ocean.crs, drop=False, all_touched=True).rename({'x': 'x_c', 'y': 'y_c'})
    bin_n = mask.where(mask != 1, mask.stack(cell=('y_c', 'x_c')).where(lambda x: x == 1).cumsum('cell').unstack()) - 1

    grid['mask'] = mask
    grid['bin_n'] = bin_n
    return grid


pmar.utils.make_grid = make_grid
pmar.pmar.make_grid = make_grid
