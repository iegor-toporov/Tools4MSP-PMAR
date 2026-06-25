import json
import logging
import os

import geopandas as gpd
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from data.emodnet_fetch import _fetch_windfarms, EMODNET_CACHE_DIR
from processes.logging_utils import setup_logger

logger = setup_logger('windfarms_process', 'windfarms', 'windfarms.log')

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'windfarms',
    'title': {'en': 'Wind Farms Query'},
    'description': {
        'en': 'Returns EMODnet offshore wind farm polygons for a given bounding box.'
    },
    'jobControlOptions': ['sync-execute'],
    'keywords': ['windfarms', 'emodnet', 'geojson'],
    'inputs': {
        'lon_min': {'schema': {'type': 'number'}, 'minOccurs': 1, 'maxOccurs': 1},
        'lat_min': {'schema': {'type': 'number'}, 'minOccurs': 1, 'maxOccurs': 1},
        'lon_max': {'schema': {'type': 'number'}, 'minOccurs': 1, 'maxOccurs': 1},
        'lat_max': {'schema': {'type': 'number'}, 'minOccurs': 1, 'maxOccurs': 1},
    },
    'outputs': {
        'result': {
            'title': 'GeoJSON FeatureCollection of wind farms',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


class WindfarmsProcessor(BaseProcessor):
    """OGC API Process that returns EMODnet offshore wind farm polygons for a given bounding box."""

    def __init__(self, processor_def):
        """Initialise the processor with its OGC API metadata definition."""
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        """Execute the wind farms spatial query.

        Validates the input bounding box, delegates the WFS fetch (with 7-day
        file-level caching) to :func:`~data.emodnet_fetch._fetch_windfarms`,
        simplifies polygon geometries to a 0.005° tolerance to reduce payload size,
        and serialises the result as a GeoJSON FeatureCollection.

        Args:
            data (dict): OGC API input payload. Required keys:
                ``lon_min``, ``lat_min``, ``lon_max``, ``lat_max`` — bounding box
                coordinates in decimal degrees (EPSG:4326).

        Returns:
            tuple[str, dict]: ``('application/json', geojson)`` where *geojson*
            is a GeoJSON FeatureCollection. Returns an empty FeatureCollection
            when no wind farms intersect the requested bbox.

        Raises:
            ProcessorExecuteError: If any bounding-box parameter is missing,
                non-numeric, or otherwise invalid.
        """
        try:
            lon_min = float(data['lon_min'])
            lat_min = float(data['lat_min'])
            lon_max = float(data['lon_max'])
            lat_max = float(data['lat_max'])
        except (KeyError, TypeError, ValueError) as e:
            raise ProcessorExecuteError(f'Invalid bbox parameters: {e}')

        study_area = [lon_min, lat_min, lon_max, lat_max]
        logger.info(f'Windfarms query: bbox={study_area}')

        gdf = _fetch_windfarms(study_area, EMODNET_CACHE_DIR)

        if gdf.empty:
            return 'application/json', {'type': 'FeatureCollection', 'features': []}

        geojson = json.loads(gdf[['geometry']].simplify(0.005).to_json())
        logger.info(f'Windfarms returned: {len(gdf)} features')
        return 'application/json', geojson

    def __repr__(self):
        """Return an unambiguous string representation of this processor."""
        return '<WindfarmsProcessor>'
