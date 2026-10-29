#!/usr/bin/env python3
"""Baseline for the comparison of the evaluation chapter.

This is the script a competent user has to write to obtain, without the
platform, the product the platform's dispersal analysis returns: a density
raster of particles released in an area, over a chosen period, on a chosen grid.

It is deliberately *not* a straw man. It uses the same libraries the platform
uses, takes the same shortcuts a working scientist would take, and produces a
georeferenced raster that can be opened in a GIS. What it does not do is the
work the platform does on the user's behalf: choosing a forcing product that
covers the request, caching what was downloaded, validating the result,
reporting progress, or keeping the trajectories addressable for a second
analysis.

Run:  python -I bench/baseline/dispersal_script.py
"""
import os
import sys
from datetime import datetime, timedelta

import numpy as np

# -----------------------------------------------------------------------------
# 1. What the user must decide and write by hand.
#
#    Every value below is a decision the platform either offers as a control
#    with a default, or derives. Here each is a literal in a file, and a wrong
#    one is not reported: it changes the result silently.
# -----------------------------------------------------------------------------

# Release area. Drawn on a map in the platform; here, coordinates.
AREA = [(12.4, 44.6), (13.0, 44.6), (13.0, 45.0), (12.4, 45.0)]

START_TIME = datetime(2026, 10, 1)
DURATION_DAYS = 3
N_PARTICLES = 500
TIME_STEP_H = 1

# Analysis grid.
RESOLUTION = 0.05          # degrees
STUDY_MARGIN = 1.0         # degrees around the release area

# Forcing. The product identifier has to be known: it is not discoverable from
# the task, and it is not stable. The identifier this script was first written
# with, 'cmems_mod_med_phy-cur_anfc_0.042deg_PT1H-m', was retired upstream and
# now raises DatasetNotFound; the line below is its replacement, found by
# searching the catalogue by hand. It is also a 2D product, so the depth
# arguments the previous one needed have to be dropped.
DATASET_ID = 'cmems_mod_med_phy-cur_anfc_4.2km-2D_PT1H-m'
VARIABLES = ['uo', 'vo']
FORCING_MARGIN = 2.0       # degrees of ocean data around the release area

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
FORCING_NC = os.path.join(OUT_DIR, 'forcing.nc')
TRAJ_NC = os.path.join(OUT_DIR, 'trajectories.nc')
RASTER_TIF = os.path.join(OUT_DIR, 'density.tif')


def bounds(area, margin):
    lons = [p[0] for p in area]
    lats = [p[1] for p in area]
    return (min(lons) - margin, min(lats) - margin,
            max(lons) + margin, max(lats) + margin)


# -----------------------------------------------------------------------------
# 2. Forcing retrieval.
# -----------------------------------------------------------------------------

def download_forcing():
    import copernicusmarine
    lon0, lat0, lon1, lat1 = bounds(AREA, FORCING_MARGIN)
    end = START_TIME + timedelta(days=DURATION_DAYS)
    if os.path.exists(FORCING_NC):
        print('forcing: reusing the file already on disk')
        return FORCING_NC
    print(f'forcing: downloading {DATASET_ID}')
    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=VARIABLES,
        minimum_longitude=lon0, maximum_longitude=lon1,
        minimum_latitude=lat0, maximum_latitude=lat1,
        start_datetime=START_TIME, end_datetime=end,
        output_filename=os.path.basename(FORCING_NC),
        output_directory=OUT_DIR,
        overwrite=True,
    )
    return FORCING_NC


# -----------------------------------------------------------------------------
# 3. Simulation.
# -----------------------------------------------------------------------------

def run_simulation(forcing):
    # PMAR sets PROJ_LIB on import; if this script ever imports it, the two
    # lines below are the difference between working and a stack trace in an
    # unrelated library.
    os.environ.pop('PROJ_LIB', None)
    os.environ.pop('PROJ_DATA', None)

    from opendrift.models.oceandrift import OceanDrift
    o = OceanDrift(loglevel=50)
    o.add_readers_from_list([forcing])
    # Without this, particles that touch the coast are deactivated and their
    # positions become missing values, which the analysis below must handle.
    o.set_config('general:coastline_action', 'previous')

    lons = np.array([p[0] for p in AREA] + [AREA[0][0]])
    lats = np.array([p[1] for p in AREA] + [AREA[0][1]])
    o.seed_within_polygon(lons=lons, lats=lats,
                          number=N_PARTICLES, time=START_TIME)

    if os.path.exists(TRAJ_NC):
        os.remove(TRAJ_NC)
    step = timedelta(hours=TIME_STEP_H)
    o.run(duration=timedelta(days=DURATION_DAYS),
          time_step=step, time_step_output=step, outfile=TRAJ_NC)
    return TRAJ_NC


# -----------------------------------------------------------------------------
# 4. Analysis: trajectories to a density raster.
# -----------------------------------------------------------------------------

def density_raster(traj):
    import xarray as xr
    lon0, lat0, lon1, lat1 = bounds(AREA, STUDY_MARGIN)
    nx = int(round((lon1 - lon0) / RESOLUTION))
    ny = int(round((lat1 - lat0) / RESOLUTION))

    with xr.open_dataset(traj) as ds:
        lon = ds['lon'].values.ravel()
        lat = ds['lat'].values.ravel()

    # Stranded and deactivated particles have no position. Leaving the missing
    # values in silently shifts every count.
    ok = np.isfinite(lon) & np.isfinite(lat)
    counts, _, _ = np.histogram2d(
        lat[ok], lon[ok], bins=[ny, nx],
        range=[[lat0, lat1], [lon0, lon1]])
    return counts, (lon0, lat0, lon1, lat1), nx, ny


# -----------------------------------------------------------------------------
# 5. Export: a georeferenced file a GIS can open.
# -----------------------------------------------------------------------------

def write_geotiff(counts, extent, nx, ny):
    import rasterio
    from rasterio.transform import from_origin
    lon0, lat0, lon1, lat1 = extent
    # Row 0 of a GeoTIFF is the north edge; histogram2d puts it at the south.
    data = np.flipud(counts).astype('float32')
    transform = from_origin(lon0, lat1, RESOLUTION, RESOLUTION)
    with rasterio.open(RASTER_TIF, 'w', driver='GTiff',
                       height=ny, width=nx, count=1, dtype='float32',
                       crs='EPSG:4326', transform=transform, nodata=0.0) as dst:
        dst.write(data, 1)
    return RASTER_TIF


def main():
    import time
    t0 = time.monotonic()
    forcing = download_forcing()
    t1 = time.monotonic()
    traj = run_simulation(forcing)
    t2 = time.monotonic()
    counts, extent, nx, ny = density_raster(traj)
    path = write_geotiff(counts, extent, nx, ny)
    t3 = time.monotonic()

    print(f'\nforcing    {t1 - t0:7.1f}s')
    print(f'simulation {t2 - t1:7.1f}s')
    print(f'analysis   {t3 - t2:7.1f}s')
    print(f'total      {t3 - t0:7.1f}s')
    print(f'raster     {nx}x{ny} cells, {counts.sum():.0f} particle-positions')
    print(f'written    {path}')


if __name__ == '__main__':
    sys.exit(main())
