#!/usr/bin/env python3
"""Benchmark harness for the evaluation chapter.

Each experiment is a subcommand that writes one CSV into ``bench/results/``.
Experiments are grouped by what they cost:

    offline   read artefacts already on disk; no simulation, no API calls
    api       drive the running service; analyses only, seconds each
    net       download from the upstream data service; minutes, and not free
              for them either — run it deliberately, not in a loop
    sim       run a simulation; minutes — use sparingly

Run inside the backend container, which has the dependencies and the volumes::

    docker compose exec backend python -I /app/bench/run.py storage
    docker compose exec backend python -I /app/bench/run.py --help

The point of writing CSV rather than printing is that the numbers in the thesis
must be traceable to a run, and the appendix reproduces the procedure.
"""
import argparse
import csv
import json
import os
import statistics
import sys
import time
import urllib.request as urlreq
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENARIOS = os.path.join(ROOT, 'scenarios')
CACHE = os.path.join(ROOT, 'cache')
RESULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
BASE = os.environ.get('BENCH_BASE', 'http://localhost:5001')


# ─────────────────────────────── output ────────────────────────────────────

def write_csv(name, rows):
    """Write *rows* (list of dicts) to bench/results/<name>.csv and report."""
    if not rows:
        print(f'  {name}: no rows'); return
    os.makedirs(RESULTS, exist_ok=True)
    path = os.path.join(RESULTS, f'{name}.csv')
    keys = list(rows[0].keys())
    with open(path, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=keys, lineterminator='\n')
        w.writeheader()
        w.writerows(rows)
    print(f'  -> {path}  ({len(rows)} rows)')


def summarise(values):
    """Median and interquartile range, or the single value when there is one.

    Reporting an IQR for a single observation would be a lie, so this returns
    None for the spread and the caller must say so.
    """
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None, None
    if len(vals) == 1:
        return vals[0], None
    q = statistics.quantiles(vals, n=4) if len(vals) >= 4 else None
    return statistics.median(vals), (q[2] - q[0]) if q else (max(vals) - min(vals))


# ─────────────────────────────── API client ────────────────────────────────

class Api:
    """Minimal OGC API - Processes client: submit, poll, collect."""

    def __init__(self, base=BASE):
        self.base = base.rstrip('/')

    def _json(self, url, data=None, headers=None, timeout=120):
        req = urlreq.Request(url, data=data, headers=headers or {})
        with urlreq.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b'{}')

    def submit(self, pid, inputs, async_=True):
        """Submit a process execution; returns (job_id, elapsed_seconds)."""
        hdr = {'Content-Type': 'application/json'}
        if async_:
            hdr['Prefer'] = 'respond-async'
        body = json.dumps({'inputs': inputs}).encode()
        t0 = time.monotonic()
        try:
            _, headers, _ = self._json(f'{self.base}/processes/{pid}/execution', body, hdr)
        except Exception as e:
            raise RuntimeError(f'{pid} submit failed: {e}') from e
        loc = headers.get('Location')
        return (loc.rsplit('/', 1)[-1] if loc else None), time.monotonic() - t0

    def wait(self, job_id, limit=1800):
        """Poll until terminal; returns the job record."""
        for _ in range(limit):
            _, _, d = self._json(f'{self.base}/jobs/{job_id}?f=json', timeout=60)
            if d.get('status') in ('successful', 'failed', 'dismissed'):
                return d
            time.sleep(1)
        return {'status': 'TIMEOUT'}

    def results(self, job_id):
        _, _, d = self._json(f'{self.base}/jobs/{job_id}/results?f=json', timeout=300)
        return d

    def run(self, pid, inputs):
        """Submit, wait, collect. Returns (record, results, wall_seconds)."""
        t0 = time.monotonic()
        job, _ = self.submit(pid, inputs)
        rec = self.wait(job)
        wall = time.monotonic() - t0
        res = self.results(job) if rec.get('status') == 'successful' else None
        return rec, res, wall

    def latency(self, pid, inputs, n):
        """Time n synchronous calls; returns the list of elapsed seconds."""
        out = []
        for _ in range(n):
            t0 = time.monotonic()
            try:
                self._json(f'{self.base}/processes/{pid}/execution',
                           json.dumps({'inputs': inputs}).encode(),
                           {'Content-Type': 'application/json'}, timeout=120)
                out.append(time.monotonic() - t0)
            except Exception:
                out.append(None)
        return out


def scenarios():
    """Every scenario metadata record on disk."""
    out = []
    for f in sorted(os.listdir(SCENARIOS)):
        if not f.endswith('.json'):
            continue
        try:
            out.append(json.load(open(os.path.join(SCENARIOS, f))))
        except Exception:
            pass
    return out


# ───────────────────────────── offline experiments ─────────────────────────

def exp_storage(args):
    """Trajectory file size as a function of particles, steps and pressure model.

    Costs nothing: the scenarios are already on disk. The interesting quantity is
    bytes per particle per output step, which should be constant within a
    pressure model and differ between models.
    """
    rows = []
    for sc in scenarios():
        total = 0
        for nc in sc.get('nc_filenames', []):
            p = os.path.join(SCENARIOS, nc)
            if os.path.exists(p):
                total += os.path.getsize(p)
        if not total:
            continue
        pnum, days = sc.get('pnum', 0), sc.get('duration_days', 0)
        step = sc.get('time_step_hours') or 1
        seedings = sc.get('seedings', 1)
        steps = days * 24 / step
        denom = pnum * steps * seedings
        rows.append({
            'scenario_id': sc['scenario_id'],
            'pressure': sc.get('pressure'),
            'pnum': pnum, 'duration_days': days, 'time_step_hours': step,
            'seedings': seedings, 'output_steps': int(steps),
            'bytes_total': total,
            'mb_total': round(total / 1e6, 1),
            'bytes_per_particle_step': round(total / denom, 2) if denom else '',
        })
    rows.sort(key=lambda r: (str(r['pressure']), r['pnum'], r['duration_days']))
    write_csv('storage', rows)

    # Raggruppare per modello di pressione, e segnalare gli scostamenti forti con
    # un criterio dichiarato invece che a occhio: la provenienza di uno scenario
    # non è registrata in modo affidabile, quindi non la si indovina.
    by = {}
    for r in rows:
        if r['bytes_per_particle_step'] != '':
            by.setdefault(r['pressure'], []).append(r)
    print('  bytes per particle per output step:')
    for k, group in sorted(by.items()):
        vals = [r['bytes_per_particle_step'] for r in group]
        med, spread = summarise(vals)
        print(f'    {k:10} n={len(vals):>2}  median {med:5.1f}' +
              (f'  IQR {spread:.1f}' if spread is not None else '  (single run)'))
        if spread:
            out = [r for r in group
                   if abs(r['bytes_per_particle_step'] - med) > 1.5 * spread]
            for r in out:
                print(f'      outlier: {r["scenario_id"]} = '
                      f'{r["bytes_per_particle_step"]} '
                      f'({r["duration_days"]}d, {r["time_step_hours"]}h step, '
                      f'{r["seedings"]} seedings)')


