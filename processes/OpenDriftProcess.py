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
_LOG_DIR  = os.path.join(_ROOT, 'logs')
os.makedirs(OUT_DIR,   exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(_LOG_DIR,  exist_ok=True)

from processes.logging_utils import setup_logger
logger = setup_logger('opendrift_process', 'opendrift', 'opendrift.log')

from data.cmems_datasets import (
    CMEMS_CURRENT_DATASETS_HOURLY,
    CMEMS_CURRENT_DATASETS_DAILY,
    CMEMS_WAVES_DATASETS,
    CMEMS_BATHY_DATASETS,
    CMEMS_THERMO_DATASETS,
    CMEMS_WIND_DATASETS,
)

# ── Available models with UI metadata ───────────────────────────────────────
AVAILABLE_MODELS = {
    'OceanDrift': {
        'label':          'Tracciante passivo',
        'description':    'Particelle passive trasportate solo dalle correnti superficiali.',
        'module':         'opendrift.models.oceandrift',
        'class':          'OceanDrift',
        'needs_wind':     False,
        'needs_vertical': False,
        'max_depth':      0.5,
    },
    'PlastDrift': {
        'label':          'Plastica',
        'description':    'Detriti plastici con galleggiabilità, deriva di Stokes e wind drag.',
        'module':         'opendrift.models.plastdrift',
        'class':          'PlastDrift',
        'needs_wind':     True,
        'needs_waves':    True,
        'needs_vertical': False,
        'max_depth':      0.5,
    },
    'LarvalFish': {
        'label':          'Larve/uova di pesce',
        'description':    'Larve e uova di pesce con galleggiabilità verticale e mixing turbolento.',
        'module':         'opendrift.models.larvalfish',
        'class':          'LarvalFish',
        'needs_wind':     False,
        'needs_vertical': True,
        'max_depth':      200.0,
    },
    'OpenOil': {
        'label':          'Idrocarburi (petrolio)',
        'description':    'Sversamento di idrocarburi con evaporazione, emulsione e dispersione.',
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
        'cmems_username': {
            'title': 'Copernicus Marine username',
            'schema': {'type': 'string'},
            'minOccurs': 0, 'maxOccurs': 1,
        },
        'cmems_password': {
            'title': 'Copernicus Marine password',
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
                - ``cmems_username`` / ``cmems_password`` (str): Optional explicit CMEMS
                  credentials; fall back on environment variables if omitted.

        Returns:
            tuple[str, dict]: ``('application/json', result)`` where *result* contains
            ``times`` (list of ISO datetime strings), ``steps`` (per-timestep particle
            position arrays), and ``model`` (model identifier).

        Raises:
            ProcessorExecuteError: On invalid inputs, CMEMS download failure, or if the
                seeding area falls entirely on land or outside the CMEMS domain.
        """
        seeding_type   = data.get('seeding_type', 'circle')
        model_name     = data.get('model', 'OceanDrift')
        number         = min(int(data.get('number', 100)), 10000)
        duration_hours = float(data.get('duration_hours', 24))

        cmems_creds = None
        u = (data.get('cmems_username') or '').strip()
        p = (data.get('cmems_password') or '').strip()
        if u and p:
            cmems_creds = {'username': u, 'password': p}

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

        max_depth = model_meta.get('max_depth', 0.5)
        if model_meta.get('needs_vertical'):
            dynamic = _get_max_depth_for_area(lon_min, lon_max, lat_min, lat_max, cmems_creds=cmems_creds)
            if dynamic is not None:
                max_depth = dynamic
                logger.info(f'Dynamic depth for {model_name}: {max_depth:.0f} m')
            else:
                logger.warning(f'Bathymetry not available for {model_name}, using default {max_depth:.0f} m')
        forcing_paths = [_get_forcing_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, max_depth=max_depth, cmems_creds=cmems_creds)]
        if model_meta['needs_wind']:
            wind_path = _get_wind_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, cmems_creds=cmems_creds)
            if wind_path:
                forcing_paths.append(wind_path)
        if model_meta.get('needs_waves'):
            waves_path = _get_waves_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, cmems_creds=cmems_creds)
            if waves_path:
                forcing_paths.append(waves_path)
            else:
                logger.warning(f'Waves not available for {model_name}: Stokes drift parametrised from wind')
        if model_meta.get('needs_thermo'):
            thermo_path = _get_thermo_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, cmems_creds=cmems_creds)
            if thermo_path:
                forcing_paths.append(thermo_path)
            else:
                logger.warning(f'T/S not available for {model_name}: weathering with constant values')

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
                    "La simulazione si è fermata subito: l'area di seeding è "
                    "interamente su terraferma o fuori dal dominio dei dati CMEMS. "
                    "Sposta il punto di rilascio in mare aperto."
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

    return o


# ── CMEMS auth helper ────────────────────────────────────────────────────────

def _cmems_auth(creds):
    """Extract CMEMS credentials as a kwargs dict for ``copernicusmarine.subset()``.

    Args:
        creds (dict | None): Dict with ``'username'`` and ``'password'`` keys, or ``None``
            to fall back on environment variables
            (``COPERNICUSMARINE_SERVICE_USERNAME`` / ``COPERNICUSMARINE_SERVICE_PASSWORD``).

    Returns:
        dict: ``{'username': ..., 'password': ...}`` when explicit credentials are provided,
        or an empty dict ``{}`` to let the CMEMS client read environment variables.
    """
    if not creds:
        return {}
    u = creds.get('username', '')
    p = creds.get('password', '')
    if u and p:
        return {'username': u, 'password': p}
    return {}


# ── Cache helpers — currents ─────────────────────────────────────────────────

def _cache_key(lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix='cur', max_depth=0.5, margin=5.0):
    """Compute a stable file-system cache key for a CMEMS NetCDF download.

    Snaps the bounding box to integer degree boundaries, normalises the time range to
    whole days, and produces both a human-readable filename label and a short MD5
    digest to avoid collisions when labels are ambiguous.

    Args:
        lon_min / lon_max / lat_min / lat_max (float): Seeding bbox in decimal degrees.
        start_time (datetime): Simulation start; snapped to midnight.
        end_time (datetime): Simulation end; used to compute the number of whole days.
        suffix (str): Tag appended to the filename (e.g. ``'cur'``, ``'wind'``, ``'wav'``).
        max_depth (float): Maximum depth in metres; included in the key for vertical datasets.
        margin (float): Spatial buffer in degrees added around the bbox for CMEMS download.

    Returns:
        tuple: ``(cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days)``
        where *cache_path* is an absolute path under ``CACHE_DIR``.
    """
    # Snap bounds to integer degrees for stable cache keys
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
    # Human-readable label uses centre
    clon = round((lon_min + lon_max) / 2)
    clat = round((lat_min + lat_max) / 2)
    label  = f'{clon:+03d}_{clat:+03d}_{snap_start.strftime("%Y%m%d")}_{n_days}d_{suffix}{depth_label}_m{margin:.1f}'

    return (
        os.path.join(CACHE_DIR, f'cmems_{label}_{digest}.nc'),
        slon_min, slon_max, slat_min, slat_max, snap_start, n_days,
    )


def _get_forcing_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, time_step_hours=1, max_depth=0.5, margin=5.0, cmems_creds=None):
    """Return the path to a cached CMEMS current-velocity NetCDF, downloading if absent.

    Selects hourly or daily datasets depending on *time_step_hours*, then delegates to
    :func:`_download_currents` on cache miss.  The cache key is computed via
    :func:`_cache_key` from the snapped bbox, date range, depth, and margin.

    Args:
        lon_min / lon_max / lat_min / lat_max (float): Seeding bbox in decimal degrees.
        start_time / end_time (datetime): Simulation time window.
        time_step_hours (int): Requested time resolution (≥ 24 selects daily datasets).
        max_depth (float): Maximum depth in metres for vertical models.
        margin (float): Spatial buffer in degrees added around the bbox.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Returns:
        str: Absolute path to the cached NetCDF file.
    """
    suffix = 'cur_d' if time_step_hours >= 24 else 'cur'
    cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days = _cache_key(
        lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix=suffix, max_depth=max_depth, margin=margin
    )
    if os.path.exists(cache_path):
        logger.debug(f'Currents cache: HIT — {os.path.basename(cache_path)}')
    else:
        logger.info(
            f'Currents cache: MISS — starting download ({n_days} days, '
            f'{"daily" if time_step_hours >= 24 else "hourly"}, '
            f'max_depth={max_depth:.0f}m, margin={margin}°, '
            f'bbox=[{lon_min:.1f},{lat_min:.1f}→{lon_max:.1f},{lat_max:.1f}])'
        )
        _download_currents(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, time_step_hours, max_depth, margin, cmems_creds)
    return cache_path


def _get_wind_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, margin=5.0, cmems_creds=None):
    """Return the path to a cached CMEMS wind NetCDF, downloading if absent.

    Non-blocking: logs a warning and returns ``None`` on download failure, allowing the
    calling model to degrade gracefully (e.g. no wind-driven Stokes drift).

    Args:
        lon_min / lon_max / lat_min / lat_max (float): Seeding bbox in decimal degrees.
        start_time / end_time (datetime): Simulation time window.
        margin (float): Spatial buffer in degrees added around the bbox.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Returns:
        str | None: Absolute path to the cached NetCDF, or ``None`` on download failure.
    """
    cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days = _cache_key(
        lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix='wind', margin=margin
    )
    if os.path.exists(cache_path):
        logger.debug(f'Wind cache: HIT — {os.path.basename(cache_path)}')
        return cache_path
    logger.info(f'Wind cache: MISS — starting download ({n_days} days, margin={margin}°)')
    try:
        _download_wind(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin, cmems_creds)
        return cache_path
    except Exception as e:
        logger.warning(f'Wind download failed (non-blocking): {e}')
        return None


def _build_bbox(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, max_depth=0.5, margin=5.0):
    """Build the keyword-argument dict for ``copernicusmarine.subset()``.

    Expands the snapped bounding box by *margin* degrees on each side and adds a depth
    range from 0 to *max_depth* metres.  The temporal window spans *n_days* full days
    starting from *snap_start*.

    Args:
        slon_min / slon_max / slat_min / slat_max (int): Integer-degree snapped bbox.
        snap_start (datetime): Midnight-aligned simulation start.
        n_days (int): Number of whole days to download.
        max_depth (float): Maximum depth in metres.
        margin (float): Additional spatial buffer in degrees.

    Returns:
        dict: Keyword arguments ready to be unpacked into ``copernicusmarine.subset()``.
    """
    snap_end = snap_start + timedelta(days=n_days)
    return dict(
        minimum_longitude = slon_min - margin,
        maximum_longitude = slon_max + margin,
        minimum_latitude  = slat_min - margin,
        maximum_latitude  = slat_max + margin,
        minimum_depth     = 0,
        maximum_depth     = max_depth,
        start_datetime    = snap_start.strftime('%Y-%m-%dT%H:%M:%S'),
        end_datetime      = snap_end.strftime('%Y-%m-%dT%H:%M:%S'),
    )

def _download_currents(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, time_step_hours=1, max_depth=0.5, margin=5.0, cmems_creds=None):
    """Download ocean current velocity (uo, vo) from CMEMS and save to *cache_path*.

    Tries each dataset in ``CMEMS_CURRENT_DATASETS_HOURLY`` (or ``_DAILY``) in order,
    moving on to the next if the current one raises an exception.

    Args:
        slon_min / slon_max / slat_min / slat_max (int): Integer-degree snapped bbox.
        snap_start (datetime): Midnight-aligned start date.
        n_days (int): Number of days to download.
        cache_path (str): Destination file path for the output NetCDF.
        time_step_hours (int): ≥ 24 selects daily-resolution datasets.
        max_depth (float): Maximum depth in metres.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Raises:
        ProcessorExecuteError: If every available dataset fails to download.
    """
    import copernicusmarine
    datasets = CMEMS_CURRENT_DATASETS_DAILY if time_step_hours >= 24 else CMEMS_CURRENT_DATASETS_HOURLY
    freq_label = 'daily' if time_step_hours >= 24 else 'hourly'
    logger.info(f'Downloading CMEMS currents ({freq_label}, 0–{max_depth:.0f}m, margin={margin}°) — {snap_start.date()} +{n_days}d → {os.path.basename(cache_path)}')
    bbox     = _build_bbox(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, max_depth, margin)
    last_err = None
    for ds in datasets:
        try:
            copernicusmarine.subset(
                dataset_id       = ds['dataset_id'],
                variables        = ds['variables'],
                output_filename  = os.path.basename(cache_path),
                output_directory = CACHE_DIR,
                overwrite        = True,
                **bbox,
                **_cmems_auth(cmems_creds),
            )
            logger.info(f"Currents dataset downloaded: {ds['dataset_id']}")
            return
        except Exception as e:
            logger.warning(f"Currents dataset failed: {ds['dataset_id']} — {e}")
            last_err = e
    logger.error(f'All currents datasets failed. Last error: {last_err}')
    raise ProcessorExecuteError(f'CMEMS currents download failed: {last_err}')


def _download_wind(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin=5.0, cmems_creds=None):
    """Download 10-m wind components (eastward, northward) from CMEMS.

    Depth parameters are omitted from the request as wind data is surface-only.
    Tries datasets in ``CMEMS_WIND_DATASETS`` order.

    Args:
        slon_min / slon_max / slat_min / slat_max (int): Integer-degree snapped bbox.
        snap_start (datetime): Midnight-aligned start date.
        n_days (int): Number of days to download.
        cache_path (str): Destination file path for the output NetCDF.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Raises:
        RuntimeError: If every available wind dataset fails to download.
    """
    import copernicusmarine
    logger.info(f'Downloading CMEMS wind (margin={margin}°) — {snap_start.date()} +{n_days}d → {os.path.basename(cache_path)}')
    bbox = _build_bbox(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, margin=margin)
    bbox.pop('minimum_depth', None)
    bbox.pop('maximum_depth', None)

    for ds in CMEMS_WIND_DATASETS:
        try:
            copernicusmarine.subset(
                dataset_id       = ds['dataset_id'],
                variables        = ds['variables'],
                output_filename  = os.path.basename(cache_path),
                output_directory = CACHE_DIR,
                overwrite        = True,
                **bbox,
                **_cmems_auth(cmems_creds),
            )
            logger.info(f"Wind dataset downloaded: {ds['dataset_id']}")
            return
        except Exception as e:
            logger.warning(f"Wind dataset failed: {ds['dataset_id']} — {e}")
    raise RuntimeError('Wind dataset not available')


# ── Cache helpers — waves (Stokes drift) ─────────────────────────────────────

def _get_waves_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, margin=5.0, cmems_creds=None):
    """Return the path to a cached CMEMS Stokes-drift wave NetCDF, downloading if absent.

    Non-blocking: returns ``None`` on download failure so callers can fall back to
    wind-parameterised Stokes drift.

    Args:
        lon_min / lon_max / lat_min / lat_max (float): Seeding bbox in decimal degrees.
        start_time / end_time (datetime): Simulation time window.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Returns:
        str | None: Absolute path to the cached NetCDF, or ``None`` on failure.
    """
    cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days = _cache_key(
        lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix='wav', margin=margin
    )
    if os.path.exists(cache_path):
        logger.debug(f'Waves cache: HIT — {os.path.basename(cache_path)}')
        return cache_path
    logger.info(f'Waves cache: MISS — starting download ({n_days} days, margin={margin}°)')
    try:
        _download_waves(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin, cmems_creds)
        return cache_path
    except Exception as e:
        logger.warning(f'Waves download failed (non-blocking): {e}')
        return None


def _download_waves(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin=5.0, cmems_creds=None):
    """Download surface Stokes-drift components (VSDX, VSDY) from CMEMS wave models.

    Depth parameters are omitted as Stokes drift is inherently a surface-layer quantity.
    Tries datasets in ``CMEMS_WAVES_DATASETS`` order.

    Args:
        slon_min / slon_max / slat_min / slat_max (int): Integer-degree snapped bbox.
        snap_start (datetime): Midnight-aligned start date.
        n_days (int): Number of days to download.
        cache_path (str): Destination file path for the output NetCDF.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Raises:
        RuntimeError: If every available wave dataset fails to download.
    """
    import copernicusmarine
    logger.info(f'Downloading CMEMS waves (VSDX/VSDY, margin={margin}°) — {snap_start.date()} +{n_days}d → {os.path.basename(cache_path)}')
    bbox = _build_bbox(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, max_depth=0.5, margin=margin)
    bbox.pop('minimum_depth', None)
    bbox.pop('maximum_depth', None)
    last_err = None
    for ds in CMEMS_WAVES_DATASETS:
        try:
            copernicusmarine.subset(
                dataset_id       = ds['dataset_id'],
                variables        = ds['variables'],
                output_filename  = os.path.basename(cache_path),
                output_directory = CACHE_DIR,
                overwrite        = True,
                **bbox,
                **_cmems_auth(cmems_creds),
            )
            logger.info(f"Waves dataset downloaded: {ds['dataset_id']}")
            return
        except Exception as e:
            logger.warning(f"Waves dataset failed: {ds['dataset_id']} — {e}")
            last_err = e
    raise RuntimeError(f'No wave dataset available: {last_err}')


# ── Cache helpers — temperature and salinity (OpenOil weathering) ────────────

def _get_thermo_file(lon_min, lon_max, lat_min, lat_max, start_time, end_time, margin=5.0, cmems_creds=None):
    """Return the path to a cached CMEMS temperature/salinity NetCDF, downloading if absent.

    Non-blocking: returns ``None`` on failure so OpenOil degrades to constant T/S values
    for weathering rather than aborting the simulation.

    Args:
        lon_min / lon_max / lat_min / lat_max (float): Seeding bbox in decimal degrees.
        start_time / end_time (datetime): Simulation time window.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Returns:
        str | None: Absolute path to the cached NetCDF, or ``None`` on failure.
    """
    cache_path, slon_min, slon_max, slat_min, slat_max, snap_start, n_days = _cache_key(
        lon_min, lon_max, lat_min, lat_max, start_time, end_time, suffix='tem', margin=margin
    )
    if os.path.exists(cache_path):
        logger.debug(f'T/S cache: HIT — {os.path.basename(cache_path)}')
        return cache_path
    logger.info(f'T/S cache: MISS — starting download ({n_days} days, margin={margin}°)')
    try:
        _download_thermo(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin, cmems_creds)
        return cache_path
    except Exception as e:
        logger.warning(f'T/S download failed (non-blocking): {e}')
        return None


def _download_thermo(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, cache_path, margin=5.0, cmems_creds=None):
    """Download surface temperature (thetao) and salinity (so) for OpenOil weathering.

    Tries datasets with both variables first; falls back to temperature-only.
    Salinity is used for emulsification, temperature for evaporation.
    """
    import copernicusmarine
    logger.info(f'Downloading CMEMS T/S (0–0.5 m, margin={margin}°) — {snap_start.date()} +{n_days}d → {os.path.basename(cache_path)}')
    bbox = _build_bbox(slon_min, slon_max, slat_min, slat_max, snap_start, n_days, max_depth=0.5, margin=margin)
    last_err = None
    for ds in CMEMS_THERMO_DATASETS:
        try:
            copernicusmarine.subset(
                dataset_id       = ds['dataset_id'],
                variables        = ds['variables'],
                output_filename  = os.path.basename(cache_path),
                output_directory = CACHE_DIR,
                overwrite        = True,
                **bbox,
                **_cmems_auth(cmems_creds),
            )
            logger.info(f"T/S dataset downloaded: {ds['dataset_id']} — variables: {ds['variables']}")
            return
        except Exception as e:
            logger.warning(f"T/S dataset failed: {ds['dataset_id']} — {e}")
            last_err = e
    raise RuntimeError(f'No T/S dataset available: {last_err}')


# ── Cache helpers — static bathymetry (maximum area depth) ───────────────────

def _get_max_depth_for_area(lon_min, lon_max, lat_min, lat_max, margin=5.0, cmems_creds=None):
    """Return the maximum seafloor depth (m) + 10 m buffer for the given area.

    Uses a static cached NetCDF (geographic key only, no temporal fields).
    Returns None on failure — non-blocking.
    """
    slon_min = math.floor(lon_min)
    slon_max = math.ceil(lon_max)
    slat_min = math.floor(lat_min)
    slat_max = math.ceil(lat_max)

    raw    = f'{slon_min}|{slon_max}|{slat_min}|{slat_max}|bathy|m{margin:.1f}'
    digest = hashlib.md5(raw.encode()).hexdigest()[:8]
    clon   = round((lon_min + lon_max) / 2)
    clat   = round((lat_min + lat_max) / 2)
    cache_path = os.path.join(CACHE_DIR, f'cmems_{clon:+03d}_{clat:+03d}_bathy_m{margin:.1f}_{digest}.nc')

    if os.path.exists(cache_path):
        logger.debug(f'Bathymetry cache: HIT — {os.path.basename(cache_path)}')
    else:
        logger.info(f'Bathymetry cache: MISS — starting download (margin={margin}°, bbox=[{slon_min},{slat_min}→{slon_max},{slat_max}])')
        try:
            _download_bathymetry(slon_min, slon_max, slat_min, slat_max, cache_path, margin, cmems_creds)
        except Exception as e:
            logger.warning(f'Bathymetry download failed (non-blocking): {e}')
            return None

    try:
        import netCDF4 as nc4
        ds  = nc4.Dataset(cache_path)
        dep = ds.variables['deptho'][:]
        ds.close()
        max_d = float(np.nanmax(dep)) + 10.0
        logger.info(f'Maximum area depth: {max_d - 10:.0f} m + 10 m buffer = {max_d:.0f} m')
        return max_d
    except Exception as e:
        logger.warning(f'Bathymetry read failed: {e}')
        return None


def _download_bathymetry(slon_min, slon_max, slat_min, slat_max, cache_path, margin=5.0, cmems_creds=None):
    """Download static seafloor depth (deptho) from a CMEMS bathymetry dataset.

    Requests the ``deptho`` variable without time or depth dimensions.  Tries datasets
    in ``CMEMS_BATHY_DATASETS`` order.

    Args:
        slon_min / slon_max / slat_min / slat_max (int): Integer-degree snapped bbox.
        cache_path (str): Destination file path for the output NetCDF.
        margin (float): Spatial buffer in degrees.
        cmems_creds (dict | None): Explicit CMEMS credentials, or ``None`` for env vars.

    Raises:
        RuntimeError: If every available bathymetry dataset fails to download.
    """
    import copernicusmarine
    logger.info(f'Downloading CMEMS bathymetry (deptho, margin={margin}°) → {os.path.basename(cache_path)}')
    geo_bbox = dict(
        minimum_longitude = slon_min - margin,
        maximum_longitude = slon_max + margin,
        minimum_latitude  = slat_min - margin,
        maximum_latitude  = slat_max + margin,
    )
    last_err = None
    for ds in CMEMS_BATHY_DATASETS:
        try:
            copernicusmarine.subset(
                dataset_id       = ds['dataset_id'],
                variables        = ds['variables'],
                output_filename  = os.path.basename(cache_path),
                output_directory = CACHE_DIR,
                overwrite        = True,
                **geo_bbox,
                **_cmems_auth(cmems_creds),
            )
            logger.info(f"Bathymetry dataset downloaded: {ds['dataset_id']}")
            return
        except Exception as e:
            logger.warning(f"Bathymetry dataset failed: {ds['dataset_id']} — {e}")
            last_err = e
    raise RuntimeError(f'No bathymetry dataset available: {last_err}')


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