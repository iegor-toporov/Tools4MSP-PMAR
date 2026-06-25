
# ── Dataset CMEMS for currents (all models) ────────────────────
CMEMS_CURRENT_DATASETS_HOURLY = [
    {'dataset_id': 'cmems_mod_med_phy-cur_anfc_0.042deg_PT1H-m', 'variables': ['uo', 'vo']},
    {'dataset_id': 'cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m',  'variables': ['uo', 'vo']},
]
CMEMS_CURRENT_DATASETS_DAILY = [
    {'dataset_id': 'cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m',  'variables': ['uo', 'vo']},
    {'dataset_id': 'cmems_mod_glo_phy_my_0.083deg_P1D-m',         'variables': ['uo', 'vo']},
]

# ── Dataset CMEMS for waves — (PlastDrift, OpenOil) ──────────
CMEMS_WAVES_DATASETS = [
    {'dataset_id': 'cmems_mod_med_wav_anfc_4.2km_PT1H-i',     'variables': ['VSDX', 'VSDY']},
    {'dataset_id': 'cmems_mod_glo_wav_anfc_0.083deg_PT3H-i',  'variables': ['VSDX', 'VSDY']},
    {'dataset_id': 'cmems_mod_glo_wav_my_0.2deg_PT3H-i',      'variables': ['VSDX', 'VSDY']},
]

# ── Dataset CMEMS for static bathymetry ────────────────
CMEMS_BATHY_DATASETS = [
    {'dataset_id': 'cmems_mod_med_phy_anfc_4.2km_static',    'variables': ['deptho']},
    {'dataset_id': 'cmems_mod_glo_phy_anfc_0.083deg_static', 'variables': ['deptho']},
]

# ── Dataset CMEMS for temperature and salinity (OpenOil weathering) ────────────
# First try dataset with both, then temperature-only
CMEMS_THERMO_DATASETS = [
    {'dataset_id': 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m',         'variables': ['thetao', 'so']},
    {'dataset_id': 'cmems_mod_glo_phy_my_0.083deg_P1D-m',           'variables': ['thetao', 'so']},
    {'dataset_id': 'cmems_mod_med_phy-tem_anfc_4.2km_PT1H-m',       'variables': ['thetao']},
    {'dataset_id': 'cmems_mod_med_phy-tem_anfc_0.042deg_PT1H-m',    'variables': ['thetao']},
    {'dataset_id': 'cmems_mod_glo_phy-thetao_anfc_0.083deg_PT6H-i', 'variables': ['thetao']},
]

# ── Dataset CMEMS fow surface wind ────────────────────────────────────
CMEMS_WIND_DATASETS = [
    {'dataset_id': 'cmems_obs-wind_med_phy_nrt_l4_0.125deg_PT1H', 'variables': ['eastward_wind', 'northward_wind']},
    {'dataset_id': 'cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H', 'variables': ['eastward_wind', 'northward_wind']},
    {'dataset_id': 'cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H',  'variables': ['eastward_wind', 'northward_wind']},
]