def exp_cachekey(args):
    """What the cache key normalisation absorbs, and what it does not.

    No downloads: requests are passed through the real key function and the
    distinct keys are counted. Rather than inventing one usage model and
    reporting a single hit rate that depends on it, this varies one dimension of
    the request at a time and reports how many downloads each variation causes.

    The design (:func:`_cache_key`) snaps the bounding box out to integer
    degrees and the start time down to midnight, rounding the duration up to
    whole days. So the prediction is that it absorbs variation in start hour and
    in area within a degree cell, and absorbs nothing else. The experiment tests
    that prediction rather than assuming it.
    """
    sys.path.insert(0, ROOT)
    from processes.OpenDriftProcess import _cache_key
    import random

    rng = random.Random(args.seed)
    BASE_LON, BASE_LAT = 12.4, 44.6          # a release area in the N. Adriatic
    BASE_START = datetime(2024, 3, 3, 8, 0)
    BASE_DAYS, HALF = 7, 0.25

    def key(lon=BASE_LON, lat=BASE_LAT, start=BASE_START, days=BASE_DAYS, half=HALF):
        path, *_ = _cache_key(lon - half, lon + half, lat - half, lat + half,
                              start, start + timedelta(days=days),
                              suffix='cur', max_depth=0.5, margin=5.0)
        return os.path.basename(path)

    n = args.n
    variations = [
        ('identical request repeated', 'none',
         [key() for _ in range(n)]),
        ('start hour varies', 'absorbed by design',
         [key(start=BASE_START.replace(hour=rng.randrange(24))) for _ in range(n)]),
        ('area moves within one degree cell', 'absorbed by design',
         [key(lon=12.0 + rng.uniform(0.3, 0.7), lat=44.0 + rng.uniform(0.3, 0.7))
          for _ in range(n)]),
        ('area moves across degree cells', 'not absorbed',
         [key(lon=BASE_LON + rng.uniform(-3, 3), lat=BASE_LAT + rng.uniform(-1, 1))
          for _ in range(n)]),
        ('start day varies over a month', 'not absorbed',
         [key(start=BASE_START + timedelta(days=rng.randrange(30))) for _ in range(n)]),
        ('duration varies (7/14/30 d)', 'not absorbed',
         [key(days=rng.choice([7, 14, 30])) for _ in range(n)]),
    ]

    rows = []
    for label, expected, keys in variations:
        distinct = len(set(keys))
        rows.append({
            'variation': label, 'expected': expected, 'requests': len(keys),
            'distinct_downloads': distinct,
            'hit_rate': round(1 - distinct / len(keys), 4),
        })
    write_csv('cachekey', rows)
    print(f'  {n} requests per variation, one dimension varied at a time')
    print(f"  {'variation':36} {'downloads':>10} {'hit rate':>9}   expectation")
    for r in rows:
        print(f"  {r['variation']:36} {r['distinct_downloads']:>10} "
              f"{r['hit_rate']:>8.1%}   {r['expected']}")


def exp_convergence(args):
    """Propagated against directly simulated distributions, over horizons.

    Ch. 5 reports a single unfavourable configuration and asks for this
    experiment before drawing a usable conclusion. The design it specifies: fix
    area, duration and dt; vary the particle count so that particles per cell
    span an order of magnitude around the 30 the platform recommends; at each
    setting compare the propagated distribution with the simulated one at a
    sequence of horizons.

    The criteria are fixed here, before any run, because deciding them after
    seeing the curves would make them worthless:

        AGREE   total variation distance <= 0.10
        USABLE  total variation distance <= 0.25
        BEYOND  the first horizon above 0.25, which is the trust limit reported

    Total variation distance is taken between the two distributions *restricted
    to the domain and renormalised*, so that it measures misplacement of the
    material still in play and does not double-count the absorbed mass, which
    is reported separately in the same row. Both are needed: a chain can hold
    the right shape while losing the wrong amount of mass, and the Black Sea
    configuration of ch. 5 does exactly that.

    Nothing here is simulated. It reads scenarios already on disk and uses the
    same library functions the markov process uses, so what is measured is the
    formulation rather than a separate implementation of it.
    """
    sys.path.insert(0, ROOT)
    import numpy as np
    from processes import markov_core as mk
    from processes.ConnectivityProcess import _load_scenario
    from processes.MarkovProcess import _positions

    AGREE, USABLE = 0.10, 0.25
    rows = []
    combos = [(sid, res, dt, nsub) for sid in args.scenarios
              for res in args.res for dt in args.dt for nsub in args.subsample]
    for sid, res, dt, nsub in combos:
        sc, nc_list = _load_scenario(sid)
        step_h = float(sc.get('time_step_hours') or 1)
        dt_steps = max(1, int(round(dt * 24.0 / step_h)))
        dt_days = dt_steps * step_h / 24.0
        bounds = args.bbox or sc.get('bounds')
        grid = mk.Grid(bounds, res)

        # How many output steps the shortest release has, so every horizon
        # compared below has a simulated counterpart in every release.
        import xarray as xr
        n_time = min(int(xr.open_dataset(nc).sizes['time']) for nc in nc_list)
        k_max = (n_time - 1) // dt_steps
        if k_max < 2:
            print(f'  {sid} res={res} dt={dt_days:g}d: {k_max} horizons; skipped')
            continue
        steps = [k * dt_steps for k in range(k_max + 1)]

        per_seed = [_positions(nc, steps, grid) for nc in nc_list]

        # Varying the particle count at fixed area, duration, grid and dt. A
        # random subset of the trajectories of an existing run is distributed
        # exactly as a smaller run would have been, because the particles are
        # seeded independently and a passive tracer does not interact with its
        # neighbours; for a model with interaction this shortcut would be wrong.
        if nsub:
            rng = np.random.default_rng(args.seed)
            sliced = []
            for cells in per_seed:
                n = len(next(iter(cells.values())))
                if nsub > n:
                    sliced = None
                    break
                take = rng.choice(n, size=nsub, replace=False)
                sliced.append({k: v[take] for k, v in cells.items()})
            if sliced is None:
                print(f'  {sid}: {nsub} exceeds the {n} particles available; skipped')
                continue
            per_seed = sliced

        M, dom, Ni = mk.transition_matrix([c[0] for c in per_seed],
                                          [c[dt_steps] for c in per_seed], grid.size)
        q0 = Ni / len(nc_list)
        frames = mk.propagate(M, q0, k_max)

        to_dom = np.full(grid.size, -1, dtype=np.int64)
        to_dom[dom] = np.arange(len(dom))
        occupied = int((Ni > 0).sum())
        per_cell = float(np.median(Ni[Ni > 0])) / len(nc_list)
        m0 = q0.sum()
        breach = None
        # The short-dt diagnostic the markov process warns on: the median share
        # of a cell's particles still in it after one interval.
        stay = M.diagonal()[Ni > 0]
        median_stay = float(np.median(stay)) if len(stay) else float('nan')

        for k, step in enumerate(steps):
            # simulated: where the particles actually are at k*dt
            sim = np.zeros(len(dom))
            for cells in per_seed:
                idx = cells[step]
                inside = idx[idx >= 0]
                d = to_dom[inside]
                np.add.at(sim, d[d >= 0], 1.0)
            sim /= len(nc_list)
            prop = frames[k]
            a_sim = 1.0 - sim.sum() / m0
            a_prop = 1.0 - prop.sum() / m0
            if sim.sum() > 0 and prop.sum() > 0:
                tvd = 0.5 * float(np.abs(sim / sim.sum() - prop / prop.sum()).sum())
            else:
                tvd = float('nan')
            if breach is None and tvd > USABLE:
                breach = round(k * dt_days, 1)
            rows.append({
                'scenario': sid, 'res': res, 'dt_days': dt_days,
                'median_stay': round(median_stay, 4),
                'releases': len(nc_list),
                'particles': nsub or sc.get('pnum'),
                'domain_cells': len(dom), 'occupied_cells': occupied,
                'particles_per_cell': round(per_cell, 1),
                'k': k, 'day': round(k * dt_days, 1),
                'tvd': round(tvd, 4),
                'absorbed_sim': round(a_sim, 4),
                'absorbed_prop': round(a_prop, 4),
                'absorbed_gap': round(a_prop - a_sim, 4),
                'verdict': ('agree' if tvd <= AGREE else
                            'usable' if tvd <= USABLE else 'beyond'),
            })
        last = rows[-1]
        print(f"  {sid}  res={res}  dt={dt_days:g}d  n={nsub or sc.get('pnum')}  "
              f"{per_cell:5.1f} p/cell over "
              f"{occupied} occupied cells ({len(dom)} in domain), {k_max} horizons, "
              f"median stay {median_stay:.2f}")
        print(f"      tvd at the last horizon {last['tvd']:.3f}, "
              f"absorbed sim {last['absorbed_sim']:.1%} vs prop "
              f"{last['absorbed_prop']:.1%}, gap {last['absorbed_gap']:+.1%}")
        print(f"      trust limit (tvd > {USABLE}): "
              + (f'{breach:g} d' if breach is not None else 'not reached'))
    write_csv(args.out, rows)


