import hashlib
import os
import pickle
import time as _time
import urllib.parse

import geopandas as gpd

from processes.OpenDriftProcess import CACHE_DIR
from processes.logging_utils import setup_logger

logger = setup_logger('emodnet_fetch')

EMODNET_CACHE_DIR = os.path.join(CACHE_DIR, 'emodnet')
os.makedirs(EMODNET_CACHE_DIR, exist_ok=True)


def _fetch_windfarms(study_area, cache_dir):
    """Query EMODnet WFS for wind farm polygons within study_area, with 7-day file cache."""
    lon_min, lat_min, lon_max, lat_max = study_area
    cache_key  = hashlib.md5(
        f'wf_{lon_min:.3f}_{lat_min:.3f}_{lon_max:.3f}_{lat_max:.3f}'.encode()
    ).hexdigest()
    cache_file = os.path.join(cache_dir, f'windfarms_{cache_key}.pkl')

    if os.path.exists(cache_file):
        age = _time.time() - os.path.getmtime(cache_file)
        if age < 7 * 86400:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)

    bbox_str = f'{lon_min},{lat_min},{lon_max},{lat_max},EPSG:4326'
    base_url = 'https://ows.emodnet-humanactivities.eu/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json'
    gdf = None
    for layer in ('emodnet:windfarmspoly', 'emodnet:windfarms'):
        url = f'{base_url}&TYPENAMES={layer}&BBOX={bbox_str}'
        try:
            candidate = gpd.read_file(url)
            if not candidate.empty:
                gdf = candidate
                logger.info(f'EMODnet layer used: {layer}, features: {len(gdf)}')
                break
            logger.debug(f'EMODnet layer {layer}: 0 features inside the area')
        except Exception as exc:
            logger.warning(f'EMODnet WFS {layer} failed: {exc}')

    if gdf is None:
        return gpd.GeoDataFrame(geometry=gpd.GeoSeries([], dtype='geometry', crs='EPSG:4326'))

    if gdf.crs is None:
        gdf = gdf.set_crs('EPSG:4326')
    else:
        gdf = gdf.to_crs('EPSG:4326')

    os.makedirs(cache_dir, exist_ok=True)
    with open(cache_file, 'wb') as f:
        pickle.dump(gdf, f)

    return gdf


def _fetch_offshore_installations(study_area, cache_dir):
    """Query EMODnet WFS for offshore installation features within study_area, with 7-day file cache."""
    lon_min, lat_min, lon_max, lat_max = study_area
    cache_key  = hashlib.md5(
        f'oi_{lon_min:.3f}_{lat_min:.3f}_{lon_max:.3f}_{lat_max:.3f}'.encode()
    ).hexdigest()
    cache_file = os.path.join(cache_dir, f'offshore_{cache_key}.pkl')

    if os.path.exists(cache_file):
        age = _time.time() - os.path.getmtime(cache_file)
        if age < 7 * 86400:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)

    bbox_str = f'{lon_min},{lat_min},{lon_max},{lat_max},EPSG:4326'
    base_url = 'https://ows.emodnet-humanactivities.eu/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json'
    gdf = None
    for layer in ('emodnet:offshorefacilities', 'emodnet:offshore_installations', 'emodnet:platforms'):
        url = f'{base_url}&TYPENAMES={layer}&BBOX={bbox_str}'
        try:
            candidate = gpd.read_file(url)
            if not candidate.empty:
                gdf = candidate
                logger.info(f'EMODnet layer used: {layer}, features: {len(gdf)}')
                break
            logger.debug(f'EMODnet layer {layer}: 0 features inside area.')
        except Exception as exc:
            logger.warning(f'EMODnet WFS {layer} failed: {exc}')

    if gdf is None:
        return gpd.GeoDataFrame(geometry=gpd.GeoSeries([], dtype='geometry', crs='EPSG:4326'))

    if gdf.crs is None:
        gdf = gdf.set_crs('EPSG:4326')
    else:
        gdf = gdf.to_crs('EPSG:4326')

    os.makedirs(cache_dir, exist_ok=True)
    with open(cache_file, 'wb') as f:
        pickle.dump(gdf, f)

    return gdf


