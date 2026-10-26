"""Controlla il registro dei dataset CMEMS (data/cmems_datasets.py) contro il catalogo.

Rilegge il catalogo (lo salva anche in cache/cmems_catalog.json, che la scelta dei
dataset usa) e segnala: dataset spariti o rinominati, variabili mancanti, versioni con
una data di ritiro. Esce con 1 se un dataset del registro non c'è più.

    docker compose exec backend python scripts/check_cmems_catalog.py

All'avvio del backend gira in background (scripts/entrypoint.sh) e scrive solo nel log.
"""

import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data import cmems_select as cms              # noqa: E402
from data.cmems_datasets import REGISTRY          # noqa: E402

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('check_cmems_catalog')


def main():
    catalog = cms.refresh_catalog()
    datasets = catalog['datasets']
    missing, no_vars, retiring = [], [], []
    for e in REGISTRY:
        info = datasets.get(e['dataset_id'], {})
        if 'error' in info:
            missing.append((e['dataset_id'], info['error']))
            continue
        lacking = [v for v in e['variables'] if v not in info.get('variables', [])]
        if lacking:
            no_vars.append((e['dataset_id'], lacking))
        if info.get('retirement'):
            retiring.append((e['dataset_id'], info['retirement']))
    for did, err in sorted(set(missing)):
        log.warning(f'CMEMS dataset not available: {did} — {err}')
    for did, lacking in sorted(set((d, tuple(v)) for d, v in no_vars)):
        log.warning(f'CMEMS dataset {did} lacks variables {list(lacking)}')
    # Raggruppati per data: di solito un prodotto intero cambia versione lo stesso giorno.
    by_date = {}
    for did, when in set(retiring):
        by_date.setdefault(when, []).append(did)
    for when, dids in sorted(by_date.items()):
        log.info(f'CMEMS version retiring on {when} (same IDs, newer version afterwards; '
                 f'recheck then): {len(dids)} datasets, e.g. {sorted(dids)[0]}')
    n = len({e["dataset_id"] for e in REGISTRY})
    log.info(f'CMEMS registry check: {n} datasets, {len(set(missing))} not available, '
             f'{len(set(d for d, _ in no_vars))} with missing variables, {len(set(retiring))} retiring')
    return 1 if missing or no_vars else 0


if __name__ == '__main__':
    sys.exit(main())
