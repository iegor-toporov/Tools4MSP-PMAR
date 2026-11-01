import hashlib
import logging
import math
import os
import uuid
import numpy as np
from datetime import datetime, timedelta

from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

_ROOT     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR   = os.path.join(_ROOT, 'out')
CACHE_DIR = os.path.join(_ROOT, 'cache')


# ── Forcing cache accounting ─────────────────────────────────────────────────
# How many requests were served from disk and how many needed a download, with the
# bytes downloaded. It measures how well the cache works (the "Evaluation" chapter):
# `PrecomputeProcess` resets the counters at the start of a simulation and saves them
# in the scenario record at the end.
#
# The state belongs to the module, so to the process: this is correct for
# simulations, which run on the dedicated worker with concurrency 1. Code that shares
# the process with other tasks must not read it.
_CACHE_STATS = {'hits': 0, 'misses': 0, 'miss_paths': []}


def reset_cache_stats():
    """Reset the cache counters. Call it at the start of a simulation."""
    _CACHE_STATS.update(hits=0, misses=0, miss_paths=[])


def note_cache(hit, path=None):
    """Record the outcome of a cache lookup."""
    if hit:
        _CACHE_STATS['hits'] += 1
    else:
        _CACHE_STATS['misses'] += 1
        if path:
            _CACHE_STATS['miss_paths'].append(path)


def cache_stats():
    """Current counters. The bytes are measured now, after the download has finished."""
    downloaded = sum(os.path.getsize(f) for f in _CACHE_STATS['miss_paths']
                     if os.path.exists(f))
    return {
        'hits': _CACHE_STATS['hits'],
        'misses': _CACHE_STATS['misses'],
        'downloaded_mb': round(downloaded / 1e6, 1),
    }
