#!/usr/bin/env python3
"""Figures of the evaluation chapter, drawn from bench/results and the scenarios.

Every figure is built from the same CSV files the chapter's tables come from,
so a figure and a table can never disagree. Run it in the backend image, which
has matplotlib, cartopy and netCDF4, with the thesis figure folder mounted:

    docker run --rm -v "$PWD/bench:/app/bench" -v "$PWD/scenarios:/app/scenarios:ro" \\
        -v "$PWD/thesis/figures:/figures" --entrypoint python dto-pmar-backend \\
        /app/bench/figures.py --out /figures

Cartopy downloads the Natural Earth coastline on first use.
"""
import argparse
import csv
import json
import math
import os
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, 'results')
SCENARIOS = os.path.join(os.path.dirname(HERE), 'scenarios')

L_ID = 'custom_e3f0da47'          # the Adriatic campaign run of ch. 5
COLOURS = {'S': '#0072B2', 'M': '#E69F00', 'Mp': '#CC79A7', 'L': '#009E73',
           'server': '#7f7f7f'}

plt.rcParams.update({
    'font.family': 'serif', 'font.serif': ['STIXGeneral', 'DejaVu Serif'],
    'mathtext.fontset': 'stix', 'font.size': 9, 'axes.titlesize': 9,
    'axes.labelsize': 9, 'legend.fontsize': 8, 'xtick.labelsize': 8,
    'ytick.labelsize': 8, 'axes.spines.top': False, 'axes.spines.right': False,
    'savefig.bbox': 'tight', 'savefig.pad_inches': 0.02,
})
WIDTH = 6.1                       # inches: the thesis text width


def read(name):
    with open(os.path.join(RESULTS, f'{name}.csv')) as fh:
        return list(csv.DictReader(fh))


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return math.nan


def reference_ids():
    """The scenario that stands for S, M and L: the run read back from its record."""
    rows = read('reference')
    return {r['name']: r['scenario_id'] for r in rows if r['run'] == 'record'}


def warm(name):
    """The last warm run of a reference scenario."""
    rows = [r for r in read('reference') if r['name'] == name and num(r['downloaded_mb']) == 0]
    return rows[-1]


# ─────────────────────────────── maps ───────────────────────────────────────

def fig_maps(out):
    import cartopy.crs as ccrs
    import cartopy.feature as cfeature
    import netCDF4

    ids = reference_ids()
    panels = [('S', 'S: North Adriatic, 7 days'),
              ('M', 'M: Adriatic basin, 30 days'),
              ('L', 'L: Adriatic basin, 4 releases of 90 days')]
    extent = (12.0, 20.2, 39.6, 46.0)
    res = 0.05
    xe = np.arange(extent[0], extent[1] + res, res)
    ye = np.arange(extent[2], extent[3] + res, res)

    fig, axes = plt.subplots(1, 3, figsize=(WIDTH, 2.9),
                             subplot_kw={'projection': ccrs.PlateCarree()})
    for ax, (name, title) in zip(axes, panels):
        sc = json.load(open(os.path.join(SCENARIOS, f'{ids[name]}.json')))
        files = sc.get('nc_filenames') or [sc['nc_filename']]
        h = np.zeros((len(xe) - 1, len(ye) - 1))
        for fn in files:
            with netCDF4.Dataset(os.path.join(SCENARIOS, fn)) as nc:
                n = nc.dimensions['trajectory'].size
                for i in range(0, n, 2000):
                    lon = np.ma.filled(nc['lon'][i:i + 2000, :], np.nan).ravel()
                    lat = np.ma.filled(nc['lat'][i:i + 2000, :], np.nan).ravel()
                    ok = np.isfinite(lon) & np.isfinite(lat)
                    h += np.histogram2d(lon[ok], lat[ok], bins=(xe, ye))[0]
        h = np.where(h > 0, h / h.sum(), np.nan)
        ax.set_extent(extent, crs=ccrs.PlateCarree())
        ax.pcolormesh(xe, ye, np.log10(h.T), cmap='viridis', vmin=-7, vmax=-2,
                      transform=ccrs.PlateCarree(), rasterized=True)
        ax.add_feature(cfeature.LAND.with_scale('50m'), facecolor='#e6e6e6', zorder=2,
                       rasterized=True)
        ax.add_feature(cfeature.COASTLINE.with_scale('50m'), linewidth=0.3, zorder=3,
                       rasterized=True)
        b = sc.get('bounds')
        if name == 'S' and b:
            ax.plot([b[0], b[2], b[2], b[0], b[0]], [b[1], b[1], b[3], b[3], b[1]],
                    color='#d62728', linewidth=0.8, transform=ccrs.PlateCarree(), zorder=4)
        ax.set_title(title, fontsize=8)
    sm = plt.cm.ScalarMappable(cmap='viridis', norm=plt.Normalize(-7, -2))
    cb = fig.colorbar(sm, ax=axes, orientation='horizontal', fraction=0.05, pad=0.04,
                      aspect=50)
    cb.set_label(r'share of particle positions per $0.05^\circ$ cell ($\log_{10}$)')
    fig.savefig(os.path.join(out, 'eval-reference-maps.pdf'), dpi=200)
    plt.close(fig)


