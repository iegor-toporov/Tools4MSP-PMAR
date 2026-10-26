"""Colonne di uno shapefile caricato: alimentano il menu "Polygon label" della
connettività, che oggi chiedeva di scrivere il nome della colonna a memoria."""
import os
import tempfile

import geopandas as gpd
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from processes.PMARProcess import _resolve_shapefile
from processes.logging_utils import setup_logger

logger = setup_logger('shapefile_fields_process', 'pmar', 'shapefile_fields.log')

# Valori d'esempio per colonna: bastano a riconoscere quella con i nomi.
SAMPLE_VALUES = 3

PROCESS_METADATA = {
    'version': '0.1.0',
    'id': 'shapefile_fields',
    'title': {'en': 'Shapefile attribute columns'},
    'description': {
        'en': 'Lists the attribute columns of an uploaded shapefile (ZIP), with a few '
              'sample values each, and its number of polygons.'
    },
    'jobControlOptions': ['sync-execute', 'async-execute'],
    'keywords': ['shapefile', 'attributes', 'connectivity'],
    'inputs': {
        'shapefile_b64': {
            'title': 'Shapefile ZIP (base64)', 'schema': {'type': 'string'},
            'minOccurs': 1, 'maxOccurs': 1,
        },
    },
    'outputs': {
        'result': {
            'title': 'Columns',
            'schema': {'type': 'object', 'contentMediaType': 'application/json'},
        }
    },
}


class ShapefileFieldsProcessor(BaseProcessor):
    """OGC API Process: colonne e numero di poligoni di uno shapefile."""

    def __init__(self, processor_def):
        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data):
        if not data.get('shapefile_b64'):
            raise ProcessorExecuteError('Provide shapefile_b64.')
        os.environ.pop('PROJ_LIB', None)
        os.environ.pop('PROJ_DATA', None)
        with tempfile.TemporaryDirectory() as tmpdir:
            try:
                shp = _resolve_shapefile(None, data['shapefile_b64'], tmpdir)
                gdf = gpd.read_file(shp)
            except ProcessorExecuteError:
                raise
            except Exception as e:
                logger.warning(f'[ShapefileFields] lettura fallita: {e}')
                raise ProcessorExecuteError('Shapefile not readable: a ZIP containing .shp, .shx and .dbf is required.')
        columns = [
            {'name': c,
             'samples': [str(v) for v in gdf[c].dropna().unique()[:SAMPLE_VALUES]],
             'unique': bool(gdf[c].is_unique)}
            for c in gdf.columns if c != 'geometry'
        ]
        polygons = int(gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon']).sum())
        return 'application/json', {'columns': columns, 'n_features': int(len(gdf)),
                                    'n_polygons': polygons}

    def __repr__(self):
        return '<ShapefileFieldsProcessor>'
