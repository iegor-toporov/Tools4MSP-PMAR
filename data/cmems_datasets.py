"""Registry of the CMEMS datasets used as forcing.

Each entry says **what** a dataset is (basin, family of variables, analysis and
forecast or reanalysis, step, 2D or 3D); **where and when** it has data is read from
the CMEMS catalogue (`data/cmems_select.py`, saved in `cache/cmems_catalog.json`),
because analysis and forecast products are moving windows and CMEMS retires and renames
versions. `cmems_select.plan_family` chooses among the entries, without trying them one
after another.

The IDs were checked against the catalogue on 26/10/2026; `scripts/check_cmems_catalog.py`
checks them again (when the backend starts).

Families: `cur` currents, `tem` temperature, `sal` salinity, `mld` mixed layer depth,
`wav` Stokes drift, `wind` wind at 10 m, `bathy` seabed depth.
"""

# Readable name of the basins (provenance shown in the interface) and the extent where
# the basin makes sense (as in PMAR). The catalogue rectangle is narrowed to this: on
# its own it can include sea that the model does not simulate (NWS reaches 40°N in the
# Tyrrhenian). Without a catalogue, this extent applies.
BASINS = {
    'med': {'label': 'Mediterranean', 'extent': [-6.0, 30.19, 36.29, 45.98]},
    'blk': {'label': 'Black Sea',     'extent': [27.25, 40.5, 42.0, 47.0]},
    'ibi': {'label': 'Iberia-Biscay-Ireland', 'extent': [-19.08, 26.17, 5.08, 56.08]},
    'nws': {'label': 'North-West Shelf', 'extent': [-16.0, 46.0, 13.0, 62.74]},
    'bal': {'label': 'Baltic Sea',    'extent': [9.04, 53.01, 30.21, 65.89]},
    'glo': {'label': 'Global',        'extent': [-180.0, -80.0, 180.0, 90.0]},
}

CUR  = ['uo', 'vo']
TEM  = ['thetao']
SAL  = ['so']
MLD  = ['mlotst']
WAV  = ['VSDX', 'VSDY']
WIND = ['eastward_wind', 'northward_wind']
BATH = ['deptho']


def _d(family, basin, dataset_id, variables, step_h, dims, kind, res):
    return {'family': family, 'basin': basin, 'dataset_id': dataset_id,
            'variables': variables, 'step_h': step_h, 'dims': dims, 'kind': kind, 'res': res}