def exp_load(args):
    """Response times as the number of simultaneous users grows.

    Two sweeps, both against the local service only. Predictions, fixed before
    the runs:

      synchronous   c clients each send `--requests` synchronous requests at
                    the same time. The API runs gevent workers, so latency
                    should stay nearly flat while throughput rises.
      analyses      c analysis jobs are submitted at once. The analysis queue
                    has three slots, so jobs 1-3 should start at once and the
                    rest should wait in steps of one service time per three
                    jobs. The job record's created/started/finished times
                    separate the wait in the queue from the service itself:
                    the client polls every half second and records when the
                    job first reports running, because the job record's own
                    `started` field is written when the job is created.
                    While each burst runs, a probe keeps sending synchronous
                    requests, to see whether the queue slows down the API.

    Never point this at a shared deployment: it is a load test.
    """
    from concurrent.futures import ThreadPoolExecutor
    import threading

    # The proxy allows each client address 5 requests per second, so load sent
    # through it from one machine would only measure that limit. Run this from a
    # container on the stack's network instead, against the API process itself:
    #   docker run --rm --network dto-pmar_internal -v "$PWD/bench:/bench" \
    #     -e BENCH_BASE=http://backend:5001 --entrypoint python \
    #     dto-pmar-backend -u /bench/run.py load
    api = Api()
    from urllib.parse import urlparse
    if urlparse(api.base).hostname not in ('localhost', '127.0.0.1', 'backend'):
        raise SystemExit('refusing to run a load test against a non-local service')

    def run_tracked(pid, inputs, poll=0.5):
        """Submit, then poll: returns (status, wait_s, service_s, total_s)."""
        t0 = time.monotonic()
        job, _ = api.submit(pid, inputs)
        t_run = None
        while True:
            _, _, d = api._json(f'{api.base}/jobs/{job}?f=json', timeout=60)
            st = d.get('status')
            now = time.monotonic()
            if t_run is None and st != 'accepted':
                t_run = now
            if st in ('successful', 'failed', 'dismissed'):
                return st, t_run - t0, now - t_run, now - t0
            time.sleep(poll)

    # The default probe is the process list, which the API layer answers on its
    # own. The scenario listing also asks an external service for its area list,
    # so its latency follows that service as well as this one.
    def sync_once():
        t = time.monotonic()
        if args.probe == 'processes':
            api._json(f'{api.base}/processes?f=json', timeout=120)
        else:
            api._json(f'{api.base}/processes/scenario_status/execution',
                      json.dumps({'inputs': {}}).encode(),
                      {'Content-Type': 'application/json'}, timeout=120)
        return time.monotonic() - t

    def sync_or_none():
        try:
            return sync_once()
        except Exception:
            return None

    def pct(vals, q):
        v = sorted(vals)
        return v[min(len(v) - 1, int(round(q * (len(v) - 1))))]

    rows_sync, rows_jobs = [], []

    # ---- synchronous sweep
    for c in args.sync_levels:
        t0 = time.monotonic()
        with ThreadPoolExecutor(c) as ex:
            res = list(ex.map(lambda _: sync_or_none(), range(c * args.requests)))
        span = time.monotonic() - t0
        lat = [x for x in res if x is not None]
        med, iqr = summarise(lat)
        rows_sync.append({'clients': c, 'requests': len(res), 'errors': len(res) - len(lat),
                          'median_ms': round(med * 1000, 1),
                          'iqr_ms': round(iqr * 1000, 1) if iqr is not None else '',
                          'p95_ms': round(pct(lat, 0.95) * 1000, 1),
                          'throughput_rps': round(len(lat) / span, 1)})
        r = rows_sync[-1]
        print(f"  sync  c={c:>3}  median {r['median_ms']:>6} ms  p95 {r['p95_ms']:>6} ms  "
              f"{r['throughput_rps']:>6} req/s")

    # ---- analysis sweep, with a synchronous probe running alongside
    job_inputs = {'scenario_id': args.scenario, 'grid_res': 0.5, 'mode': 'transition'}
    for rep in range(args.repeat):
        for c in args.job_levels:
            stop, probe, probe_err = threading.Event(), [], []

            def prober():
                while not stop.is_set():
                    x = sync_or_none()
                    (probe if x is not None else probe_err).append(x)
                    time.sleep(0.2)

            th = threading.Thread(target=prober, daemon=True)
            th.start()
            t0 = time.monotonic()
            try:
                with ThreadPoolExecutor(c) as ex:
                    results = list(ex.map(lambda _: run_tracked('connectivity', job_inputs),
                                          range(c)))
            finally:
                stop.set(); th.join()
            span = time.monotonic() - t0
            waits = [r[1] for r in results]
            services = [r[2] for r in results]
            ends = [r[3] for r in results]
            ok = sum(1 for r in results if r[0] == 'successful')
            pm, pi = summarise(probe) if probe else (None, None)
            rows_jobs.append({
                'repeat': rep, 'jobs': c, 'successful': ok,
                'wait_s_median': round(statistics.median(waits), 2) if waits else '',
                'wait_s_max': round(max(waits), 2) if waits else '',
                'service_s_median': round(statistics.median(services), 2) if services else '',
                'end_to_end_s_median': round(statistics.median(ends), 2),
                'makespan_s': round(span, 1),
                'probe_ms_median': round(pm * 1000, 1) if pm else '',
                'probe_ms_iqr': round(pi * 1000, 1) if pi is not None else '',
                'probe_n': len(probe),
                'probe_errors': len(probe_err),
            })
            r = rows_jobs[-1]
            print(f"  jobs  rep={rep} c={c:>3}  ok {ok}/{c}  wait med {r['wait_s_median']:>6}s "
                  f"max {r['wait_s_max']:>6}s  service {r['service_s_median']:>6}s  "
                  f"makespan {r['makespan_s']:>6}s  probe {r['probe_ms_median']} ms")

    write_csv(args.out + '_sync', rows_sync)
    write_csv(args.out + '_jobs', rows_jobs)


