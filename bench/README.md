# Benchmarks

The measurements behind the evaluation chapter. Each experiment writes one CSV into
`results/`, so every number in the thesis is traceable to a run rather than retyped.

## Running

Most experiments need the project's dependencies and the `scenarios/` and `cache/`
volumes, so they run inside the backend container:

```bash
docker compose exec backend python -I /app/bench/run.py <experiment>
docker compose exec backend python -I /app/bench/run.py --help
```

Two of them (`storage`, `cachedir`) only read files and use the standard library, so
they also run on the host:

```bash
python3 bench/run.py storage
```

## The experiments, by what they cost

| Experiment | Cost | What it measures |
|---|---|---|
| `storage` | none | Trajectory file size against particles, output steps and pressure model |
| `cachedir` | none | What the forcing cache actually holds, by field |
| `cachekey` | none | Hit rate of the normalised cache key against an exact-match key |
| `containment` | none | What the containment lookup absorbs that the key could not |
| `phase1` | none | Phase-1 wall time from scenario records, local or `--remote` |
| `analyses` | seconds each | Phase-2 service time (from the job record), wall time and payload size per analysis family |
| `equivalence` | minutes | Each analysis as the interface receives it, against the PMAR library called directly on the same scenario |
| `isolation` | minutes | Whether a running simulation degrades short-request latency (NFR2) |
| `load` | minutes | Response times as the number of simultaneous users and analyses grows. Run it from a container on the stack's network, against the API process (see `exp_load`) |
| `reference` | hours | Phases of the reference scenarios S, M and L (ch. 6), with an empty and a full cache, and a particle sweep on M. `--records NAME=id` reads back runs already on disk |
| `sparsity` | seconds | Fill of the transition matrix of each reference scenario |
| `forcing` | **network** | Cold forcing retrieval against requested volume |

Run the experiments that use the service one at a time, and do not run other scripts in the
containers meanwhile. On a machine with about 7.6 GB for the containers, a simulation of L
together with any other large process exceeds the memory.

`figures.py` draws the figures of chapter 6 from `results/` and the trajectory files of S, M
and L; its header gives the command. `reference/` holds the release areas of S and of the
Adriatic basin as zipped shapefiles, which the interface can load directly.

`none` means the experiment reads artefacts already on disk, or computes over a synthetic
request sequence. Those can be re-run freely. The others consume the service.

`forcing` is the one to be careful with: it downloads from the Copernicus Marine Service,
several gigabytes across the default sweep, and that cost falls on them as well as on you.
Run it deliberately and not in a loop. It also wants a quiet machine, since it is the only
experiment whose numbers are network timings.

`containment` is free but not trivial: it drives the real `find_cached` against a temporary
cache directory, so it measures the shipped lookup rather than a restatement of it; its unit
is a request *sequence*, because containment depends on what was downloaded before.

## Conventions

- **Repetitions.** Where an experiment repeats, it reports the median and the
  interquartile range. Where there is a single observation it reports the value and says
  so — an interquartile range over one run would be a fiction.
- **Outliers** are flagged by a stated rule (more than 1.5 IQR from the median), not by
  eye, and are listed rather than removed.
- **Timing** uses `time.monotonic()`. Analysis and load-test times come from the job record,
  where the worker writes when a job starts and ends with the server's clock, so they do not
  include the client's polling; `analyses` also keeps the wall time the client waited.
  Peak memory comes from the scenario record, measured in the process that ran the simulation.

## Measuring against the deployment server

A deployed instance can be queried read-only by giving its base URL:

```bash
BENCH_BASE=https://<deployment-host> python3 bench/run.py <experiment>
```

Only the read-only experiments should be pointed at it. It is a shared public instance,
and running simulations or sweeps there consumes someone else's capacity.

Its scenario records carry `started_at` and `finished_at`, so phase-1 timings measured on
server hardware can be read without any load at all — which is how the chapter obtains a
second platform to compare the local ratios against.

## Caveat on the local platform

The local numbers come from Docker Desktop on Apple silicon, with a fraction of the
memory the deployment has, and on a different processor architecture. Absolute times do
not transfer. Ratios, decompositions and scaling behaviour largely do, and the chapter
states which is which rather than presenting all numbers as equivalent.