# step_h: step in hours (None = static). dims: '2D' surface only, '3D' with depth (only
# the surface is downloaded when the model does not move vertically).
# kind: 'anfc' analysis and forecast, 'my' reanalysis, 'static'.
REGISTRY = [
    # ── Mediterraneo (4.2 km) ─────────────────────────────────────────────────
    _d('cur', 'med', 'cmems_mod_med_phy-cur_anfc_4.2km-2D_PT1H-m', CUR, 1,  '2D', 'anfc', '4.2 km'),
    _d('cur', 'med', 'cmems_mod_med_phy-cur_anfc_4.2km_P1D-m',     CUR, 24, '3D', 'anfc', '4.2 km'),
    _d('cur', 'med', 'cmems_mod_med_phy-cur_my_4.2km_PT1H-m',      CUR, 1,  '2D', 'my',   '4.2 km'),
    _d('cur', 'med', 'cmems_mod_med_phy-cur_my_4.2km_P1D-m',       CUR, 24, '3D', 'my',   '4.2 km'),
    _d('tem', 'med', 'cmems_mod_med_phy-tem_anfc_4.2km_P1D-m',     TEM, 24, '3D', 'anfc', '4.2 km'),
    _d('tem', 'med', 'cmems_mod_med_phy-temp_my_4.2km_P1D-m',      TEM, 24, '3D', 'my',   '4.2 km'),
    _d('sal', 'med', 'cmems_mod_med_phy-sal_anfc_4.2km_P1D-m',     SAL, 24, '3D', 'anfc', '4.2 km'),
    _d('sal', 'med', 'cmems_mod_med_phy-sal_my_4.2km_P1D-m',       SAL, 24, '3D', 'my',   '4.2 km'),
    _d('mld', 'med', 'cmems_mod_med_phy-mld_anfc_4.2km_P1D-m',     MLD, 24, '2D', 'anfc', '4.2 km'),
    _d('mld', 'med', 'cmems_mod_med_phy-mld_my_4.2km_P1D-m',       MLD, 24, '2D', 'my',   '4.2 km'),
    _d('wav', 'med', 'cmems_mod_med_wav_anfc_4.2km_PT1H-i',        WAV, 1,  '2D', 'anfc', '4.2 km'),
    _d('wav', 'med', 'cmems_mod_med_wav_my_4.2km_PT1H-i',          WAV, 1,  '2D', 'my',   '4.2 km'),
    _d('bathy', 'med', 'cmems_mod_med_phy_anfc_4.2km_static',      BATH, None, '2D', 'static', '4.2 km'),

    # ── Black Sea (2.5 km) ─────────────────────────────────────────────────────
    _d('cur', 'blk', 'cmems_mod_blk_phy-cur_anfc_2.5km_PT1H-m',    CUR, 1,  '3D', 'anfc', '2.5 km'),
    _d('cur', 'blk', 'cmems_mod_blk_phy-cur_anfc_2.5km_P1D-m',     CUR, 24, '3D', 'anfc', '2.5 km'),
    _d('cur', 'blk', 'cmems_mod_blk_phy-cur_my_2.5km_P1D-m',       CUR, 24, '3D', 'my',   '2.5 km'),
    _d('tem', 'blk', 'cmems_mod_blk_phy-temp_anfc_2.5km_P1D-m',    TEM, 24, '3D', 'anfc', '2.5 km'),
    _d('tem', 'blk', 'cmems_mod_blk_phy-temp_my_2.5km_P1D-m',      TEM, 24, '3D', 'my',   '2.5 km'),
    _d('sal', 'blk', 'cmems_mod_blk_phy-sal_anfc_2.5km_P1D-m',     SAL, 24, '3D', 'anfc', '2.5 km'),
    _d('sal', 'blk', 'cmems_mod_blk_phy-sal_my_2.5km_P1D-m',       SAL, 24, '3D', 'my',   '2.5 km'),
    _d('mld', 'blk', 'cmems_mod_blk_phy-mld_anfc_2.5km_P1D-m',     MLD, 24, '2D', 'anfc', '2.5 km'),
    _d('mld', 'blk', 'cmems_mod_blk_phy-mld_my_2.5km_P1D-m',       MLD, 24, '2D', 'my',   '2.5 km'),
    _d('wav', 'blk', 'cmems_mod_blk_wav_anfc_2.5km_PT1H-i',        WAV, 1,  '2D', 'anfc', '2.5 km'),
    _d('wav', 'blk', 'cmems_mod_blk_wav_my_2.5km_PT1H-i',          WAV, 1,  '2D', 'my',   '2.5 km'),
    _d('bathy', 'blk', 'cmems_mod_blk_phy_anfc_2.5km_static',      BATH, None, '2D', 'static', '2.5 km'),

    # ── Iberia-Biscay-Ireland (0.027°) ─────────────────────────────────────
    _d('cur', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-2D_PT1H-m',  CUR, 1,  '2D', 'anfc', '0.027°'),
    _d('cur', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-3D_P1D-m',   CUR, 24, '3D', 'anfc', '0.027°'),
    _d('cur', 'ibi', 'cmems_mod_ibi_phy-cur_my_0.027deg_PT1H-m',   CUR, 1,  '2D', 'my',   '0.027°'),
    _d('cur', 'ibi', 'cmems_mod_ibi_phy-cur_my_0.027deg_P1D-m',    CUR, 24, '3D', 'my',   '0.027°'),
    _d('tem', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-3D_P1D-m',   TEM, 24, '3D', 'anfc', '0.027°'),
    _d('tem', 'ibi', 'cmems_mod_ibi_phy-temp_my_0.027deg_P1D-m',   TEM, 24, '3D', 'my',   '0.027°'),
    _d('sal', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-3D_P1D-m',   SAL, 24, '3D', 'anfc', '0.027°'),
    _d('sal', 'ibi', 'cmems_mod_ibi_phy-sal_my_0.027deg_P1D-m',    SAL, 24, '3D', 'my',   '0.027°'),
    _d('mld', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-3D_P1D-m',   MLD, 24, '2D', 'anfc', '0.027°'),
    _d('mld', 'ibi', 'cmems_mod_ibi_phy-mld_my_0.027deg_P1D-m',    MLD, 24, '2D', 'my',   '0.027°'),
    _d('wav', 'ibi', 'cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i',     WAV, 1,  '2D', 'anfc', '0.027°'),
    _d('wav', 'ibi', 'cmems_mod_ibi_wav_my_0.027deg_PT1H-i',       WAV, 1,  '2D', 'my',   '0.027°'),
    _d('bathy', 'ibi', 'cmems_mod_ibi_phy_anfc_0.027deg-3D_static', BATH, None, '2D', 'static', '0.027°'),

    # ── North-West Shelf (1.5 km analysis, 7 km reanalysis) ─────────
    _d('cur', 'nws', 'cmems_mod_nws_phy-cur_anfc_1.5km-2D_PT1H-i', CUR, 1,  '2D', 'anfc', '1.5 km'),
    _d('cur', 'nws', 'cmems_mod_nws_phy-cur_anfc_1.5km-3D_P1D-m',  CUR, 24, '3D', 'anfc', '1.5 km'),
    _d('cur', 'nws', 'cmems_mod_nws_phy-uv_my_7km-2D_PT1H-i',      CUR, 1,  '2D', 'my',   '7 km'),
    _d('cur', 'nws', 'cmems_mod_nws_phy-uv_my_7km-3D_P1D-m',       CUR, 24, '3D', 'my',   '7 km'),
    _d('tem', 'nws', 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_P1D-m',  TEM, 24, '3D', 'anfc', '1.5 km'),
    _d('tem', 'nws', 'cmems_mod_nws_phy-t_my_7km-3D_P1D-m',        TEM, 24, '3D', 'my',   '7 km'),
    _d('sal', 'nws', 'cmems_mod_nws_phy-sal_anfc_1.5km-3D_P1D-m',  SAL, 24, '3D', 'anfc', '1.5 km'),
    _d('sal', 'nws', 'cmems_mod_nws_phy-s_my_7km-3D_P1D-m',        SAL, 24, '3D', 'my',   '7 km'),
    _d('mld', 'nws', 'cmems_mod_nws_phy-mld_anfc_1.5km-2D_P1D-m',  MLD, 24, '2D', 'anfc', '1.5 km'),
    _d('mld', 'nws', 'cmems_mod_nws_phy-mld_my_7km-2D_P1D-m',      MLD, 24, '2D', 'my',   '7 km'),
    _d('wav', 'nws', 'cmems_mod_nws_wav_anfc_1.5km_PT1H-i',        WAV, 1,  '2D', 'anfc', '1.5 km'),
    _d('wav', 'nws', 'MetO-NWS-WAV-RAN',                           WAV, 1,  '2D', 'my',   None),
    _d('bathy', 'nws', 'cmems_mod_nws_phy_anfc_1.5km_static',      BATH, None, '2D', 'static', '1.5 km'),

    # ── Baltico ────────────────────────────────────────────────────────────────
    _d('cur', 'bal', 'cmems_mod_bal_phy_anfc_PT1H-i',              CUR, 1,  '3D', 'anfc', None),
    _d('cur', 'bal', 'cmems_mod_bal_phy_anfc_P1D-m',               CUR, 24, '3D', 'anfc', None),
    _d('cur', 'bal', 'cmems_mod_bal_phy_my_P1D-m',                 CUR, 24, '3D', 'my',   None),
    _d('tem', 'bal', 'cmems_mod_bal_phy_anfc_P1D-m',               TEM, 24, '3D', 'anfc', None),
    _d('tem', 'bal', 'cmems_mod_bal_phy_my_P1D-m',                 TEM, 24, '3D', 'my',   None),
    _d('sal', 'bal', 'cmems_mod_bal_phy_anfc_P1D-m',               SAL, 24, '3D', 'anfc', None),
    _d('sal', 'bal', 'cmems_mod_bal_phy_my_P1D-m',                 SAL, 24, '3D', 'my',   None),
    _d('mld', 'bal', 'cmems_mod_bal_phy_anfc_P1D-m',               MLD, 24, '2D', 'anfc', None),
    _d('mld', 'bal', 'cmems_mod_bal_phy_my_P1D-m',                 MLD, 24, '2D', 'my',   None),
    _d('wav', 'bal', 'cmems_mod_bal_wav_anfc_PT1H-i',              WAV, 1,  '2D', 'anfc', None),
    _d('wav', 'bal', 'cmems_mod_bal_wav_my_PT1H-i',                WAV, 1,  '2D', 'my',   None),
    _d('bathy', 'bal', 'cmems_mod_bal_phy_anfc_static',            BATH, None, '2D', 'static', None),

    # ── Global (1/12°) and wind ────────────────────────────────────────────────
    _d('cur', 'glo', 'cmems_mod_glo_phy_anfc_0.083deg_PT1H-m',     CUR, 1,  '2D', 'anfc', '1/12°'),
    _d('cur', 'glo', 'cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m',  CUR, 24, '3D', 'anfc', '1/12°'),
    _d('cur', 'glo', 'cmems_mod_glo_phy_my_0.083deg_P1D-m',        CUR, 24, '3D', 'my',   '1/12°'),
    _d('tem', 'glo', 'cmems_mod_glo_phy-thetao_anfc_0.083deg_P1D-m', TEM, 24, '3D', 'anfc', '1/12°'),
    _d('tem', 'glo', 'cmems_mod_glo_phy_my_0.083deg_P1D-m',        TEM, 24, '3D', 'my',   '1/12°'),
    _d('sal', 'glo', 'cmems_mod_glo_phy-so_anfc_0.083deg_P1D-m',   SAL, 24, '3D', 'anfc', '1/12°'),
    _d('sal', 'glo', 'cmems_mod_glo_phy_my_0.083deg_P1D-m',        SAL, 24, '3D', 'my',   '1/12°'),
    _d('mld', 'glo', 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',      MLD, 24, '2D', 'anfc', '1/12°'),
    _d('mld', 'glo', 'cmems_mod_glo_phy_my_0.083deg_P1D-m',        MLD, 24, '2D', 'my',   '1/12°'),
    _d('wav', 'glo', 'cmems_mod_glo_wav_anfc_0.083deg_PT3H-i',     WAV, 3,  '2D', 'anfc', '1/12°'),
    _d('wav', 'glo', 'cmems_mod_glo_wav_my_0.2deg_PT3H-i',         WAV, 3,  '2D', 'my',   '0.2°'),
    _d('wind', 'glo', 'cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H', WIND, 1, '2D', 'anfc', '0.125°'),
    _d('wind', 'glo', 'cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H',  WIND, 1, '2D', 'my',   '0.125°'),
    _d('bathy', 'glo', 'cmems_mod_glo_phy_anfc_0.083deg_static',   BATH, None, '2D', 'static', '1/12°'),
]


def dataset_ids():
    """All the IDs of the registry, each once."""
    return sorted({d['dataset_id'] for d in REGISTRY})