# ─────────────────────────────── phase 1 ────────────────────────────────────

def fig_phase1(out):
    rows = read('reference')
    m_cold = next(r for r in rows if r['name'] == 'M' and num(r['downloaded_mb']) > 0)
    bars = [('M, empty cache', 'M', m_cold), ('M, full cache', 'M', warm('M')),
            ('S, full cache', 'S', warm('S')), ('L, full cache', 'L', warm('L'))]
    fig, ax = plt.subplots(figsize=(WIDTH, 1.9))
    y = np.arange(len(bars))[::-1]
    for yi, (label, name, r) in zip(y, bars):
        f, i, w, total = (num(r['forcing_s']), num(r['integration_s']),
                          num(r['write_s']), num(r['run_s']))
        other = max(total - f - i - w, 0)
        left = 0
        for val, colour, hatch in ((f, '#999999', '////'), (i, COLOURS[name], None),
                                   (w + other, '#dddddd', None)):
            if val > 0:
                ax.barh(yi, val, left=left, color=colour, hatch=hatch,
                        edgecolor='white', linewidth=0.5, height=0.65)
            left += val
        ax.text(total * 1.15, yi, f'{total:,.0f} s', va='center', fontsize=7)
    ax.set_yticks(y)
    ax.set_yticklabels([b[0] for b in bars])
    ax.set_xscale('log')
    ax.set_xlim(1, 3e4)
    ax.set_xlabel('time of a simulation (s, logarithmic)')
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(facecolor='#999999', hatch='////', label='forcing (download or cache)'),
                       Patch(facecolor='#555555', label='integration (colour of the scenario)'),
                       Patch(facecolor='#dddddd', label='setup and writing')],
              loc='upper center', bbox_to_anchor=(0.5, -0.32), ncol=3, frameon=False,
              fontsize=7)
    fig.savefig(os.path.join(out, 'eval-phase1.pdf'))
    plt.close(fig)


def fig_scaling(out):
    ref = read('reference')
    sweep = [r for r in ref if r['name'].startswith('M') and num(r['downloaded_mb']) == 0
             and r['run'] != 'record']
    xs = np.array([num(r['particle_steps']) for r in sweep])
    ys = np.array([num(r['integration_s']) for r in sweep])
    slope, icept = np.polyfit(xs, ys, 1)

    fig, ax = plt.subplots(figsize=(WIDTH * 0.62, 2.7))
    ax.scatter(xs, ys, s=18, color=COLOURS['M'], label='M, 1 000 to 10 000 particles',
               zorder=3)
    for name in ('S', 'L'):
        r = warm(name)
        ax.scatter([num(r['particle_steps'])], [num(r['integration_s'])], s=22,
                   color=COLOURS[name], label=name, zorder=3)
    try:
        remote = read('phase1_remote')
        ax.scatter([num(r['particle_steps']) for r in remote],
                   [num(r['wall_s']) for r in remote], s=18, marker='s', facecolor='none',
                   edgecolor=COLOURS['server'], label='server, whole run', zorder=3)
    except (FileNotFoundError, KeyError):
        pass
    xx = np.logspace(5, 8, 60)
    ax.plot(xx, icept + slope * xx, color='black', linewidth=0.6, linestyle='--',
            label=f'{icept:.0f} s + {slope * 1e6:.1f} $\\mu$s per particle-step')
    ax.set_xscale('log')
    ax.set_yscale('log')
    ax.set_xlabel('particle-steps')
    ax.set_ylabel('integration time (s)')
    ax.legend(frameon=False, loc='upper left', fontsize=7)
    fig.savefig(os.path.join(out, 'eval-scaling.pdf'))
    plt.close(fig)
    return slope, icept


# ─────────────────────────────── phase 2 ────────────────────────────────────

