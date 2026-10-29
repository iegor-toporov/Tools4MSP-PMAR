"""The Adriatic convergence campaign of ch. 5.

Three simulations differing only in particle count, so that particles per cell
at the 0.25 deg grid the interface defaults to spans an order of magnitude
around the thirty the platform recommends. Everything else is held fixed:
release area, period, releases, integration step and forcing.

The release area is the whole Adriatic basin, from the shapefile the platform
already ships, simplified at 0.01 deg. The simplification changes the area by
0.1 per cent and removes three quarters of the vertices, which matters only for
the size of the request; at a 0.25 deg analysis grid it is immaterial.

Beaching is off, as a Markov configuration requires: a stranded particle has no
position and would silently leave the chain.

Run inside the backend container, once, and expect roughly fifteen minutes of
integration after the forcing download:

    docker compose exec -T backend python -I /app/bench/adriatic_campaign.py
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, '/app/bench')
sys.path.insert(0, '/app')
import run as bench

SEA_CELLS_AT_025 = 277          # rasterised from the basin polygon
PER_CELL = (10, 30, 100)        # brackets the recommended 30

# Measured ceiling: 27 700 particles (100 per cell) against a 1.27 GB forcing
# file exhausts the 7.65 GiB container and the worker is killed. Lower targets
# are safe; anything above 30 per cell should be approached one step at a time.
OOM_AT = 27_700
COMMON = dict(
    pressure='generic',
    start_time='2024-01-02T00:00:00',
    duration_days=90,
    time_step_hours=4,
    seedings=4,
    tshift=30,
    res=0.25,
    cmems_margin=0,             # keeps the box inside the Mediterranean product
    beaching=False,
    area_name='Adriatic basin',
)


def polygon():
    import geopandas as gpd
    g = gpd.read_file('/app/scenarios/shapefiles/adriatico_t4msp.shp')
    simple = g.geometry.union_all().simplify(0.01)
    gj = json.loads(gpd.GeoSeries([simple]).to_json())['features'][0]['geometry']
    return json.dumps(gj)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--per-cell', type=int, nargs='+', default=list(PER_CELL),
                    help='particles per cell at 0.25 deg; 277 cells of sea')
    ap.add_argument('--wait', type=int, default=7200,
                    help='seconds to wait per job. The first run of a new area '
                         'also pays the forcing download, which for the whole '
                         'Adriatic over 181 days was 1.27 GB and took 2h20m, so '
                         'a two-hour limit is not enough from a cold cache.')
    args = ap.parse_args()
    geo = polygon()
    print(f'release area: {len(geo) / 1000:.0f} kB of GeoJSON')
    api = bench.Api()
    out = []
    for per_cell in args.per_cell:
        pnum = per_cell * SEA_CELLS_AT_025
        label = f'Adriatic convergence {per_cell}/cell'
        print(f'\n== {label}: {pnum} particles x {COMMON["seedings"]} releases ==')
        t0 = time.monotonic()
        if pnum >= OOM_AT:
            print(f'   refusing: {pnum} particles reached the measured memory '
                  f'ceiling of {OOM_AT} on this configuration')
            continue
        job, _ = api.submit('precompute', {**COMMON, 'geojson': geo,
                                           'pnum': pnum, 'label': label})
        rec = api.wait(job, limit=args.wait)
        wall = time.monotonic() - t0
        status = rec.get('status')
        print(f'   {status} in {wall:.0f}s')
        if status != 'successful':
            print('   ', rec.get('message', '')[:300])
            continue
        res = api.results(job)
        sid = res.get('scenario_id') or res.get('id')
        print(f'   scenario {sid}')
        out.append({'per_cell_target': per_cell, 'pnum': pnum,
                    'scenario_id': sid, 'wall_s': round(wall, 1)})
    bench.write_csv('adriatic_campaign', out)
    if out:
        print('\nnow run:')
        print('  python -I /app/bench/run.py convergence --out convergence_adriatic \\')
        print('      --res 0.25 --dt 10 --scenarios '
              + ' '.join(r['scenario_id'] for r in out))


if __name__ == '__main__':
    sys.exit(main())
