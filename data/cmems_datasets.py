"""Registro dei dataset CMEMS usati come forzanti.

Ogni voce dice **cosa** è un dataset (bacino, famiglia di variabili, analisi e
previsione o reanalisi, passo, 2D o 3D); **dove e quando** ha dati lo legge il catalogo
CMEMS (`data/cmems_select.py`, salvato in `cache/cmems_catalog.json`), perché i prodotti
di analisi e previsione sono finestre mobili e CMEMS ritira e rinomina versioni. La
scelta fra le voci la fa `cmems_select.plan_family`, senza provarle una dopo l'altra.

Gli ID sono stati verificati col catalogo il 26/10/2026; `scripts/check_cmems_catalog.py`
li ricontrolla (all'avvio del backend).

Famiglie: `cur` correnti, `tem` temperatura, `sal` salinità, `mld` spessore dello strato
rimescolato, `wav` deriva di Stokes, `wind` vento a 10 m, `bathy` profondità del fondale.
"""

# Nome leggibile dei bacini (provenienza mostrata nell'interfaccia) ed estensione in cui
# il bacino ha senso (come in PMAR). Il rettangolo del catalogo si restringe a questa:
# da solo può includere mare che il modello non simula (NWS arriva a 40°N nel Tirreno).
# Senza catalogo vale questa.
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


# step_h: passo in ore (None = statico). dims: '2D' solo superficie, '3D' con profondità
# (se ne scarica la superficie quando il modello non va in profondità).
# kind: 'anfc' analisi e previsione, 'my' reanalisi, 'static'.
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

    # ── Mar Nero (2.5 km) ─────────────────────────────────────────────────────
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

    # ── Iberia-Biscaglia-Irlanda (0.027°) ─────────────────────────────────────
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

    # ── Piattaforma nord-occidentale (1.5 km analisi, 7 km reanalisi) ─────────
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

    # ── Globale (1/12°) e vento ────────────────────────────────────────────────
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
    """Tutti gli ID del registro, una volta sola ciascuno."""
    return sorted({d['dataset_id'] for d in REGISTRY})