def fig_explore(out):
    """Cost of one more analysis: re-simulate (phase 1 + 2) against phase 2 alone."""
    # Phase 1 on a full cache: the smallest cost a re-simulation could have.
    p1 = {n: num(warm(n)['run_s']) for n in ('S', 'M', 'L')}
    families = [('pmar', 'res=0.1', 'density'),
                ('connectivity', 'transition grid=0.5', 'connectivity'),
                ('markov', 'res=0.25', 'propagation')]
    fig, ax = plt.subplots(figsize=(WIDTH * 0.62, 2.5))
    width = 0.25
    for k, name in enumerate(('S', 'M', 'L')):
        try:
            rows = read(f'analyses_{name}')
        except FileNotFoundError:
            continue
        ratios = []
        for pid, cfg, _ in families:
            # S is smaller than a 0.5 deg cell, so its connectivity grid is 0.25 deg.
            cands = [cfg, cfg.replace('0.5', '0.25')] if pid == 'connectivity' else [cfg]
            r = next((r for c in cands for r in rows
                      if r['process'] == pid and r['config'] == c and r['wall_s_median']), None)
            p2 = num(r['wall_s_median']) if r else math.nan
            ratios.append((p1[name] + p2) / p2)
        xs = np.arange(len(families)) + (k - 1) * width
        ax.bar(xs, ratios, width, color=COLOURS[name], label=name)
        for x, v in zip(xs, ratios):
            if np.isfinite(v):
                ax.text(x, v * 1.08, f'{v:.0f}' if v >= 10 else f'{v:.1f}',
                        ha='center', fontsize=6.5)
    ax.set_yscale('log')
    ax.set_xticks(range(len(families)))
    ax.set_xticklabels([f[2] for f in families])
    ax.set_ylabel('re-simulating / two-phase')
    ax.legend(frameon=False, ncol=3, loc='upper left')
    fig.savefig(os.path.join(out, 'eval-explore.pdf'))
    plt.close(fig)


# ─────────────────────────────── load ───────────────────────────────────────

def fig_load(out, prefix='load'):
    sync = read(f'{prefix}_sync')
    jobs = read(f'{prefix}_jobs')
    fig, axes = plt.subplots(1, 3, figsize=(WIDTH, 2.1))

    c = [num(r['clients']) for r in sync]
    ax = axes[0]
    ax.plot(c, [num(r['median_ms']) for r in sync], 'o-', color=COLOURS['S'],
            markersize=3, label='median')
    ax.plot(c, [num(r['p95_ms']) for r in sync], 's--', color=COLOURS['S'],
            markersize=3, alpha=0.6, label='95th percentile')
    ax.set_xscale('log', base=2)
    ax.set_xticks(c)
    ax.set_xticklabels([f'{x:.0f}' for x in c])
    ax.set_xlabel('simultaneous clients')
    ax.set_ylabel('response time (ms)')
    ax.set_title('(a) synchronous requests')
    ax.set_ylim(0, 300)
    ax2 = ax.twinx()
    ax2.plot(c, [num(r['throughput_rps']) for r in sync], '^:', color='#555555',
             markersize=3, label='requests per second')
    ax2.set_ylim(0, 500)
    ax2.set_ylabel('requests per second', color='#555555')
    ax2.spines['right'].set_visible(True)
    h1, l1 = ax.get_legend_handles_labels()
    h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, ['median (ms)', '95th percentile (ms)', 'requests per second'],
              frameon=False, loc='upper left', fontsize=6.5)

    levels = sorted({int(r['jobs']) for r in jobs})
    med = lambda k, n: statistics.median(num(r[k]) for r in jobs if int(r['jobs']) == n)
    ax = axes[1]
    longest = [med('wait_s_max', n) for n in levels]
    service = statistics.median(num(r['service_s_median']) for r in jobs)
    xx = np.arange(1, max(levels) + 1)
    ax.step(xx, (np.ceil(xx / 3) - 1) * service, where='mid', color='black',
            linewidth=0.6, linestyle='--', label='three slots, predicted')
    ax.plot(levels, longest, 'o', color=COLOURS['M'], markersize=4, label='measured')
    ax.set_xlabel('analyses submitted together')
    ax.set_ylabel('longest wait (s)')
    ax.set_title('(b) waiting for a slot')
    ax.legend(frameon=False, loc='upper left')

    ax = axes[2]
    base = num(sync[0]['median_ms'])
    ax.plot(levels, [med('probe_ms_median', n) for n in levels], 'o-',
            color=COLOURS['L'], markersize=3)
    ax.axhline(base, color='black', linewidth=0.6, linestyle='--')
    ax.text(levels[-1], base * 0.9, 'no analysis', ha='right', va='top', fontsize=7)
    ax.set_ylim(0, base * 2)
    ax.set_xlabel('analyses submitted together')
    ax.set_ylabel('probe response (ms)')
    ax.set_title('(c) API during the analyses')
    fig.tight_layout(w_pad=1.2)
    fig.savefig(os.path.join(out, 'eval-load.pdf'))
    plt.close(fig)


FIGURES = {'maps': fig_maps, 'phase1': fig_phase1, 'scaling': fig_scaling,
           'explore': fig_explore, 'load': fig_load}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out', default=os.path.join(HERE, 'figures'))
    ap.add_argument('names', nargs='*', default=list(FIGURES))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    for name in args.names:
        FIGURES[name](args.out)
        print(f'  {name} -> {args.out}')


if __name__ == '__main__':
    main()
