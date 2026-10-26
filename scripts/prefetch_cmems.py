"""Scarica in anticipo le forzanti CMEMS delle simulazioni pubbliche.

Per una demo: le aree e i periodi delle simulazioni in PUBLIC_SCENARIOS (o quelle
indicate a mano) finiscono in cache, così le nuove simulazioni simili non aspettano
CMEMS. La cache si cerca per contenimento: basta che l'area e il periodo nuovi stiano
dentro quelli scaricati.

    docker compose exec simulation-worker python scripts/prefetch_cmems.py [custom_xxx ...]
"""

import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import geopandas as gpd                                       # noqa: E402

from processes import scenario_state as state                 # noqa: E402
from processes.OpenDriftProcess import fetch_forcings          # noqa: E402
from processes.PMARProcess import PRESSURE_MODELS              # noqa: E402


def main(ids):
    ids = ids or [s.strip() for s in os.environ.get('PUBLIC_SCENARIOS', '').split(',') if s.strip()]
    if not ids:
        print('Nessuno scenario: passarne gli id, o impostare PUBLIC_SCENARIOS.')
        return 1
    for sid in ids:
        sc = state.read_scenario(sid)
        if not sc:
            print(f'{sid}: non trovato')
            continue
        b = gpd.read_file(sc['shapefile']).to_crs('EPSG:4326').total_bounds
        start = datetime.fromisoformat(sc['start_time'])
        span = sc.get('tshift', 30) * (sc.get('seedings', 1) - 1) + sc['duration_days']
        t = datetime.now()
        paths, prov, _ = fetch_forcings(PRESSURE_MODELS[sc['pressure']], b[0], b[2], b[1], b[3],
                                        start, start + timedelta(days=span), sc['time_step_hours'],
                                        float(sc.get('cmems_margin', 5.0)), label=sid)
        print(f'{sid}: {len(paths)} file in {(datetime.now() - t).total_seconds():.0f}s — '
              + ', '.join(f'{f}: {d[0]["dataset_id"]}' for f, d in prov.items()))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