def _fetch_msp_zones(study_area, cache_dir):
    """Query EMODnet WFS for Italian aquaculture MSP zoning polygons within study_area, with 7-day file cache."""
    lon_min, lat_min, lon_max, lat_max = study_area
    cache_key  = hashlib.md5(
        f'mz_{lon_min:.3f}_{lat_min:.3f}_{lon_max:.3f}_{lat_max:.3f}'.encode()
    ).hexdigest()
    cache_file = os.path.join(cache_dir, f'mspzones_{cache_key}.pkl')

    if os.path.exists(cache_file):
        age = _time.time() - os.path.getmtime(cache_file)
        if age < 7 * 86400:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)

    # BBOX + CQL_FILTER simultaneously causes HTTP 500 on this WFS endpoint.
    # Fetch all Italian aquaculture priority zones (small dataset), then clip in Python.
    base_url   = 'https://ows.emodnet-humanactivities.eu/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json'
    cql_filter = urllib.parse.quote("ms='Italy' AND seausename='Aquaculture' AND seausefct='Priority'")
    url        = f'{base_url}&TYPENAMES=emodnet:mspzoningpoly&CQL_FILTER={cql_filter}'

    try:
        gdf = gpd.read_file(url)
        if gdf.empty:
            gdf = None
        else:
            logger.info(f'MSP Zone aquaculture (Italy): {len(gdf)} features')
    except Exception as exc:
        logger.warning(f'EMODnet WFS mspzoningpoly failed: {exc}')
        gdf = None

    if gdf is None:
        return gpd.GeoDataFrame(geometry=gpd.GeoSeries([], dtype='geometry', crs='EPSG:4326'))

    if gdf.crs is None:
        gdf = gdf.set_crs('EPSG:4326')
    else:
        gdf = gdf.to_crs('EPSG:4326')

    from shapely.geometry import box
    bbox_geom = box(lon_min, lat_min, lon_max, lat_max)
    gdf = gdf[gdf.intersects(bbox_geom)].copy()
    logger.info(f'MSP Zones in the study area: {len(gdf)} features')

    os.makedirs(cache_dir, exist_ok=True)
    with open(cache_file, 'wb') as f:
        pickle.dump(gdf, f)

    return gdf


def _fetch_natura2000(study_area, cache_dir):
    """Query EMODnet WFS for Natura 2000 marine sites within study_area, with 7-day file cache."""
    lon_min, lat_min, lon_max, lat_max = study_area
    cache_key  = hashlib.md5(
        f'n2k_{lon_min:.3f}_{lat_min:.3f}_{lon_max:.3f}_{lat_max:.3f}'.encode()
    ).hexdigest()
    cache_file = os.path.join(cache_dir, f'natura2000_{cache_key}.pkl')

    if os.path.exists(cache_file):
        age = _time.time() - os.path.getmtime(cache_file)
        if age < 7 * 86400:
            with open(cache_file, 'rb') as f:
                return pickle.load(f)

    bbox_str = f'{lon_min},{lat_min},{lon_max},{lat_max},EPSG:4326'
    base_url = 'https://ows.emodnet-humanactivities.eu/wfs?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json'
    gdf = None
    for layer in ('emodnet:natura2000areas', 'emodnet:marineprotectedareas'):
        url = f'{base_url}&TYPENAMES={layer}&BBOX={bbox_str}'
        try:
            candidate = gpd.read_file(url)
            if not candidate.empty:
                gdf = candidate
                logger.info(f'EMODnet layer used: {layer}, features: {len(gdf)}')
                break
            logger.debug(f'EMODnet layer {layer}: 0 features inside area.')
        except Exception as exc:
            logger.warning(f'EMODnet WFS {layer} failed: {exc}')

    if gdf is None:
        return gpd.GeoDataFrame(geometry=gpd.GeoSeries([], dtype='geometry', crs='EPSG:4326'))

    if gdf.crs is None:
        gdf = gdf.set_crs('EPSG:4326')
    else:
        gdf = gdf.to_crs('EPSG:4326')

    os.makedirs(cache_dir, exist_ok=True)
    with open(cache_file, 'wb') as f:
        pickle.dump(gdf, f)

    return gdf