_LOG_DIR  = os.path.join(_ROOT, 'logs')
os.makedirs(OUT_DIR,   exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(_LOG_DIR,  exist_ok=True)

from processes.logging_utils import setup_logger
from processes.access import is_unlocked, require_unlocked
logger = setup_logger('opendrift_process', 'opendrift', 'opendrift.log')


# ── Available models with UI metadata ───────────────────────────────────────
AVAILABLE_MODELS = {
    'OceanDrift': {
        'label':          'Passive tracer',
        'description':    'Passive particles carried only by the surface currents.',
        'module':         'opendrift.models.oceandrift',
        'class':          'OceanDrift',
        'needs_wind':     False,
        'needs_vertical': False,
        'max_depth':      0.5,
    },
    'PlastDrift': {
        'label':          'Plastic',
        'description':    'Plastic debris with buoyancy, Stokes drift and wind drag.',
        'module':         'opendrift.models.plastdrift',
        'class':          'PlastDrift',
        'needs_wind':     True,
        'needs_waves':    True,
        'needs_vertical': False,
        'max_depth':      0.5,
    },
    'LarvalFish': {
        'label':          'Fish larvae/eggs',
        'description':    'Fish larvae and eggs with vertical buoyancy and turbulent mixing.',
        'module':         'opendrift.models.larvalfish',
        'class':          'LarvalFish',
        'needs_wind':     False,
        'needs_vertical': True,
        'max_depth':      200.0,
    },
    'OpenOil': {
        'label':          'Hydrocarbons (oil)',
        'description':    'Oil spill with evaporation, emulsification and dispersion.',
        'module':         'opendrift.models.openoil',
        'class':          'OpenOil',
        'needs_wind':     True,
        'needs_waves':    True,
        'needs_thermo':   True,
        'needs_vertical': True,
        'max_depth':      50.0,
    },
}

PROCESS_METADATA = {
    'version': '0.5.0',
    'id': 'opendrift',
    'title': {'en': 'OpenDrift Simulation'},
    'description': {'en': 'Lagrangian particle tracking with real CMEMS ocean currents.'},
    'jobControlOptions': ['async-execute'],
    'keywords': ['opendrift', 'drift', 'particles', 'ocean', 'cmems'],
    'inputs': {
        'seeding_type': {
            'title': 'Seeding type',
            'description': '"circle" (default) or "rectangle".',
            'schema': {'type': 'string', 'default': 'circle'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lon': {
            'title': 'Longitude (circle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lat': {
            'title': 'Latitude (circle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'radius': {
            'title': 'Seed radius in metres (circle)',
            'schema': {'type': 'number', 'default': 1000},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lon_min': {
            'title': 'West longitude (rectangle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lon_max': {
            'title': 'East longitude (rectangle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lat_min': {
            'title': 'South latitude (rectangle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'lat_max': {
            'title': 'North latitude (rectangle)',
            'schema': {'type': 'number'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'model': {
            'title': 'Drift model',
            'description': f'One of: {", ".join(AVAILABLE_MODELS.keys())}. Default: OceanDrift.',
            'schema': {'type': 'string', 'default': 'OceanDrift'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'start_time': {
            'title': 'Start time',
            'description': 'ISO 8601 datetime. Defaults to 3 days ago.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'number': {
            'title': 'Number of particles',
            'schema': {'type': 'integer', 'default': 100},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'duration_hours': {
            'title': 'Duration (hours)',
            'schema': {'type': 'number', 'default': 24},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'access_token': {
            'title': 'Access token',
            'description': 'Only needed when the deployment runs in restricted mode: '
                           'without a valid token the operations that consume substantial '
                           'compute are refused. Removed from the payload on first read, so '
                           'it never reaches the logs, the task queue or the simulation.',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'trajectory': {
            'title': 'Trajectory data',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


class OpenDriftProcessor(BaseProcessor):
    """OGC API Process that runs an OpenDrift Lagrangian simulation driven by CMEMS ocean data."""

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        """Execute an OpenDrift Lagrangian simulation and return particle trajectories.

        Resolves the seeding geometry (circle or rectangle), downloads the required CMEMS
        forcing fields (currents; optionally wind, waves, T/S) with file-level caching,
        runs the selected OpenDrift model, and serialises the resulting trajectories
        including stranding events.

        Args:
            data (dict): OGC API input payload. Key parameters:

                - ``model`` (str): One of ``OceanDrift``, ``PlastDrift``, ``LarvalFish``,
                  ``OpenOil``. Default: ``OceanDrift``.
                - ``seeding_type`` (str): ``'circle'`` (default) or ``'rectangle'``.
                - ``lon`` / ``lat`` / ``radius`` (float): Centre and radius (m) for circle seeding.
                - ``lon_min`` / ``lon_max`` / ``lat_min`` / ``lat_max`` (float): Extent for
                  rectangle seeding.
                - ``start_time`` (str): ISO 8601 start datetime.
                - ``duration_hours`` (float): Simulation duration in hours.
                - ``number`` (int): Number of particles (capped at 10 000).
        Returns:
            tuple[str, dict]: ``('application/json', result)`` where *result* contains
            ``times`` (list of ISO datetime strings), ``steps`` (per-timestep particle
            position arrays), and ``model`` (model identifier).

        Raises:
            ProcessorExecuteError: On invalid inputs, CMEMS download failure, or if the
                seeding area falls entirely on land or outside the CMEMS domain.
        """
        require_unlocked(is_unlocked(data))

        seeding_type   = data.get('seeding_type', 'circle')
        model_name     = data.get('model', 'OceanDrift')
        number         = min(int(data.get('number', 100)), 10000)
        duration_hours = float(data.get('duration_hours', 24))

        if model_name not in AVAILABLE_MODELS:
            raise ProcessorExecuteError(
                f'Unknown model "{model_name}". '
                f'Available: {", ".join(AVAILABLE_MODELS.keys())}'
            )
        model_meta = AVAILABLE_MODELS[model_name]

        start_time_str = data.get('start_time')
        if start_time_str:
            try:
                start_time = datetime.fromisoformat(start_time_str)
            except ValueError:
                raise ProcessorExecuteError(
                    f'Invalid start_time: {start_time_str!r}. Use ISO 8601.'
                )
        else:
            start_time = datetime.utcnow() - timedelta(days=3)

        end_time  = start_time + timedelta(hours=duration_hours)
        nc_output = os.path.join(OUT_DIR, f'opendrift_{uuid.uuid4().hex}.nc')

        if seeding_type == 'rectangle':
            try:
                lon_min = float(data['lon_min'])
                lon_max = float(data['lon_max'])
                lat_min = float(data['lat_min'])
                lat_max = float(data['lat_max'])
            except (KeyError, ValueError) as e:
                raise ProcessorExecuteError(
                    f'Rectangle seeding requires lon_min, lon_max, lat_min, lat_max: {e}'
                )
            logger.info(
                f'Starting simulation: model={model_name}, seeding=rectangle, '
                f'bbox=[{lon_min:.3f},{lat_min:.3f} → {lon_max:.3f},{lat_max:.3f}], '
                f'start={start_time.isoformat()}, duration={duration_hours}h, particles={number}'
            )
        else:
            lon = data.get('lon')
            lat = data.get('lat')
            if lon is None or lat is None:
                raise ProcessorExecuteError('Circle seeding requires lon and lat')
            lon    = float(lon)
            lat    = float(lat)
            radius = float(data.get('radius', 1000))
            r_deg  = radius / 111320.0
            lon_min, lon_max = lon - r_deg, lon + r_deg
            lat_min, lat_max = lat - r_deg, lat + r_deg
            logger.info(
                f'Starting simulation: model={model_name}, seeding=circle, '
                f'lon={lon}, lat={lat}, radius={radius}m, '
                f'start={start_time.isoformat()}, duration={duration_hours}h, particles={number}'
            )

        # Duration in hours: hourly step.
        forcing_paths, _, _ = fetch_forcings(model_meta, lon_min, lon_max, lat_min, lat_max,
                                             start_time, end_time, time_step_hours=1)
        logger.debug(f'Forcing files: {forcing_paths}')

        try:
            o = _build_model(model_name, model_meta)
            o.add_readers_from_list(forcing_paths)

            if seeding_type == 'rectangle':
                lons = np.random.uniform(lon_min, lon_max, number)
                lats = np.random.uniform(lat_min, lat_max, number)
                o.seed_elements(lon=lons, lat=lats, number=number, time=start_time)
            else:
                o.seed_elements(lon=lon, lat=lat, number=number, radius=radius, radius_type='uniform', time=start_time)

            o.run(duration=timedelta(hours=duration_hours), time_step=3600, outfile=nc_output)
            result = _read_trajectories(nc_output)
        except ValueError as e:
            logger.error(f'Simulation failed: {e}')
            if 'first timestep' in str(e):
                raise ProcessorExecuteError(
                    "The simulation stopped immediately: the seeding area is "
                    "entirely on land, or outside the domain of the CMEMS data. "
                    "Move the release point into open water."
                )
            raise ProcessorExecuteError(str(e))
        except Exception as e:
            logger.error(f'Simulation failed: {e}')
            raise
        finally:
            try:
                os.remove(nc_output)
            except OSError:
                pass

        logger.info(
            f'Simulation complete: model={model_name}, '
            f'steps={len(result["times"])}, particles={len(result["steps"][0])}'
        )
        result['model'] = model_name
        return 'application/json', result

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<OpenDriftProcessor>'


# ── Model factory ────────────────────────────────────────────────────────────

def _build_model(model_name, model_meta):
    """Instantiate and configure an OpenDrift model object.

    Imports the model class dynamically from ``model_meta['module']``, constructs the
    instance with logging suppressed (``loglevel=50``), and applies model-specific
    configuration (evaporation/emulsification for OpenOil, Stokes drift for PlastDrift,
    vertical mixing for LarvalFish).

    Args:
        model_name (str): Model key (e.g. ``'OpenOil'``).
        model_meta (dict): Entry from ``AVAILABLE_MODELS`` or ``PRESSURE_MODELS``,
            containing at least ``module`` and ``class`` keys.

    Returns:
        opendrift.models.baseoil.OpenOil | opendrift.models.oceandrift.OceanDrift | ...:
            Configured OpenDrift model instance ready for reader attachment and seeding.
    """
    import importlib
    logger.debug(f'Initialising model: {model_name}')
    module = importlib.import_module(model_meta['module'])
    cls    = getattr(module, model_meta['class'])
    o      = cls(loglevel=50)

    if model_name == 'OpenOil':
        try:
            o.set_config('processes:evaporation', True)
            o.set_config('processes:emulsification', True)
            o.set_config('processes:dispersion', False)
            if not model_meta.get('needs_vertical', False):
                o.set_config('drift:vertical_mixing', False)
        except Exception:
            pass

    elif model_name == 'PlastDrift':
        try:
            o.set_config('drift:stokes_drift', True)
            o.set_config('drift:wind_drift_factor', 0.01)
        except Exception:
            pass

    elif model_name == 'LarvalFish':
        try:
            o.set_config('drift:vertical_mixing', True)
        except Exception:
            pass

    elif model_name == 'ChemicalDrift':
        # As in the PMAR library (pmar.py, PMAR.get_trajectories): the order of the
        # settings matters, init_species/init_transfer_rates come last.
        o.set_config('drift:vertical_mixing', True)
        o.set_config('vertical_mixing:diffusivitymodel', 'windspeed_Large1994')
        o.set_config('vertical_mixing:background_diffusivity', 0.0001)
        o.set_config('chemical:sediment:resuspension_depth_uncert', 0.1)
        o.set_config('chemical:sediment:resuspension_critvel', 0.15)
        o.set_config('chemical:sediment:desorption_depth', 1.)
        o.set_config('chemical:sediment:desorption_depth_uncert', 0.1)
        o.set_config('chemical:transformations:volatilization', True)
        o.set_config('chemical:transformations:degradation', True)
        o.set_config('chemical:transformations:degradation_mode', 'OverallRateConstants')
        o.init_chemical_compound(model_meta['compound'])
        # Everything dissolved at release, as in PMAR.
        o.set_config('seed:LMM_fraction', 1)
        o.set_config('seed:particle_fraction', 0)
        o.init_species()
        o.init_transfer_rates()

    return o


# ── CMEMS forcing ────────────────────────────────────────────────────────────
#
# Which datasets: `data/cmems_select.plan_family` (registry + catalogue, no attempt in
# vain). Where: the cache in `cache/`, indexed by containment. How:
# `copernicusmarine.subset` with the time-series format, to a temporary file that is
# checked and then renamed, with retries only for network errors.

from data import cmems_select as cms

# Maximum depth downloaded for vertical models: beyond it, the volume grows with the
# levels (up to 553 MB for 31 days at 4110 m) without the particles ever getting there.
DEPTH_CAP_M = 200.0
# Waits between attempts after a network error (s). The internal HTTP retries of
# copernicusmarine (COPERNICUSMARINE_HTTPS_RETRIES, 5 by default) come first.
_RETRY_WAITS = (5, 15, 45)
# Simultaneous downloads of the families of a scenario: the total time becomes that of
# the slowest instead of the sum.
_PARALLEL = 4
_PARTIAL_DIR = os.path.join(CACHE_DIR, '.partial')
# Downloads in progress in this process. If the job is cancelled, the process ends at
# once (worker/tasks.py) and these half-written files must be removed first.
ACTIVE_PARTIALS: set = set()
# A half-written file older than the time limit of a task belongs to no live task.
_STALE_PARTIAL_S = 13 * 3600


def remove_active_partials():
    """Remove the half-written files of this process's downloads in progress."""
    import glob
    for tmp in list(ACTIVE_PARTIALS):
        for f in glob.glob(tmp + '*'):            # copernicusmarine adds a suffix
            try:
                os.remove(f)
            except OSError:
                pass


def _clear_stale_partials():
    """Remove half-written files left by downloads that can no longer be running."""
    import time
    now = time.time()
    for name in os.listdir(_PARTIAL_DIR):
        f = os.path.join(_PARTIAL_DIR, name)
        try:
            if now - os.path.getmtime(f) > _STALE_PARTIAL_S:
                os.remove(f)
        except OSError:
            pass
# "Surface" of the 3D datasets: the first model level lies between 0.49 m (global,
# Black Sea, IBI) and 1.02 m (Mediterranean). Asking for 0–0.5 m in the Mediterranean
# finds no level and the request fails.
SURFACE_DEPTH_M = 1.5
_stats_lock = __import__('threading').Lock()


def _cache_key(lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix='cur', max_depth=0.5, margin=5.0):
    """Cache key of the exact-match scheme (one file per identical request).

    The download does not use it; it is kept because `bench/run.py` (the `cachekey`
    experiment) compares it with the alternatives.
    """
    slon_min = math.floor(lon_min)
    slon_max = math.ceil(lon_max)
    slat_min = math.floor(lat_min)
    slat_max = math.ceil(lat_max)
    snap_start = start_time.replace(hour=0, minute=0, second=0, microsecond=0)
    n_days     = math.ceil((end_time - snap_start).total_seconds() / 86400) + 1
    depth_tag   = f'|{max_depth:.0f}m' if max_depth > 1.0 else ''
    depth_label = f'_{int(max_depth)}m' if max_depth > 1.0 else ''
    raw    = f'{slon_min}|{slon_max}|{slat_min}|{slat_max}|{snap_start.strftime("%Y%m%d")}|{n_days}|{suffix}{depth_tag}|m{margin:.1f}'
    digest = hashlib.md5(raw.encode()).hexdigest()[:8]
    clon = (slon_min + slon_max) // 2
    clat = (slat_min + slat_max) // 2
    label  = f'{clon:+03d}_{clat:+03d}_{snap_start.strftime("%Y%m%d")}_{n_days}d_{suffix}{depth_label}_m{margin:.1f}'
    cache_path = os.path.join(CACHE_DIR, f'cmems_{label}_{digest}.nc')
    return (cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days)


def _request_box(lon_min, lon_max, lat_min, lat_max, margin):
    """Downloaded box: the area aligned to whole degrees, plus the margin. Aligning
    makes nearby requests fall into the same file."""
    return [math.floor(lon_min) - margin, math.floor(lat_min) - margin,
            math.ceil(lon_max) + margin, math.ceil(lat_max) + margin]


def _request_period(start_time, end_time):
    """Whole days, with one extra day at the end: the last step always has data."""
    snap_start = start_time.replace(hour=0, minute=0, second=0, microsecond=0)
    n_days = math.ceil((end_time - snap_start).total_seconds() / 86400) + 1
    return snap_start, snap_start + timedelta(days=n_days), n_days


def _file_name(family, entry, box, t0, n_days, depth_max):
    """Name of the file in the cache. The tokens (`cur`, `wind`, `wav`, `tem`, `mld`,
    `bathy`, `<n>d`) are those read by `bench/run.py` (the `cachedir` experiment)."""
    import json as _json
    raw = _json.dumps([entry['dataset_id'], entry['variables'], box,
                       t0.isoformat() if t0 else None, n_days, depth_max])
    digest = hashlib.md5(raw.encode()).hexdigest()[:8]
    clon = int(math.floor((box[0] + box[2]) / 2))
    clat = int(math.floor((box[1] + box[3]) / 2))
    parts = ['cmems', f'{clon:+03d}', f'{clat:+03d}']
    if t0 is not None:
        parts += [t0.strftime('%Y%m%d'), f'{n_days}d']
    parts.append({'sal': 'tem'}.get(family, family))
    if family == 'sal':
        parts.append('so')
    parts.append(entry['basin'])
    if depth_max and depth_max > 1:
        parts.append(f'{int(depth_max)}m')
    parts.append(digest)
    return os.path.join(CACHE_DIR, '_'.join(parts) + '.nc')


def _subset(entry, box, t0, t1, depth, tmp_path):
    """`copernicusmarine.subset` with retries on network errors.

    First with the time-series format, faster for small areas and long periods
    (measured: 157 s against 317 s); if the dataset does not offer it, with the format
    chosen by the library.
    """
    import copernicusmarine
    kw = dict(dataset_id=entry['dataset_id'], variables=entry['variables'],
              minimum_longitude=box[0], maximum_longitude=box[2],
              minimum_latitude=box[1], maximum_latitude=box[3],
              output_filename=os.path.basename(tmp_path), output_directory=os.path.dirname(tmp_path),
              overwrite=True, disable_progress_bar=True,
              # The grid points that enclose the request: for the surface (0–0.5 m) the
              # first model level even when it is deeper (Med: 1.02 m), and at the edges
              # of the box the cells that cover it entirely.
              coordinates_selection_method='outside')
    if t0 is not None:
        kw.update(start_datetime=t0.strftime('%Y-%m-%dT%H:%M:%S'),
                  end_datetime=t1.strftime('%Y-%m-%dT%H:%M:%S'))
    if depth is not None:
        kw.update(minimum_depth=depth[0], maximum_depth=depth[1])
    service = 'arco-time-series' if entry['kind'] != 'static' else None
    waits = list(_RETRY_WAITS)
    while True:
        try:
            copernicusmarine.subset(service=service, **kw)
            return
        except Exception as e:                                  # noqa: BLE001
            name = type(e).__name__
            if service and ('Service' in name or 'service' in str(e).lower()):
                logger.info(f'{entry["dataset_id"]}: no {service} service, using the default one')
                service = None
                continue
            if cms.is_permanent(e) or not waits:
                raise
            wait = waits.pop(0)
            logger.warning(f'{entry["dataset_id"]}: {name}: {str(e)[:160]} — retrying in {wait}s')
            __import__('time').sleep(wait)


class _NoData(ValueError):
    """The downloaded file has no valid value in the box."""


def _validate(path, entry, need0, need1, require_full):
    """The file opens, has the variables, is not all NaN and covers the period.

    Return (start, end) of the file, or (None, None) for static fields.
    """
    import xarray as xr
    import pandas as pd
    with xr.open_dataset(path) as ds:
        missing = [v for v in entry['variables'] if v not in ds.variables]
        if missing:
            raise ValueError(f'variables {missing} missing in {os.path.basename(path)}')
        var = ds[entry['variables'][0]]
        first = var.isel(time=0) if 'time' in var.dims else var
        if not np.isfinite(first.values).any():
            raise _NoData(f'{os.path.basename(path)}: no valid value (area on land or outside the dataset?)')
        if 'time' not in ds.coords or need0 is None:
            return None, None
        tmin = pd.Timestamp(ds['time'].values.min()).to_pydatetime()
        tmax = pd.Timestamp(ds['time'].values.max()).to_pydatetime()
    step = timedelta(hours=entry['step_h'] or 24)
    if tmin > need0 + step or tmax < need1 - step:
        msg = f'{entry["dataset_id"]} covers {tmin} → {tmax}, the simulation needs {need0} → {need1}'
        if require_full:
            raise ValueError(msg)
        logger.warning(msg)
    return tmin, tmax


def _fetch_entry(family, entry, box, t0, t1, n_days, need0, need1, *, vertical,
                 depth_max, require_full):
    """Path of a file with the data of a dataset: from the cache, or downloaded and checked."""
    dmax = None
    if entry['dims'] == '3D' and family in ('cur', 'tem', 'sal'):
        dmax = depth_max if (family == 'cur' and vertical) else SURFACE_DEPTH_M
    depth = (0, dmax) if dmax is not None else None
    hit = cms.find_cached(entry['dataset_id'], entry['variables'], box,
                          need0 if family != 'bathy' else None, need1, dmax)
    if hit:
        with _stats_lock:
            note_cache(True)
        logger.info(f'{family}: cache HIT {os.path.basename(hit)} ({entry["dataset_id"]})')
        return hit
    path = _file_name(family, entry, box, t0, n_days, dmax)
    with cms.download_lock(os.path.basename(path)):
        hit = cms.find_cached(entry['dataset_id'], entry['variables'], box,
                              need0 if family != 'bathy' else None, need1, dmax)
        if hit:                                   # downloaded by another process
            return hit
        os.makedirs(_PARTIAL_DIR, exist_ok=True)
        _clear_stale_partials()
        tmp = os.path.join(_PARTIAL_DIR, os.path.basename(path))
        ACTIVE_PARTIALS.add(tmp)
        started = __import__('time').monotonic()
        logger.info(f'{family}: downloading {entry["dataset_id"]} box={box} '
                    f'{t0.date() if t0 else "static"}+{n_days if t0 else 0}d depth={depth}')
        try:
            _subset(entry, box, t0, t1, depth, tmp)
            tmin, tmax = _validate(tmp, entry, need0 if t0 else None, need1,
                                   require_full=require_full)
            os.replace(tmp, path)
        finally:
            ACTIVE_PARTIALS.discard(tmp)
            if os.path.exists(tmp):
                os.remove(tmp)
        cms.record_cached(path, {
            'family': family, 'dataset_id': entry['dataset_id'], 'variables': entry['variables'],
            'basin': entry['basin'], 'bbox': box, 'depth_max': dmax,
            'time': [tmin.isoformat(), tmax.isoformat()] if tmin else None,
        })
        with _stats_lock:
            note_cache(False, path)
        secs = __import__('time').monotonic() - started
        mb = os.path.getsize(path) / 1e6
        logger.info(f'{family}: downloaded {entry["dataset_id"]} {mb:.1f} MB in {secs:.0f}s '
                    f'({mb / max(secs, 1e-3):.2f} MB/s)')
        return path


def _fetch_family(family, box, t0, t1, n_days, need0, need1, *, hourly, vertical,
                  depth_max, catalog, required):
    """Download (or take from the cache) the files of a family of variables.

    A regional basin whose file has no data in the box (the catalogue extent is a
    rectangle, and can include sea that the model does not simulate) is excluded and
    the choice is made again without it: this costs one empty download, not the
    simulation.

    Returns:
        tuple: (paths, provenance). With no dataset available: an error if the family
        is essential (currents), otherwise empty lists.
    """
    excluded = set()
    while True:
        choices = cms.plan_family(family, box, need0, need1, hourly=hourly, vertical=vertical,
                                  catalog=catalog, exclude=excluded)
        if not choices:
            msg = f'No CMEMS {family} dataset covers {box} for {need0} → {need1}'
            if required:
                raise ProcessorExecuteError(msg)
            logger.warning(msg)
            return [], []
        single = len(choices) == 1 or len({c['basin'] for c in choices}) == len(choices)
        paths, empty = [], None
        for entry in choices:
            try:
                paths.append(_fetch_entry(family, entry, box, t0, t1, n_days, need0, need1,
                                          vertical=vertical, depth_max=depth_max,
                                          require_full=(family == 'cur' and single)))
            except _NoData as e:
                if entry['basin'] == 'glo':
                    raise
                logger.warning(f'{family}: {entry["dataset_id"]} has no data here ({e}); '
                               f'choosing again without basin {entry["basin"]}')
                empty = entry['basin']
                break
        if empty is None:
            return paths, [cms.describe_choice(e) for e in choices]
        excluded.add(empty)


def _max_depth_from(paths, box):
    """Maximum seabed depth (m) in the box, from the bathymetry files."""
    import xarray as xr
    best = None
    for p in paths:
        try:
            with xr.open_dataset(p) as ds:
                d = ds['deptho']
                lon = 'longitude' if 'longitude' in d.dims else 'lon'
                lat = 'latitude' if 'latitude' in d.dims else 'lat'
                sub = d.sel({lon: slice(box[0], box[2]), lat: slice(box[1], box[3])})
                v = float(np.nanmax(sub.values)) if sub.size else None
        except Exception as e:                                  # noqa: BLE001
            logger.warning(f'Bathymetry read failed ({os.path.basename(p)}): {e}')
            continue
        if v is not None and np.isfinite(v):
            best = v if best is None else max(best, v)
    return best


def fetch_forcings(model_meta, lon_min, lon_max, lat_min, lat_max, start_time, end_time,
                   time_step_hours=1, margin=5.0, label=''):
    """All the forcing of a simulation, in parallel.

    Args:
        model_meta: entry of `PRESSURE_MODELS` (or `AVAILABLE_MODELS`): `needs_wind`,
            `needs_waves`, `needs_thermo`, `needs_mld`, `needs_bathymetry`,
            `needs_vertical`, `max_depth`, `depth_cap`.
        lon_min … lat_max: release area.
        start_time, end_time: simulated period.

    Returns:
        tuple: (paths for OpenDrift, currents first; provenance per family; maximum
        depth downloaded in m).

    Raises:
        ProcessorExecuteError: if the currents are missing.
    """
    from concurrent.futures import ThreadPoolExecutor
    catalog = cms.load_catalog()
    box = _request_box(lon_min, lon_max, lat_min, lat_max, margin)
    t0, t1, n_days = _request_period(start_time, end_time)
    hourly = time_step_hours < 24
    vertical = bool(model_meta.get('needs_vertical'))
    common = dict(hourly=hourly, vertical=vertical, catalog=catalog)
    tag = f'[{label}] ' if label else ''

    # Bathymetry first: it gives the depth of the currents for vertical models.
    max_depth = model_meta.get('max_depth', 0.5)
    bathy_paths, provenance = [], {}
    if vertical or model_meta.get('needs_bathymetry'):
        try:
            bathy_paths, provenance['bathy'] = _fetch_family(
                'bathy', box, None, None, 0, None, None, depth_max=None, required=False, **common)
        except Exception as e:                                  # noqa: BLE001
            logger.warning(f'{tag}Bathymetry not available: {e}')
        if vertical:
            cap = float(model_meta.get('depth_cap', DEPTH_CAP_M))
            seafloor = _max_depth_from(bathy_paths, box)
            max_depth = min(seafloor + 10.0, cap) if seafloor is not None else min(max_depth, cap)
            logger.info(f'{tag}Currents depth: 0–{max_depth:.0f} m '
                        f'(seafloor {seafloor if seafloor is None else round(seafloor)} m, cap {cap:.0f} m)')

    families = ['cur']
    if model_meta.get('needs_wind'):
        families.append('wind')
    if model_meta.get('needs_waves'):
        families.append('wav')
    if model_meta.get('needs_thermo'):
        families += ['tem', 'sal']
    if model_meta.get('needs_mld'):
        families.append('mld')

    results = {}
    with ThreadPoolExecutor(min(_PARALLEL, len(families))) as ex:
        futures = {f: ex.submit(_fetch_family, f, box, t0, t1, n_days, start_time, end_time,
                                depth_max=max_depth, required=(f == 'cur'), **common)
                   for f in families}
        for f, fut in futures.items():
            try:
                results[f] = fut.result()
            except ProcessorExecuteError:
                raise
            except Exception as e:                              # noqa: BLE001
                if f == 'cur':
                    raise ProcessorExecuteError(f'CMEMS currents download failed: {e}')
                logger.warning(f'{tag}{f} not available, the model uses its fallback: {e}')
                results[f] = ([], [])

    paths = []
    for f in families:
        p, prov = results[f]
        paths += p
        if prov:
            provenance[f] = prov
    if model_meta.get('needs_bathymetry'):
        paths += bathy_paths
    try:
        cms.enforce_limit()
    except Exception as e:                                      # noqa: BLE001
        logger.warning(f'Cache eviction failed: {e}')
    return paths, provenance, max_depth


# ── Trajectory reader ────────────────────────────────────────────────────────

def _read_trajectories(path):
    """Parse an OpenDrift NetCDF output file into a JSON-serialisable trajectory dict.

    Reads particle positions at every timestep, detects stranding events (masked
    positions or non-zero ``status``), and keeps stranded particles frozen at their last
    valid position for frontend rendering.

    Args:
        path (str): Absolute path to the OpenDrift NetCDF output file.

    Returns:
        dict: Keys:

        - ``times`` (list[str]): ISO 8601 datetime strings, one per timestep.
        - ``steps`` (list[list]): Per-timestep list of ``[lon, lat]`` or
          ``[lon, lat, True]`` (True = stranded) for each particle, or ``None``
          for particles that exited the domain before recording a valid position.
    """
    import netCDF4 as nc4

    ds       = nc4.Dataset(path)
    lons     = ds.variables['lon'][:]
    lats     = ds.variables['lat'][:]
    time_var = ds.variables['time']
    raw_times = nc4.num2date(
        time_var[:],
        units    = time_var.units,
        calendar = getattr(time_var, 'calendar', 'standard'),
    )
    statuses = ds.variables['status'][:] if 'status' in ds.variables else None
    ds.close()

    time_strings = [
        f'{t.year:04d}-{t.month:02d}-{t.day:02d}T'
        f'{t.hour:02d}:{t.minute:02d}:{t.second:02d}'
        for t in raw_times
    ]

    n_particles, n_time = lons.shape
    lon_masked = np.ma.getmaskarray(lons)

    # For each particle: find when and where it strands or exits the domain
    strand_t   = [-1]    * n_particles  # -1 = never stranded
    strand_lon = [None]  * n_particles
    strand_lat = [None]  * n_particles

    for p in range(n_particles):
        for t in range(n_time):
            if lon_masked[p, t]:
                # Position became masked: find the last valid one
                for t2 in range(t - 1, -1, -1):
                    if not lon_masked[p, t2]:
                        strand_t[p]   = t
                        strand_lon[p] = round(float(lons[p, t2]), 6)
                        strand_lat[p] = round(float(lats[p, t2]), 6)
                        break
                break
            elif statuses is not None:
                s = statuses[p, t]
                if not np.ma.is_masked(s) and int(s) != 0:
                    # Non-zero status: stranded at this position
                    strand_t[p]   = t
                    strand_lon[p] = round(float(lons[p, t]), 6)
                    strand_lat[p] = round(float(lats[p, t]), 6)
                    break

    steps = []
    for t in range(n_time):
        positions = []
        for p in range(n_particles):
            if not lon_masked[p, t]:
                pos = [round(float(lons[p, t]), 6), round(float(lats[p, t]), 6)]
                # Mark as stranded if the flag was set at this step or earlier
                if strand_t[p] != -1 and t >= strand_t[p]:
                    pos.append(True)
                positions.append(pos)
            else:
                # Masked position: keep the particle visible at the stranding location
                if strand_lon[p] is not None:
                    positions.append([strand_lon[p], strand_lat[p], True])
                else:
                    positions.append(None)
        steps.append(positions)

    return {'times': time_strings, 'steps': steps}