def exp_validation(args):
    """Decompose the propagation error: noise floor, hold-out, seasonality.

    The convergence experiment compares the chain with the simulation it was
    estimated from. This one answers the questions that comparison leaves
    open, on the same stored scenarios and with no new simulation.

      noise floor     the particles of every release are split at random into
                      halves A and B. The distance between the simulated
                      distributions of A and B is pure sampling noise, what two
                      identical simulations with different seeds disagree by.
      hold-out        the chain is estimated on A and compared with B, which it
                      has never seen.
      baselines       persistence (material stays where it started) and a
                      uniform spread over the occupied cells.
      seasonality     on the first release alone, two chains are compared with
                      the same reference. The stationary one uses the matrix of
                      the release's own first interval at every step. The
                      seasonal one uses, for the interval starting on a given
                      day, the first-interval matrix of the release that started
                      closest before that day: right season, but particles that
                      were seeded fresh, uniformly, so it still carries the
                      no-memory error. What the seasonal chain removes is the
                      error of using one season's currents for all of them.

    A chain with one matrix per interval fitted to the same particles is not
    used: it reproduces their distribution exactly, by construction, so it
    would show nothing but the noise floor.

    All distances are total variation over in-domain distributions,
    renormalised, on the full grid index space.
    """
    sys.path.insert(0, ROOT)
    import numpy as np
    import xarray as xr
    from scipy.sparse import coo_array, diags
    from processes import markov_core as mk
    from processes.ConnectivityProcess import _load_scenario
    from processes.MarkovProcess import _positions

    def tvd(a, b):
        sa, sb = a.sum(), b.sum()
        if sa <= 0 or sb <= 0:
            return float('nan')
        return 0.5 * float(np.abs(a / sa - b / sb).sum())

    def matrix_T(c0, c1, n):
        ok = c0 >= 0
        i, j = c0[ok], c1[ok]
        stay = j >= 0
        N = coo_array((np.ones(int(stay.sum())), (i[stay], j[stay])), shape=(n, n)).tocsr()
        Ni = np.bincount(i, minlength=n).astype(float)
        inv = np.divide(1.0, Ni, out=np.zeros_like(Ni), where=Ni > 0)
        return (diags(inv) @ N).T.tocsr()

    def hist(cells, n):
        c = cells[cells >= 0]
        return np.bincount(c, minlength=n).astype(float)

    pooled, seasonal = [], []
    for sid in args.scenarios:
        sc, nc_list = _load_scenario(sid)
        step_h = float(sc.get('time_step_hours') or 1)
        dt_steps = max(1, int(round(args.dt * 24.0 / step_h)))
        dt_days = dt_steps * step_h / 24.0
        tshift = float(sc.get('tshift') or 0)
        grid = mk.Grid(args.bbox or sc.get('bounds'), args.res)
        n = grid.size
        n_time = min(int(xr.open_dataset(nc).sizes['time']) for nc in nc_list)
        k_max = (n_time - 1) // dt_steps
        steps = [k * dt_steps for k in range(k_max + 1)]

        rng = np.random.default_rng(args.seed)
        RA, RB = [], []            # per release: {step: cells} for halves A and B
        for nc in nc_list:
            cells = _positions(nc, steps, grid)
            m = len(cells[0])
            perm = rng.permutation(m)
            a, b = perm[: m // 2], perm[m // 2:]
            RA.append({s: cells[s][a] for s in steps})
            RB.append({s: cells[s][b] for s in steps})
        half = len(RA[0][0])

        # ---- pooled over releases: floor, in-sample, hold-out, baselines
        A = {s: np.concatenate([r[s] for r in RA]) for s in steps}
        B = {s: np.concatenate([r[s] for r in RB]) for s in steps}
        simA = {s: hist(A[s], n) for s in steps}
        simB = {s: hist(B[s], n) for s in steps}
        q0 = simA[0].copy(); m0 = q0.sum()
        uniform = (q0 > 0).astype(float)
        PT = matrix_T(A[0], A[dt_steps], n)
        q = q0.copy()
        for k, s in enumerate(steps):
            if k:
                q = PT @ q
            pooled.append({
                'scenario': sid, 'res': args.res, 'dt_days': dt_days,
                'particles_per_half_release': half, 'k': k, 'day': round(k * dt_days, 1),
                'noise_floor': round(tvd(simA[s], simB[s]), 4),
                'chain_insample': round(tvd(q, simA[s]), 4),
                'chain_holdout': round(tvd(q, simB[s]), 4),
                'persistence': round(tvd(q0, simB[s]), 4),
                'uniform': round(tvd(uniform, simB[s]), 4),
                'absorbed_sim': round(1 - simB[s].sum() / simB[0].sum(), 4),
                'absorbed_chain': round(1 - q.sum() / m0, 4),
            })

        # ---- first release only: stationary against season-matched chain
        if len(nc_list) > 1 and tshift > 0:
            first = [matrix_T(r[0], r[dt_steps], n) for r in RA]   # one per release
            a0, b0 = RA[0], RB[0]
            p0 = hist(a0[0], n)
            sA = {s: hist(a0[s], n) for s in steps}
            sB = {s: hist(b0[s], n) for s in steps}
            q_st, q_se = p0.copy(), p0.copy()
            used = []
            for k, s in enumerate(steps):
                if k:
                    start_day = (k - 1) * dt_days
                    r = min(int(start_day // tshift), len(first) - 1)
                    used.append(r)
                    q_st = first[0] @ q_st
                    q_se = first[r] @ q_se
                seasonal.append({
                    'scenario': sid, 'res': args.res, 'dt_days': dt_days, 'tshift': tshift,
                    'k': k, 'day': round(k * dt_days, 1),
                    'release_matrix_used': used[-1] if k else 0,
                    'noise_floor': round(tvd(sA[s], sB[s]), 4),
                    'stationary': round(tvd(q_st, sB[s]), 4),
                    'season_matched': round(tvd(q_se, sB[s]), 4),
                    'persistence': round(tvd(p0, sB[s]), 4),
                })

        print(f"  {sid}: {k_max} horizons of {dt_days:g} d, {half} particles per release in each half")
        print(f"  pooled   {'day':>5} {'floor':>6} {'in-smp':>6} {'hold':>6} {'persist':>7} {'unif':>6}")
        for r in pooled[-(k_max + 1):]:
            print(f"           {r['day']:>5} {r['noise_floor']:>6} {r['chain_insample']:>6} "
                  f"{r['chain_holdout']:>6} {r['persistence']:>7} {r['uniform']:>6}")
        if seasonal and seasonal[-1]['scenario'] == sid:
            print(f"  release0 {'day':>5} {'floor':>6} {'station':>7} {'season':>6} {'persist':>7}  matrix")
            for r in seasonal[-(k_max + 1):]:
                print(f"           {r['day']:>5} {r['noise_floor']:>6} {r['stationary']:>7} "
                      f"{r['season_matched']:>6} {r['persistence']:>7}  r{r['release_matrix_used']}")
    write_csv(args.out, pooled)
    if seasonal:
        write_csv(args.out + '_seasonal', seasonal)


def exp_forcing(args):
    """Cold forcing retrieval against requested volume.

    EQ3 establishes that a *small* cold request is almost all round trip: 0.2 MB
    took 30.9 s. That cannot be extrapolated, so this sweeps the period over the
    same area and fits time against bytes, separating the constant from the
    volume term and reporting where they cross.

    Two shapes are swept because the platform downloads two: the surface case,
    hourly and effectively two-dimensional, and the vertically resolved case,
    which the planner serves with a daily product over a depth range. Every
    repetition writes to a fresh temporary file, so every one is cold; nothing
    enters the real cache.

    This is the one experiment whose absolute numbers do not transfer: it
    measures a network and an upstream service at a moment in time. What is
    meant to transfer is the shape, a constant plus a proportional term, and the
    order of magnitude of the crossing point.
    """
    import shutil
    import tempfile

    sys.path.insert(0, ROOT)
    import data.cmems_select as cms
    from processes.OpenDriftProcess import _request_box, _subset, SURFACE_DEPTH_M

    # The release rectangle of the isolation experiment, so the area is one the
    # thesis already specifies, with the margin the interface defaults to.
    box = _request_box(12.4, 13.4, 44.6, 45.2, 2.0)
    START = datetime(2026, 9, 15)
    catalog = cms.load_catalog()
    tmpdir = tempfile.mkdtemp(prefix='bench-forcing-')
    rows = []
    try:
        shapes = [('surface', False, True, SURFACE_DEPTH_M),
                  ('3-D', True, False, 200.0)]
        for mode, vertical, hourly, dmax in [x for x in shapes if x[0] in args.modes]:
            for days in args.days:
                t0, t1 = START, START + timedelta(days=days)
                plan = cms.plan_family('cur', box, t0, t1, hourly=hourly,
                                       vertical=vertical, catalog=catalog)
                if not plan:
                    print(f'  {mode} {days}d: no dataset covers this request')
                    continue
                # A plan may name several datasets: a release area whose box
                # reaches past a regional product's extent is covered by two.
                # What a simulation pays is the whole plan, so that is measured.
                secs, mbs, failed = [], [], False
                for rep in range(args.repeat):
                    t, total = time.monotonic(), 0
                    for k, entry in enumerate(plan):
                        path = os.path.join(tmpdir, f'{mode}_{days}_{rep}_{k}.nc')
                        try:
                            _subset(entry, box, t0, t1, (0, dmax), path)
                        except Exception as e:                  # noqa: BLE001
                            print(f'  {mode} {days}d rep{rep} [{entry["dataset_id"]}]: '
                                  f'FAILED {type(e).__name__}: {e}')
                            failed = True
                            break
                        total += os.path.getsize(path)
                        os.remove(path)
                    if failed:
                        break
                    secs.append(time.monotonic() - t)
                    mbs.append(total / 1e6)
                if not secs:
                    continue
                med_s, spread_s = summarise(secs)
                rows.append({
                    'mode': mode, 'days': days, 'datasets': len(plan),
                    'dataset_ids': ' + '.join(e['dataset_id'] for e in plan),
                    'dims': plan[0]['dims'], 'step_h': plan[0]['step_h'],
                    'repeats': len(secs), 'mb': round(statistics.median(mbs), 2),
                    'wall_s_median': round(med_s, 1),
                    'wall_s_spread': round(spread_s, 1) if spread_s is not None else '',
                    'mb_per_s': round(statistics.median(mbs) / med_s, 3),
                })
                print(f"  {mode:8} {days:3}d  {len(plan)} dataset(s)  "
                      f"{rows[-1]['mb']:8.2f} MB  {med_s:7.1f}s  "
                      f"{rows[-1]['mb_per_s']:6.3f} MB/s")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    write_csv(args.out, rows)

    # Least-squares fit of time = fixed + rate * bytes, per mode.
    for mode in sorted({r['mode'] for r in rows}):
        pts = [(r['mb'], r['wall_s_median']) for r in rows if r['mode'] == mode]
        if len(pts) < 2:
            continue
        n = len(pts)
        sx = sum(x for x, _ in pts); sy = sum(y for _, y in pts)
        sxx = sum(x * x for x, _ in pts); sxy = sum(x * y for x, y in pts)
        den = n * sxx - sx * sx
        if den == 0:
            continue
        slope = (n * sxy - sx * sy) / den
        fixed = (sy - slope * sx) / n
        print(f'  {mode}: fixed {fixed:.1f}s + {slope:.3f}s/MB'
              + (f'; the volume term overtakes the constant at '
                 f'{fixed / slope:.0f} MB' if slope > 0 else ''))


def exp_containment(args):
    """What the containment lookup absorbs that the key could not.

    The key of :func:`exp_cachekey` identifies one request, so it can only
    collide requests that normalise to the same thing. The lookup that replaced
    it asks a different question: is there any cached file whose product, box,
    period and depth *contain* this request? That makes the answer depend on
    what was downloaded before, so the unit of this experiment is a request
    *sequence*, not a request.

    No downloads. The real ``find_cached``/``record_cached`` run against a
    temporary cache directory holding empty .nc files and genuine sidecars, so
    what is measured is the shipped lookup rather than a restatement of it.

    Two caveats, both of which make the result conservative. A sidecar records
    the extent actually downloaded, which is at least the extent requested,
    because a subset snaps outward to the product's grid and time axis; here it
    records the request, so real containment is slightly better than measured.
    And the lookup cannot absorb a request that precedes the larger one that
    would have covered it, which is why an adverse ordering is included below
    rather than left for a reader to wonder about.
    """
    import random
    import shutil
    import tempfile

    tmp = tempfile.mkdtemp(prefix='bench-containment-')
    os.environ['CMEMS_CACHE_DIR'] = tmp          # read at import time
    sys.path.insert(0, ROOT)
    import data.cmems_select as cms
    from processes.OpenDriftProcess import _cache_key, _request_box, _request_period
    assert cms.CACHE_DIR == tmp, 'cache dir override did not take effect'

    DSET = 'cmems_mod_med_phy-cur_anfc_4.2km_PT1H-m'
    VARS = ['uo', 'vo']
    BASE_LON, BASE_LAT = 12.4, 44.6
    BASE_START = datetime(2024, 3, 3, 8, 0)

    def request(lon=BASE_LON, lat=BASE_LAT, start=BASE_START, days=7,
                half=0.25, margin=5.0, depth=0.5):
        """One forcing request, as each design really sees it.

        Both normalisations are the shipped ones: ``_request_box`` and
        ``_request_period`` widen the request on the current path exactly as
        they do in production, and ``_cache_key`` is the superseded design the
        chapter's key column measures.
        """
        box = _request_box(lon - half, lon + half, lat - half, lat + half, margin)
        need0, need1, _ = _request_period(start, start + timedelta(days=days))
        path, *_ = _cache_key(lon - half, lon + half, lat - half, lat + half,
                              start, start + timedelta(days=days),
                              suffix='cur', max_depth=depth, margin=margin)
        return os.path.basename(path), (box, need0, need1, depth)

    def replay(reqs):
        """Distinct downloads under each design, over the same sequence."""
        for f in os.listdir(tmp):
            os.remove(os.path.join(tmp, f))
        keys, downloads = set(), 0
        for key, (box, t0, t1, depth) in reqs:
            keys.add(key)
            if cms.find_cached(DSET, VARS, box, t0, t1, depth) is None:
                downloads += 1
                nc = os.path.join(tmp, f'cmems_bench_{downloads:04d}.nc')
                open(nc, 'wb').close()
                cms.record_cached(nc, {
                    'family': 'cur', 'dataset_id': DSET, 'variables': VARS,
                    'basin': 'med', 'bbox': box, 'depth_max': depth,
                    'time': [t0.isoformat(), t1.isoformat()],
                })
        return len(keys), downloads

    rng = random.Random(args.seed)
    n = args.n

    def seq(**kw):
        return [request(**{k: v() if callable(v) else v for k, v in kw.items()})
                for _ in range(n)]

    # The prediction column is what each design's argument says should happen,
    # fixed before the run. Three of them turned out wrong; the chapter says which.
    cases = [
        # the six variations of exp_cachekey, replayed through the lookup
        ('identical request repeated', 'no variation',
         seq()),
        ('start hour varies', 'key',
         seq(start=lambda: BASE_START.replace(hour=rng.randrange(24)))),
        ('area moves within one degree cell', 'key',
         seq(lon=lambda: 12.0 + rng.uniform(0.3, 0.7),
             lat=lambda: 44.0 + rng.uniform(0.3, 0.7))),
        ('area moves across degree cells', 'neither',
         seq(lon=lambda: BASE_LON + rng.uniform(-3, 3),
             lat=lambda: BASE_LAT + rng.uniform(-1, 1))),
        ('start day varies over a month', 'neither',
         seq(start=lambda: BASE_START + timedelta(days=rng.randrange(30)))),
        ('duration varies (7/14/30 d)', 'containment',
         seq(days=lambda: rng.choice([7, 14, 30]))),
        # sequences in which a larger request comes first: what containment is for
        ('shorter period after a 30-day one', 'containment',
         [request(days=30)] + [request(start=BASE_START + timedelta(days=rng.randrange(23)),
                                       days=7) for _ in range(n)]),
        ('narrower margin after a wide one', 'containment',
         [request(margin=5.0)] + [request(margin=rng.choice([0.0, 1.0, 2.0]))
                                  for _ in range(n)]),
        ('surface after a 200 m request', 'containment',
         [request(depth=200.0)] + [request(depth=0.5) for _ in range(n)]),
        # and the ordering under which containment buys nothing
        ('periods lengthening, 7 to 30 days', 'neither',
         [request(days=d) for d in range(7, 7 + n)]),
    ]

    rows = []
    for label, absorbed_by, reqs in cases:
        k, c = replay(reqs)
        rows.append({'variation': label, 'predicted': absorbed_by,
                     'requests': len(reqs), 'key_downloads': k,
                     'containment_downloads': c,
                     'key_hit_rate': round(1 - k / len(reqs), 4),
                     'containment_hit_rate': round(1 - c / len(reqs), 4)})
    shutil.rmtree(tmp, ignore_errors=True)
    write_csv('containment', rows)
    print(f"  {'variation':36} {'key':>6} {'contain':>8}   predicted")
    for r in rows:
        print(f"  {r['variation']:36} {r['key_downloads']:>6} "
              f"{r['containment_downloads']:>8}   {r['predicted']}")


def exp_cachedir(args):
    """Composition and growth of the forcing cache, from the files on disk."""
    rows = []
    for f in sorted(os.listdir(CACHE)):
        if not f.endswith('.nc'):
            continue
        path = os.path.join(CACHE, f)
        parts = f.replace('.nc', '').split('_')
        kind = next((p for p in parts if p in ('cur', 'wind', 'wav', 'tem', 'mld', 'bathy')), '?')
        days = next((p[:-1] for p in parts if p.endswith('d') and p[:-1].isdigit()), '')
        rows.append({'file': f, 'field': kind, 'days': days,
                     'mb': round(os.path.getsize(path) / 1e6, 1)})
    write_csv('cachedir', rows)
    tot = sum(r['mb'] for r in rows)
    by = {}
    for r in rows:
        by[r['field']] = by.get(r['field'], 0) + r['mb']
    print(f'  {len(rows)} files, {tot / 1000:.1f} GB total')
    for k, v in sorted(by.items(), key=lambda x: -x[1]):
        print(f'    {k:6} {v / 1000:6.2f} GB')


# ───────────────────────────── API experiments ─────────────────────────────

def exp_analyses(args):
    """Phase-2 cost: each analysis family across the resolutions the UI offers."""
    api = Api()
    sc = args.scenario
    # Density at the default 0.1 deg and at the 0.05 deg minimum the service accepts.
    # A connectivity grid finer than 0.25 deg exceeds the 300-node cap on this area,
    # so asking for it would measure the rejection path, not the analysis.
    cases = []
    for res in (0.1, 0.05):
        cases.append(('pmar', {'scenario_id': sc, 'res': res, 'margin': 1.0},
                      f'res={res}'))
    for mode in ('passage', 'transition'):
        for gr in (0.5, 0.25):
            cases.append(('connectivity',
                          {'scenario_id': sc, 'grid_res': gr, 'mode': mode},
                          f'{mode} grid={gr}'))
    for res in (0.5, 0.25, 0.1):
        cases.append(('markov', {'scenario_id': sc, 'res': res, 'dt_days': 5},
                      f'res={res}'))
    for dt in (1, 10):
        cases.append(('markov', {'scenario_id': sc, 'res': 0.25, 'dt_days': dt},
                      f'dt={dt}d'))

    rows = []
    for pid, inputs, label in cases:
        walls = []
        for rep in range(args.repeat):
            rec, res, wall = api.run(pid, inputs)
            status = rec.get('status')
            walls.append(wall if status == 'successful' else None)
            if status != 'successful':
                print(f'  {pid} {label} rep{rep}: {status} — {rec.get("message", "")[:70]}')
        med, spread = summarise(walls)
        size, units = None, ''
        if res is not None:
            size = round(len(json.dumps(res)) / 1e6, 2)
            if pid == 'connectivity':
                units = len(res.get('node_ids', []))
            elif pid == 'markov':
                units = len(res.get('cells', []))
            elif pid == 'pmar':
                units = res.get('raster_nx', 0) * res.get('raster_ny', 0)
        rows.append({'process': pid, 'config': label, 'scenario': sc,
                     'units': units, 'repeats': args.repeat,
                     'wall_s_median': round(med, 2) if med else '',
                     'wall_s_spread': round(spread, 2) if spread is not None else '',
                     'payload_mb': size if size is not None else ''})
        print(f'  {pid:14} {label:18} {"rejected" if med is None else round(med, 2):>6}s  '
              f'{units:>6} units  payload {size} MB')
    write_csv(args.out, rows)


# ───────────────────────────── reference scenarios ─────────────────────────
#
# Chapter 6 reports every simulation-side measurement on the same small set of
# scenarios, so a reader meets three names and finds them everywhere. S is the
# configuration of the script baseline; M is a month over the whole basin; L is
# the convergence campaign of ch. 5 (bench/adriatic_campaign.py), which already
# has a recorded run and is not repeated here. July 2024 is chosen because no
# forcing for it was cached, so the first run of S and of M is a cold one.

S_BOX = [[12.4, 44.6], [13.0, 44.6], [13.0, 45.0], [12.4, 45.0], [12.4, 44.6]]

REFERENCE = {
    'S':  dict(area='box', pressure='generic', pnum=1000, duration_days=7,
               time_step_hours=1, start_time='2024-07-01T00:00:00', cmems_margin=2.0),
    'M':  dict(area='basin', pressure='generic', pnum=10000, duration_days=30,
               time_step_hours=1, start_time='2024-07-01T00:00:00', cmems_margin=0),
    'Mp': dict(area='basin', pressure='plastic', pnum=10000, duration_days=30,
               time_step_hours=1, start_time='2024-07-01T00:00:00', cmems_margin=0),
}


def reference_inputs(name, pnum=None):
    """Precompute inputs for reference scenario *name*, optionally with another pnum."""
    spec = dict(REFERENCE[name])
    if spec.pop('area') == 'box':
        geo = json.dumps({'type': 'Polygon', 'coordinates': [S_BOX]})
    else:
        # -I leaves the script's own folder off the path, so add it.
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from adriatic_campaign import polygon
        geo = polygon()
    if pnum is not None:
        spec['pnum'] = pnum
    return {**spec, 'geojson': geo, 'beaching': False, 'area_name': 'Adriatic',
            'label': f'reference {name} {spec["pnum"]}'}


def run_reference(api, name, pnum=None, wait=14400):
    """Run one reference simulation; returns a row built from its own record."""
    inputs = reference_inputs(name, pnum)
    t0 = time.monotonic()
    job, _ = api.submit('precompute', inputs)
    rec = api.wait(job, limit=wait)
    wall = time.monotonic() - t0
    if rec.get('status') != 'successful':
        print(f'  {name}: {rec.get("status")} {rec.get("message", "")[:200]}')
        return None
    row = record_row(api.results(job).get('scenario_id'), name)
    row['client_s'] = round(wall, 1)
    return row


def record_row(sid, name):
    """A reference row built from a scenario's own record, however it was run."""
    sc = json.load(open(os.path.join(SCENARIOS, f'{sid}.json')))
    t, f = sc.get('timing') or {}, sc.get('forcing') or {}
    nc = sc.get('nc_filenames') or [sc['nc_filename']]
    size = sum(os.path.getsize(os.path.join(SCENARIOS, n)) for n in nc) / 1e6
    steps = int(sc['duration_days'] * 24 / sc['time_step_hours'])
    releases = len(nc)
    run_s = (datetime.fromisoformat(sc['finished_at'])
             - datetime.fromisoformat(sc['started_at'])).total_seconds()
    return {'name': name, 'scenario_id': sid, 'pressure': sc['pressure'],
            'pnum': sc['pnum'], 'releases': releases, 'output_steps': steps,
            'particle_steps': sc['pnum'] * steps * releases,
            'client_s': '', 'run_s': round(run_s, 1),
            'forcing_s': t.get('forcing_s', ''), 'integration_s': t.get('integration_s', ''),
            'write_s': t.get('write_s', ''), 'downloaded_mb': f.get('downloaded_mb', ''),
            'hits': f.get('hits', ''), 'misses': f.get('misses', ''),
            'peak_rss_mb': t.get('peak_rss_mb', ''), 'size_mb': round(size, 1)}


def exp_reference(args):
    """Phase-1 cost of the reference scenarios, cold and warm, and a particle sweep.

    Each named scenario runs twice in a row. Whether a run was cold is not
    assumed: the record says how many megabytes it downloaded. The sweep varies
    only the particle count of M, on a warm cache, to separate the fixed cost of
    a run from the cost per particle-step.
    """
    api = Api()
    rows = []
    # Runs made earlier, e.g. a cold run whose download outlasted the harness,
    # are read back from their records as NAME=scenario_id.
    for item in args.records:
        name, sid = item.split('=')
        r = record_row(sid, name)
        r['run'] = 'record'
        rows.append(r)
        print(f"  {name} from record {sid}: {r['run_s']}s  forcing {r['forcing_s']}s  "
              f"{r['downloaded_mb']} MB")
    for rep in (1, 2):
        for name in args.names:
            r = run_reference(api, name)
            if r:
                r['run'] = rep
                rows.append(r)
                print(f"  {name} run {rep}: {r['run_s']}s  forcing {r['forcing_s']}s  "
                      f"integration {r['integration_s']}s  {r['downloaded_mb']} MB  "
                      f"{r['size_mb']} MB on disk")
    for pnum in args.sweep:
        r = run_reference(api, 'M', pnum=pnum)
        if r:
            r['name'], r['run'] = f'M-{pnum}', 'sweep'
            rows.append(r)
            print(f"  M with {pnum}: {r['run_s']}s  integration {r['integration_s']}s")
    write_csv(args.out, rows)
    print('  NOTE: the sweep scenarios can be removed afterwards; S, M and Mp are '
          'the reference scenarios of ch. 6')



def exp_sparsity(args):
    """Fill of the transition matrix: non-zero entries against nodes.

    Dense storage is 8 bytes per entry; coordinate-sparse storage is 16 bytes
    per non-zero entry (a value and two indices).
    """
    api = Api()
    rows = []
    for item in args.cases:
        name, sid, grid = item.split(':')
        rec, res, _ = api.run('connectivity', {'scenario_id': sid, 'grid_res': float(grid),
                                               'mode': 'transition'})
        if rec.get('status') != 'successful':
            print(f'  {name} {grid}: {rec.get("status")} {rec.get("message", "")[:120]}')
            continue
        m = res['matrix']
        n = len(m)
        nnz = sum(1 for row in m for v in row if v)
        rows.append({'name': name, 'scenario_id': sid, 'grid_deg': grid, 'nodes': n,
                     'non_zero': nnz, 'fill': round(nnz / (n * n), 4),
                     'dense_kb': round(n * n * 8 / 1024, 1),
                     'sparse_kb': round(nnz * 16 / 1024, 1)})
        r = rows[-1]
        print(f"  {name} {grid}: {n} nodes, {nnz} non-zero, fill {r['fill']:.1%}, "
              f"{r['dense_kb']} KB dense, {r['sparse_kb']} KB sparse")
    write_csv(args.out, rows)

def exp_isolation(args):
    """NFR2: does a running simulation degrade the latency of short requests?

    Baseline latency first, then the same probes while a simulation occupies the
    simulation worker. The claim under test is that they are indistinguishable,
    because the API process and the workers are separate.
    """
    api = Api()
    probe = ('scenario_status', {})
    print('  baseline (idle) ...')
    base = api.latency(*probe, n=args.probes)

    geo = json.dumps({'type': 'Polygon', 'coordinates': [[
        [12.4, 44.6], [13.4, 44.6], [13.4, 45.2], [12.4, 45.2], [12.4, 44.6]]]})
    if args.reference:
        # A reference scenario of ch. 6, on a warm cache, so that the worker is
        # integrating rather than waiting on a download while the probes run.
        print(f'  submitting reference scenario {args.reference} ...')
        job, _ = api.submit('precompute', reference_inputs(args.reference))
    else:
        print(f'  submitting simulation: {args.pnum} particles, {args.days} days ...')
        job, _ = api.submit('precompute', {
            'geojson': geo, 'pressure': 'generic', 'pnum': args.pnum,
            'duration_days': args.days, 'time_step_hours': 1, 'cmems_margin': 2.0,
            'label': 'bench-isolation', 'area_name': 'bench',
        })
    time.sleep(args.settle)
    print('  probing under load ...')
    under = api.latency(*probe, n=args.probes)

    # a second simulation must queue rather than run
    job2, _ = api.submit('precompute', {
        'geojson': geo, 'pressure': 'generic', 'pnum': 100,
        'duration_days': 1, 'label': 'bench-queued', 'area_name': 'bench'})
    time.sleep(3)
    _, _, q = api._json(f'{api.base}/jobs/{job2}?f=json')
    queued_status = q.get('status')

    rec = api.wait(job)
    print(f'  simulation finished: {rec.get("status")}')

    bm, bs = summarise(base)
    um, us = summarise(under)
    rows = [
        {'condition': 'idle', 'probes': len(base),
         'median_ms': round(bm * 1000, 1), 'spread_ms': round(bs * 1000, 1) if bs else ''},
        {'condition': 'simulation running', 'probes': len(under),
         'median_ms': round(um * 1000, 1), 'spread_ms': round(us * 1000, 1) if us else ''},
    ]
    write_csv(args.out, rows)
    print(f'  idle   median {bm * 1000:.0f} ms')
    print(f'  loaded median {um * 1000:.0f} ms   ratio {um / bm:.2f}x')
    print(f'  second simulation status while first runs: {queued_status} '
          f'(expected "accepted")')
    print(f'  NOTE: remove the bench scenarios afterwards ({job}, {job2})')


def exp_phase1(args):
    """Phase-1 wall time from scenario records: local disk, or a deployment over HTTP.

    Costs nothing on either platform: the records already carry started_at and
    finished_at. Pointing it at the deployment is how the chapter obtains a second
    machine to compare against without any shell access to it.
    """
    if args.remote:
        api = Api(args.remote)
        _, _, d = api._json(f'{api.base}/processes/scenario_status/execution',
                            json.dumps({'inputs': {}}).encode(),
                            {'Content-Type': 'application/json'}, timeout=120)
        records = list(d.get('scenarios', {}).values())
        where = args.remote
    else:
        records = scenarios()
        where = 'local disk'

    rows = []
    for sc in records:
        if not (sc.get('started_at') and sc.get('finished_at')):
            continue
        try:
            t0 = datetime.fromisoformat(sc['started_at'])
            t1 = datetime.fromisoformat(sc['finished_at'])
        except Exception:
            continue
        pnum = sc.get('pnum', 0)
        days = sc.get('duration_days', 0)
        step = sc.get('time_step_hours') or 1
        seedings = sc.get('seedings', 1)
        # particle-steps is the natural unit of integration work
        work = pnum * (days * 24 / step) * seedings
        wall = (t1 - t0).total_seconds()
        row = {
            'scenario_id': sc.get('scenario_id', '?'),
            'label': (sc.get('label_en') or '')[:30],
            'pressure': sc.get('pressure'), 'pnum': pnum,
            'duration_days': days, 'time_step_hours': step, 'seedings': seedings,
            'particle_steps': int(work),
            'wall_s': round(wall, 1),
            'us_per_particle_step': round(wall / work * 1e6, 2) if work else '',
            'mb': sc.get('nc_size_mb') or '',
        }
        # present only where the instrumentation of this work is deployed
        t = sc.get('timing') or {}
        for k in ('forcing_s', 'integration_s', 'write_s', 'peak_rss_mb'):
            row[k] = t.get(k, '')
        rows.append(row)

    rows.sort(key=lambda r: r['particle_steps'])
    write_csv(f'phase1_{"remote" if args.remote else "local"}', rows)
    print(f'  source: {where} — {len(rows)} scenarios with complete timings')
    vals = [r['us_per_particle_step'] for r in rows if r['us_per_particle_step'] != '']
    med, spread = summarise(vals)
    if med:
        print(f'  integration cost: median {med:.2f} us per particle-step' +
              (f'  IQR {spread:.2f}' if spread is not None else '  (single run)'))
    for r in rows:
        print(f"    {r['label'][:26]:28} {r['pnum']:>6}p {r['duration_days']:>4}d "
              f"x{r['seedings']}  {r['wall_s']:>7.0f}s  "
              f"{r['us_per_particle_step']} us/p-step")


EXPERIMENTS = {
    'storage':  (exp_storage,  'offline', 'trajectory size vs particles/steps/model'),
    'cachekey': (exp_cachekey, 'offline', 'cache hit rate under key normalisation'),
    'containment': (exp_containment, 'offline', 'what the containment lookup absorbs that the key could not'),
    'forcing':  (exp_forcing,  'net',     'cold forcing retrieval against requested volume'),
    'convergence': (exp_convergence, 'offline', 'propagated vs simulated distributions over horizons'),
    'load':     (exp_load,     'api',     'response times as the number of simultaneous users grows'),
    'validation': (exp_validation, 'offline', 'noise floor, hold-out and time-varying decomposition of the propagation error'),
    'cachedir': (exp_cachedir, 'offline', 'composition of the forcing cache'),
    'analyses': (exp_analyses, 'api',     'phase-2 cost per analysis family'),
    'isolation': (exp_isolation, 'sim',   'NFR2: latency under simulation load'),
    'sparsity': (exp_sparsity, 'api',    'fill of the transition matrix'),
    'reference': (exp_reference, 'sim',  'phase-1 cost of the reference scenarios, cold and warm'),
    'phase1':   (exp_phase1,   'offline', 'phase-1 wall time from scenario records'),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name, (_, cost, help_) in EXPERIMENTS.items():
        s = sub.add_parser(name, help=f'[{cost}] {help_}')
        if name in ('cachekey', 'containment'):
            s.add_argument('--n', type=int, default=200)
            s.add_argument('--seed', type=int, default=20261025)
        if name == 'convergence':
            s.add_argument('--scenarios', nargs='+', required=True)
            s.add_argument('--res', type=float, nargs='+', default=[0.25])
            s.add_argument('--dt', type=float, nargs='+', default=[10.0])
            s.add_argument('--bbox', type=float, nargs=4, default=None)
            s.add_argument('--subsample', type=int, nargs='+', default=[0],
                           help='particles per release to keep; 0 = all')
            s.add_argument('--seed', type=int, default=20261028)
            s.add_argument('--out', default='convergence',
                           help='CSV basename, so separate sweeps do not overwrite')
        if name == 'reference':
            s.add_argument('--names', nargs='*', default=['S', 'M', 'Mp'])
            s.add_argument('--records', nargs='*', default=[],
                           help='NAME=scenario_id of runs already on disk')
            s.add_argument('--sweep', type=int, nargs='*', default=[1000, 2500, 5000])
            s.add_argument('--out', default='reference')
        if name == 'sparsity':
            s.add_argument('--cases', nargs='+', required=True,
                           help='NAME:scenario_id:grid_deg')
            s.add_argument('--out', default='sparsity')
        if name == 'load':
            s.add_argument('--scenario', default='custom_e4f2e106')  # scenario M
            s.add_argument('--sync-levels', type=int, nargs='+', default=[1, 2, 4, 8, 16, 32])
            s.add_argument('--job-levels', type=int, nargs='+', default=[1, 2, 4, 8, 16])
            s.add_argument('--requests', type=int, default=20)
            s.add_argument('--repeat', type=int, default=3)
            s.add_argument('--probe', choices=['processes', 'scenario_status'], default='processes')
            s.add_argument('--out', default='load')
        if name == 'validation':
            s.add_argument('--scenarios', nargs='+', required=True)
            s.add_argument('--res', type=float, default=0.25)
            s.add_argument('--dt', type=float, default=10.0)
            s.add_argument('--bbox', type=float, nargs=4, default=None)
            s.add_argument('--seed', type=int, default=20261029)
            s.add_argument('--out', default='validation')
        if name == 'forcing':
            s.add_argument('--days', type=int, nargs='+', default=[3, 10, 30])
            s.add_argument('--repeat', type=int, default=3)
            s.add_argument('--modes', nargs='+', default=['surface', '3-D'],
                           choices=['surface', '3-D'])
            s.add_argument('--out', default='forcing')
        if name == 'analyses':
            s.add_argument('--scenario', default='custom_e4f2e106')  # scenario M
            s.add_argument('--repeat', type=int, default=3)
            s.add_argument('--out', default='analyses')
        if name == 'phase1':
            s.add_argument('--remote', default=None,
                           help='base URL of a deployment, e.g. https://<deployment-host>')
        if name == 'isolation':
            s.add_argument('--probes', type=int, default=20)
            s.add_argument('--pnum', type=int, default=5000)
            s.add_argument('--days', type=int, default=20)
            s.add_argument('--settle', type=int, default=25)
            s.add_argument('--reference', choices=sorted(REFERENCE), default=None)
            s.add_argument('--out', default='isolation')
    args = ap.parse_args()
    fn, cost, help_ = EXPERIMENTS[args.cmd]
    print(f'[{args.cmd}] {help_}  ({cost})')
    fn(args)


if __name__ == '__main__':
    main()
