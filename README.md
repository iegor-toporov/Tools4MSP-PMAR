# Tools4MSP-PMAR

A DTO web application for on-demand anthropogenic pressure modelling and assessment based on the [PMAR](https://github.com/CNR-ISMAR/pmar.git) package. It combines an OGC API Processing backend with an interactive map frontend to simulate how substances and organisms disperse under real ocean data, and to compute particle density maps with the PMAR engine. It dinamically connects to Copernicus Marine for ocean models and EMODnet for human activities data. 

## GUI Preview

![PMAR analysis - particle density heatmap using Tracer model. Res 0.05º.](images/PMAR_example_1.png)
<p align="center">PMAR analysis - particle density heatmap using Tracer model. Res 0.05º.
</p>

<br>

![PMAR analysis - particle density heatmap using Tracer model. Res 0.05º. Tools as floating windows on top.](images/PMAR_example_2.png)
<p align="center">PMAR analysis - particle density heatmap using Tracer model. Res 0.05º. Tools as floating windows on top.</p>

## Architecture

```
DTO-PMAR/
├── processes/
│   ├── OpenDriftProcess.py              # OGC API process: runs OpenDrift with CMEMS data
│   ├── PMARProcess.py                   # OGC API process: PMAR density analysis on a precomputed scenario
│   ├── ConnectivityProcess.py           # OGC API process: connectivity matrix + graph metrics between areas
│   ├── MarkovProcess.py                 # OGC API process: Markov-chain dispersal forecast with validation
│   ├── markov_core.py                   # Transition matrix, propagation, Lagrangian reference (numpy/scipy only)
│   ├── PrecomputeProcess.py             # OGC API process: precomputes and stores a trajectory NC file
│   ├── ScenarioStatusProcess.py         # OGC API process: lists saved scenarios + Tools4MSP areas
│   ├── scenario_state.py                # Scenario lifecycle: state in the JSON, reconciliation with Redis jobs
│   ├── WindfarmsProcess.py              # OGC API process: EMODnet wind farm preview (bbox query)
│   ├── OffshoreInstallationsProcess.py  # OGC API process: EMODnet offshore installations preview
│   ├── Natura2000Process.py             # OGC API process: Natura 2000 protected areas (EmodNet); no longer used by the UI
│   ├── MSPZonesProcess.py               # OGC API process: EMODnet MSP aquaculture zones (bbox query)
│   ├── ShapefileFieldsProcess.py        # OGC API process: columns of an uploaded shapefile (polygon labels)
│   └── logging_utils.py                 # Shared log handler with line-count rotation
├── data/
│   ├── cmems_datasets.py                # CMEMS dataset constants (dataset IDs, variables)
│   └── emodnet_fetch.py                 # Shared EMODnet WFS fetch functions with 7-day pickle cache
├── worker/
│   ├── app.py                           # Celery application: queues, time limits, visibility timeout
│   ├── manager.py                       # pygeoapi job manager on Redis: prepare hook, queue routing, Stop
│   └── tasks.py                         # Celery tasks (analyses, simulations) and simulation-worker recovery
├── frontend/
│   ├── src/
│   │   ├── api/
│   │   │   ├── ogcProcesses.js          # OGC API - Processes client: no React, no UI library, no i18n
│   │   │   └── ogcProcesses.test.js     # Unit tests for the client (node:test, no browser needed)
│   │   ├── geometry/
│   │   │   └── seedShape.js             # Seeding-area conversions (GeoJSON, bbox, label): no React, no i18n
│   │   ├── markov/
│   │   │   └── frames.js                # Markov frames → PMAR raster per frame and layer (pure, tested)
│   │   ├── export/
│   │   │   ├── geotiff.js               # Float32 GeoTIFF writer for the layers' "Download raster" (pure, tested)
│   │   │   └── pmarTools.js             # CSV files of the analysis tools (pure, tested)
│   │   ├── hooks/
│   │   │   └── usePreviewLayer.js       # React adapter: keeps one EMODnet overlay in sync with the seeding area
│   │   ├── scenarios/
│   │   │   └── lifecycle.js             # Simulation states, transitions and labels (pure, tested)
│   │   ├── storage/
│   │   │   ├── persistedState.js        # What the analyses panel saves, and how it is read back (pure, tested)
│   │   │   └── analysesStore.js         # IndexedDB read/write, failure-tolerant
│   │   ├── components/                  # Panels, map overlays, analysis windows (Mantine v9, react-leaflet)
│   │   │   └── analysis/                # The three Analysis sections: Dispersal, Structural connectivity, Propagate
│   │   ├── App.jsx                      # Root: map, panels, application state
│   │   └── i18n.js                      # IT/EN strings
│   ├── Dockerfile                       # Multi-stage build → nginx
│   ├── nginx.conf                       # Static serving + API proxy; copied into the image as nginx.conf.template and env-substituted at container start
│   └── nginx.conf.template              # Unused HTTPS/Let's Encrypt variant, not referenced by any Dockerfile
├── scripts/
│   ├── start.sh                         # Dev: regenerate OpenAPI spec and start pygeoapi
│   ├── entrypoint.sh                    # Docker entrypoint for backend container
│   └── init-letsencrypt.sh              # Let's Encrypt certificate bootstrap helper
├── cache/
│   ├── cmems_*_cur_*.nc                 # Ocean currents
│   ├── cmems_*_wind_*.nc                # Wind
│   ├── cmems_*_wav_*.nc                 # Waves (Stokes drift)
│   ├── cmems_*_tem_*.nc                 # Temperature & salinity
│   ├── cmems_*_bathy_*.nc               # Bathymetry (geographic cache, no time key)
│   └── emodnet/                         # EMODnet WFS responses (pickle, 7-day TTL)
├── scenarios/
│   ├── custom_<id>.nc                   # Precomputed trajectory files
│   ├── custom_<id>.json                 # Scenario metadata (params, shapefile path, label)
│   └── shapefiles/
│       ├── custom_<id>.shp              # Seeding area shapefiles for custom scenarios
│       └── t4msp_<area_id>.shp          # Cached Tools4MSP area geometries
├── out/                                 # Temporary simulation outputs (cleaned on startup)
├── Dockerfile                           # Backend image (pygeoapi + processes + data/)
├── docker-compose.yml                   # Orchestrates backend, celery-worker, simulation-worker, redis, frontend
├── pygeoapi-config.yml                  # OGC API config: process registrations, server metadata
├── .env.example                         # Template for required environment variables
└── .env                                 # Runtime secrets: CMEMS credentials (not committed)
```

**Backend:** [pygeoapi](https://pygeoapi.io) (port 5001) exposes all processes via the OGC API - Processes standard. Long-running work is offloaded to **Celery** workers backed by **Redis**, on two queues: analyses (PMAR, connectivity) run in parallel on `celery-worker`, simulations run one at a time on `simulation-worker` (see [Simulation queue and lifecycle](#simulation-queue-and-lifecycle)). Shared data utilities (CMEMS dataset definitions, EMODnet WFS fetch functions) live in `data/` and are imported by the process modules.

**Frontend:** React 19 + Vite SPA with Mantine v9 and react-leaflet. In production it is built into a static bundle and served by **nginx**, which also proxies `/processes/*` to the backend. The proxy raises `client_max_body_size` to 64 MB: shapefiles and GeoTIFFs travel base64-encoded inside the JSON body, which inflates them by a third, and nginx's 1 MB default rejected any real file with an opaque `413` before it ever reached the backend.

The frontend is organised in three layers, so that the code which talks to the backend is independent of the code which draws the interface:

| Layer | Path | Depends on |
|---|---|---|
| API client | `src/api/ogcProcesses.js` | the Fetch API only — no React, no UI library, no i18n |
| Geometry | `src/geometry/seedShape.js` | nothing — pure functions over plain objects |
| React adapters | `src/hooks/` | the API client + React |
| Presentation | `src/App.jsx`, `src/components/` | everything above |

No component issues a `fetch` of its own: every call to the backend goes through the API client. See [Frontend API client](#frontend-api-client).

**CMEMS authentication:** credentials (`COPERNICUSMARINE_SERVICE_USERNAME` / `COPERNICUSMARINE_SERVICE_PASSWORD`) are configured exclusively via environment variables in `.env`. The `copernicusmarine` client reads them automatically — no credentials are sent from the browser.

## Requirements

- Docker and Docker Compose
- A `.env` file with runtime secrets (see below)
- A free [Copernicus Marine](https://marine.copernicus.eu/) account

## Getting started

```bash
git clone <repo>
cd DTO-PMAR

# Copy .env.example to .env and fill in your Copernicus Marine credentials
cp .env.example .env

# The compose file joins an external network managed by the reverse proxy in production.
# Create it once locally, otherwise the stack will not start.
docker network create traefik_geonode_webgateway

docker compose up --build -d
```

The PMAR library is installed from the public [CNR-ISMAR/pmar](https://github.com/CNR-ISMAR/pmar)
repository, pinned to a commit in the `Dockerfile`: no token is needed, and the build stays
reproducible. To move to a newer PMAR, change the SHA there and rebuild.

The backend runs on port 5001 and the frontend on port 80, both **inside the Docker network only**: in production the Traefik reverse proxy routes traffic to the frontend container, so no port is published to the host. The two Celery workers and Redis are started automatically.

To reach the frontend from your browser while developing, publish port 80 with a local override file — `docker compose` picks it up automatically and it leaves the production configuration untouched:

```yaml
# docker-compose.override.yml (git-ignored)
services:
  frontend:
    ports:
      - "80:80"
```

The frontend is then served at `http://localhost`.

Alternatively, run the frontend dev server with hot reload, which proxies `/processes` and `/jobs` to `localhost:5001` (see `vite.config.js`):

```bash
cd frontend && npm install && npm run dev   # http://localhost:3000
```

`cache/`, `out/`, and `scenarios/` are tracked in git as empty directories (via `.gitkeep`) so Docker can mount them with correct permissions from the first run.

## Demo mode

For public demos the app can be shared with a link while keeping simulations to the team. Set
two variables in `.env` and recreate the containers (`docker compose up -d`):

```
SIMULATION_TOKEN=<openssl rand -hex 24>
PUBLIC_SCENARIOS=custom_927fb7ae,custom_xxxxxxxx,custom_yyyyyyyy
```

| Without the token (visitors) | With the token |
|---|---|
| Analysis (PPI, connectivity, tools) on the scenarios in `PUBLIC_SCENARIOS` only | Everything, on every scenario |
| No `precompute`, no `opendrift`, no `pmar` without `scenario_id` (they run OpenDrift) | Simulations allowed |

The check runs in the backend (`processes/access.py`), not only in the UI: a request sent
straight to the API without the token fails with `ACCESS_DENIED`. The token travels as the
`access_token` input, is removed from the inputs as soon as it is read, and never reaches logs
or the job records in Redis. In the UI, the *New simulation* form is replaced by a token field;
the token is kept in `sessionStorage`, so it survives a reload and is gone when the tab is
closed. A *Lock* button returns to visitor mode.

With `SIMULATION_TOKEN` unset the app behaves exactly as without demo mode. With it set and
`PUBLIC_SCENARIOS` empty, visitors see every scenario but still cannot run simulations.

## OpenDrift process

**Endpoint:** `POST /processes/opendrift/execution`

### Drift models

| Key | Description | Wind | Waves | T/S | Vertical |
|---|---|---|---|---|---|
| `OceanDrift` | Passive tracer — surface currents only | — | — | — | — |
| `PlastDrift` | Plastic debris — Stokes drift + wind drag | Yes | Yes | — | — |
| `LarvalFish` | Fish larvae/eggs — vertical buoyancy + turbulent mixing | — | — | — | Yes |
| `OpenOil` | Hydrocarbons — evaporation, emulsification, dispersion | Yes | Yes | Yes | Yes |

Models marked **Vertical** use dynamic CMEMS depth: the seafloor depth (`deptho`) is downloaded once per area and cached; `maximum_depth = max(deptho) + 10 m` is used for the currents download instead of a fixed value.

### Inputs

| Parameter | Description | Default |
|---|---|---|
| `seeding_type` | `circle` or `rectangle` | `circle` |
| `lon`, `lat`, `radius` | Centre and radius (m) for circle seeding | — |
| `lon_min/max`, `lat_min/max` | Bounding box for rectangle seeding | — |
| `model` | Drift model key (see table above) | `OceanDrift` |
| `start_time` | ISO 8601 datetime | 3 days ago |
| `number` | Number of particles (max 10 000) | 100 |
| `duration_hours` | Simulation duration in hours (max 720) | 24 |

This process has no polygon seeding: unlike precompute, it takes coordinates rather than a
geometry. An area drawn as polygons is therefore submitted as the **bounding rectangle** that
contains it.

### Output

JSON with `times` (ISO timestamps array), `steps` (per-timestep particle positions `[lon, lat]`), and `model` name.

## PMAR workflow

The PMAR panel uses a two-step workflow split across two tabs.

### Tab 1 — Simulation

The user defines a seeding area and simulation parameters, then triggers a **precomputation** that runs OpenDrift and saves the trajectory to disk. The result is a named scenario that can be reused for multiple analyses without re-running the simulation.

**Seeding area options:**

| Mode | Description |
|---|---|
| Draw | Circle, rectangle, or free **polygon** drawn interactively on the map |
| Shapefile | ZIP archive containing `.shp`, `.shx`, `.dbf` files |
| Pre-defined area | Geographic area from the [Tools4MSP API](https://api.tools4msp.eu/api/v2/domainareas/) |

**Drawing polygons.** Click to drop vertices; close the polygon by clicking its first vertex or
with a double click. The tool stays armed, so several polygons can be accumulated into one seeding
area — useful when the areas of interest are disjoint. `Backspace` removes the last vertex, `Esc`
discards the polygon being drawn, and the panel offers *Undo last* (removes the last closed
polygon) and *Done*. Each polygon becomes a separate feature of the GeoJSON sent to the backend,
and therefore a separate geometry in the scenario shapefile.

Selecting an existing simulation highlights **its** seeding area on the map and frames the view on
it; the drawn area is hidden while that is the case, and comes back when the selection is cleared.
Starting a new drawing clears the selection, so exactly one area is shown at any time.

Whatever the mode, *Seeding area name* names the area (for a pre-defined area it replaces the
Tools4MSP name; left empty, that name is kept).

**Simulation parameters:**

| Parameter | Range | Default |
|---|---|---|
| Title | Free text | Auto-generated from pressure + date |
| Description | Free text | — |
| Tracer type | `generic` (General), `plastic`, `oil`, `chemical`, `larvae` (Fish larvae) | `generic` |
| Chemical compound | One of the 28 compounds known to ChemicalDrift (only with `chemical`) | Naphthalene |
| Start date | ISO 8601 date | 10 days ago |
| Duration | 1–730 days | 30 |
| Particles | 10–100 000 | 1 000 |
| Time step | 1, 3, 6, 12, 24 h | 1 h |
| Particle distribution | *Evenly* or *Per polygon* (10–20 000 per polygon) | Evenly |
| Multi seeding (Advanced) | Seedings and days between them | off |
| CMEMS margin (Advanced) | 0–20° | 1° |
| No beaching (Advanced) | Particles reaching the coast stay in the water | off |

The form follows the order of the interface mock-up: title and description, seeding area, tracer
type, *Timing & particles*, *Particle distribution*, then *Advanced*.

**Particle distribution.** *Evenly* lets OpenDrift split the particle budget between polygons *in
proportion to their area*, so a small polygon gets very few. A connectivity matrix compares its
rows with one another, and a row estimated from a handful of particles is not comparable with the
others. *Per polygon* releases the same number of particles in every polygon instead. It works with every way of defining the seeding area. Below the field the panel shows the
resulting total when it can count the polygons — drawn areas (a circle or a rectangle is one
polygon, each free polygon one more) and Tools4MSP areas (from the preview geometry, counting the
parts of a MultiPolygon as the backend does) — and disables *Pre-compute* above 100 000 particles.
With a single polygon it is the same as normal seeding. For an uploaded shapefile the browser does
not read the polygons: the backend computes the total and refuses the request at once if it is too
large. Values per polygon outside 1–20 000 are brought into that range, in the UI as in the
backend. Measured on three polygons of very different size:

```
seed_from_shapefile (proportional):  {0: 272, 1: 25, 2: 3}
per polygon (100 each):              {0: 100, 1: 100, 2: 100}
```

The field replaces *Particles*; the effective total is `particles per polygon × polygons`, capped
at 100 000, and is what the scenario card then reports.

A live estimate of the temporary NetCDF file size is shown below the form, colour-coded by severity (normal / caution >500 MB / warning >2 GB).

Once submitted, the simulation appears in the list straight away as queued or running and the list refreshes every 5 seconds until it is ready; only one simulation runs at a time, the others wait in a queue (see [Simulation queue and lifecycle](#simulation-queue-and-lifecycle)).

Existing simulations are listed in a dropdown at the top of the tab. Selecting one shows a summary: area name, tracer type (and compound), start date, duration, particles, time step, multi seeding, beaching and description.

### Tab 2 — Analysis

Once a simulation is selected from the Simulation tab, the Analysis tab runs analyses on it
without re-running the OpenDrift simulation. At the top, a summary of the simulation (bounding
box, tracer type, forcing, dates, particles, time step, multi seeding, description); below, three
expandable sections, each with an (i) explaining it, a *Layer title* (left empty, a title is
generated, e.g. `PPI · Wind farms · Black Sea 2019`) and its own **Run analysis** button. Every
run adds a layer to the *Analyses layers* of the right panel.

#### Dispersal from source

Maps of tracer propagation from a source layer, counting passages per cell; trajectories are
weighted by the source layer at their release point (`pmar` process).

| Parameter | Options | Default |
|---|---|---|
| Source layer | `Uniform`, EMODnet `Wind farms`, `Offshore installations`, `MSP aquaculture zones`, `Custom` (GeoTIFF upload) | `Uniform` |
| Indicator | `PPI`; with a multi-seeding simulation also `MAX`, `Q90`, `σ` (across seedings) | `PPI` |
| Grid resolution (Advanced) | 0.1°, 0.05° | 0.1° |
| Study area margin (Advanced) | 0–20° | 1° |

The chosen indicator is the one the layer shows and downloads.

#### Structural connectivity

How much water-borne material moves between areas (`connectivity` process).

| Parameter | Options | Default |
|---|---|---|
| Matrix type | *Transition probability*: in B exactly after Δt, if released from A. *Passage probability*: passes through B at least once during Δt | Transition |
| Connectivity grid | *Use seeding area* (the polygons of the simulation's own seeding area; needs at least 2), *Upload shapefile* (a ZIP of polygons, with a *Polygon label* column picked from the file's columns or "None — number the polygons"), *Generate grid* (ocean cells of a resolution between 0.05° and 5° over a box drawn on the map with *Draw bbox*, by default the seeding area) | Use seeding area when it has ≥ 2 polygons, otherwise Generate grid |
| Time interval Δt | Days | Simulation length |
| Include self-loops | Whether a polygon's return to itself counts toward its metrics | on |

The result is drawn directly on the map: the polygons coloured by the selected metric
(**in-strength**, **out-strength**, **betweenness**), and the directed network of exchanges on
top of them. Polygons holding fewer than 30 particles at t=0 are drawn grey and dashed instead of
coloured — their row is not statistically meaningful — and the run reports how many there were.

Clicking a polygon isolates its own connections, with a toggle for incoming / outgoing / both;
clicking it again restores the whole network. The layer's **Matrix** button opens the full
matrix in a floating window: cells show the probability (0–1) with two decimals, and a non-zero
value below 0.005 shows `<0.01` rather than `0.00` (hover a cell for the exact value). Three
downloads, all at the backend's 6-decimal precision:

| Button | Format | Contents |
|---|---|---|
| Dense TSV | n×n table | Every cell, zeros included; rows = origin, columns = destination |
| Edges CSV | `source_id, source_label, target_id, target_label, p` | Only the non-zero pairs: the network's edge list (Excel, pandas, R, Gephi, networkx) |
| .mtx | Matrix Market, coordinate | Only the non-zero pairs, 1-based; node labels in a comment. Read with `scipy.io.mmread`, R `Matrix::readMM`, MATLAB — the format PMAR itself writes with `mmwrite` |

A connectivity matrix is mostly zeros (distant nodes exchange no particles), so the two sparse
formats grow with the number of links rather than with n².

#### Propagate forward

A Markov-chain approximation of tracer propagation after multiples of Δt, using a transition
matrix (`markov` process, see [Markov process](#markov-process)).

| Parameter | Options | Default |
|---|---|---|
| Transition matrix | *Use an existing matrix*: a *Structural connectivity* layer of this simulation with transition probability on a generated grid — its grid and Δt are reused, so the chain is that matrix. *Create a new matrix*: resolution (0.05°–5°) and a box drawn with *Draw bbox* | existing when one is available |
| Time interval Δt | Days (shortcuts 1 / 5 / 10); read-only with an existing matrix | 10 |
| Steps | 1–100 multiples of Δt; the horizon is steps × Δt and may exceed the simulation | 100 |
| Release (collapsible) | Single or continuous (every Δt); source: Uniform, EMODnet layers, Custom GeoTIFF, or an area drawn on the map (orange) | Single, Uniform |

Only transition matrices on a generated grid are offered as existing ones, the only ones a
Markov chain can use: passage matrices, and matrices on an uploaded shapefile or on the
seeding area, cannot be propagated. The panel estimates the particles per cell and warns when the
simulation has beaching on.

## Precompute process

**Endpoint:** `POST /processes/precompute/execution`  
**Execution mode:** asynchronous (`Prefer: respond-async`)

Runs an OpenDrift simulation, saves the trajectory as `scenarios/custom_<id>.nc`, and writes metadata to `scenarios/custom_<id>.json`.

The request is validated **when it is submitted**, not when the worker picks it up: access token,
geometry and Tools4MSP area are checked and the scenario JSON is written right away with
`state: "queued"`. Invalid input or a missing token therefore comes back immediately as an HTTP
400 with a readable `description`, and an accepted simulation is listed at once, even while it
waits for another one to finish. See [Simulation queue and lifecycle](#simulation-queue-and-lifecycle).

### Inputs

| Parameter | Description |
|---|---|
| `geojson` | GeoJSON string of the seeding area: a `FeatureCollection` whose features are the polygons of the area — one when drawing a circle or a rectangle, several when drawing free polygons |
| `shapefile_b64` | Base64-encoded shapefile ZIP (alternative to GeoJSON) |
| `t4msp_area_id` | Integer ID of a Tools4MSP domain area (alternative to GeoJSON) |
| `pressure` | `generic`, `plastic`, `oil`, `chemical` or `larvae` |
| `chemical_compound` | ChemicalDrift compound (with `pressure: chemical`); one of `CHEMICAL_COMPOUNDS` in `PMARProcess.py`, default `Naphthalene` |
| `start_time` | ISO 8601 datetime |
| `duration_days` | Duration in days |
| `pnum` | Number of particles (max 100 000) |
| `pnum_per_polygon` | Releases this many particles in **every** polygon instead of splitting `pnum` by area; overrides `pnum`, total capped at 100 000 |
| `time_step_hours` | Time step in hours (1–24) |
| `label` | Human-readable title for the scenario |
| `description` | Free-text notes about the simulation |
| `area_name` | Name for the seeding area; for a Tools4MSP area it replaces the area's own name |
| `cmems_margin` | Degrees added beyond the seeding area bbox for CMEMS download (default: 5.0) |
| `beaching` | `true` (default): particles reaching the coast strand. `false`: they go back to their previous position and stay in the water (OpenDrift `coastline_action: previous`, as PMAR with `beaching=False`) — the conservative tracer the Markov forecast needs |

Exactly one of `geojson`, `shapefile_b64`, or `t4msp_area_id` must be provided.

Whichever is used, **every polygon it contains becomes a separate geometry** in the scenario's
shapefile, and particles are seeded in all of them: by default split in proportion to their area,
or in equal numbers when `pnum_per_polygon` is set. The scenario metadata records `n_polygons`, so
the rest of the application knows how many areas the simulation was seeded from.

### Output

```json
{ "scenario_id": "custom_a1b2c3d4", "status": "done", "nc_filename": "custom_a1b2c3d4.nc" }
```

The scenario metadata also records `seeding_mode` (`total` or `per_polygon`), `pnum_per_polygon`,
`n_polygons`, and `bounds` (the seeding area's bounding box), all of which the frontend reads back
through the scenario status process.

## Simulation queue and lifecycle

Simulations need several GB of memory and can run for hours, so **only one runs at a time**:

- `precompute` and `opendrift` jobs go to the Celery queue `simulations`
  (`worker/manager.py`, `SIMULATION_PROCESSES`), served by the `simulation-worker` service with
  `--concurrency=1`. A second simulation is **queued**, not rejected.
- PMAR and connectivity analyses go to the default queue, served by `celery-worker` with
  `--concurrency=3`: an analysis never waits for a simulation.

Each scenario carries its state in its JSON (`processes/scenario_state.py`), so the list looks the
same after a page reload, from another tab or from another device:

| `state` | Meaning |
|---|---|
| `queued` | Accepted, waiting for the running simulation to finish. `queue_position` 1 = next |
| `running` | Being computed; `progress = {done, total}` counts the finished seedings |
| `ready` | All NetCDF files written: usable in the Analysis tab |
| `failed` | Did not complete; `error` says why. Partial NetCDF files are deleted, the JSON and shapefile stay so the user sees what happened, until removed with `remove_scenario` |

What happens when things go wrong:

| Event | Result |
|---|---|
| OpenDrift / CMEMS error, or the 12 h soft time limit | `failed` with the error message |
| **Stop** on a queued or running simulation (`DELETE /jobs/<id>`) | Cancelled, not failed: JSON, NetCDF and shapefile are deleted. A revoked job that was still in the queue is skipped even after a worker restart, because the task checks the job status in Redis before starting |
| `simulation-worker` restarted or killed mid-run | At startup the worker marks every `running` scenario as `failed` (*interrupted by a server restart*) and sets its job to `failed`. The simulation is **not** re-run automatically: the user decides whether to launch it again |
| Worker killed while holding the next queued simulation (prefetch) | At startup it puts that message back at the head of the queue instead of leaving it to Redis' visibility timeout (hours) |
| Job record expired or lost from Redis | The status process marks the scenario `failed` (*job lost*) |
| Scenarios created before this tracking existed | `ready` if all their NetCDF files exist, otherwise `failed` (*incomplete*) and removable |

Celery settings (`worker/app.py`): `task_time_limit` 12 h with a soft limit 5 minutes earlier;
`broker_transport_options.visibility_timeout` 13 h. With `task_acks_late` Redis re-delivers a
message not acknowledged within the visibility timeout, and the 1 h default made any analysis
longer than an hour run twice; it must stay above the longest task. Simulation tasks are
acknowledged when they start (`acks_late=False`), so a crash never silently re-runs one.

## Scenario status process

**Endpoint:** `POST /processes/scenario_status/execution`

Returns the list of all saved custom scenarios and the available Tools4MSP geographic areas.

Two inputs make it answer about a single item instead, so that the map can highlight one area
without the listing paying for it:

| Input | Returns |
|---|---|
| `area_id` | `{ "geo": … }` — geometry of that Tools4MSP area, fetched once and cached in memory |
| `scenario_id` | `{ "geo": … }` — seeding geometry of that scenario, read from its shapefile and merged with `union_all()` so a multi-polygon area stays a single geometry |
| `remove_scenario` | `{ "removed": … }` — deletes a **failed** scenario (JSON, shapefile). Requires full access; ready, queued and running scenarios are refused (a running one is stopped with Stop) |

The listing is polled every 5 seconds while a simulation is queued or running, which is why
reading shapefiles belongs in these branches and not in the listing itself. Each listing also
reconciles the queued and running scenarios with their jobs in Redis (see
[Simulation queue and lifecycle](#simulation-queue-and-lifecycle)). Scenarios are sorted newest
first by `created_at` (file modification time for older ones).

### Output

```json
{
  "scenarios": {
    "custom_a1b2c3d4": {
      "computed": true,
      "nc_size_mb": 142.5,
      "label_it": "Plastica — 2026-04-01",
      "label_en": "Plastica — 2026-04-01",
      "area_it": "Mare Adriatico",
      "area_en": "Adriatic Sea",
      "description": "Test con area grande",
      "pressure": "plastic",
      "pnum": 5000,
      "duration_days": 30,
      "time_step_hours": 1,
      "start_time": "2026-04-01",
      "res": 0.1,
      "cmems_margin": 5.0,
      "seeding_mode": "per_polygon",
      "pnum_per_polygon": 500,
      "n_polygons": 9,
      "bounds": [11.89, 42.49, 16.42, 45.68],
      "source": "custom",
      "state": "running",
      "progress": { "done": 1, "total": 3 },
      "queue_position": null,
      "error": null,
      "created_at": "2026-10-19T09:51:20+00:00",
      "started_at": "2026-10-19T09:51:21+00:00",
      "finished_at": null,
      "job_id": "a30a7c4c-…"
    }
  },
  "t4msp_areas": [
    { "id": 12, "label": "Adriatic Sea" },
    { "id": 7,  "label": "North Sea" }
  ]
}
```

`computed` is true only for `ready` scenarios. `job_id` is returned only with full access and only
for queued or running scenarios: it is what the Stop button sends.

## PMAR process

**Endpoint:** `POST /processes/pmar/execution`

Runs PMAR density analysis on a precomputed scenario trajectory.

### Inputs

| Parameter | Description | Default |
|---|---|---|
| `scenario_id` | ID of a precomputed scenario (`custom_<id>`) | — |
| `res` | Grid resolution in degrees: 0.1 or 0.05 (other values are refused) | 0.1 |
| `margin` | Degrees added beyond the seeding bbox to define the study area | 1.0 |
| `use_source` | Weighting layer: `none`, `windfarms`, `offshore_installations`, `msp_zones`, `geotiff` | `none` |
| `geotiff_b64` | Base64-encoded GeoTIFF for custom weighting (when `use_source=geotiff`) | — |

### Output

```json
{
  "type": "raster",
  "raster_values": [[...]],
  "raster_lon_min": 12.1,
  "raster_lat_min": 43.5,
  "raster_res": 0.1,
  "raster_nx": 80,
  "raster_ny": 50,
  "vmin": 1.2,
  "vmax": 847.0,
  "colorbar_b64": "...",
  "colorbar_light_b64": "...",
  "max_raster_values": [[...]], "max_colorbar_b64": "...", "max_vmin": 0.0, "max_vmax": 1.0, "max_geotiff_b64": "...",
  "q90_raster_values": [[...]], "q90_colorbar_b64": "...", "q90_vmin": 0.0, "q90_vmax": 1.0, "q90_geotiff_b64": "...",
  "std_raster_values": [[...]], "std_colorbar_b64": "...", "std_vmin": 0.0, "std_vmax": 1.0, "std_geotiff_b64": "...",
  "geotiff_b64": "...",
  "bounds": [[lat_min, lon_min], [lat_max, lon_max]],
  "pressure": "generic|plastic|oil|larvae",
  "label_it": "...",
  "label_en": "...",
  "use_source": "none|windfarms|offshore_installations|geotiff",
  "use_weighted": false,
  "start_time": "YYYYMMDD",
  "end_time": "YYYYMMDD",
  "pnum": 1000,
  "scenario_id": "custom_a1b2c3d4",
  "seeding_geojson": {...},
  "windfarms_geojson": {...},
  "offshore_geojson": {...}
}
```

`seeding_geojson` is always included and contains the simplified seeding area polygon displayed on the map. `windfarms_geojson` and `offshore_geojson` are included only when the respective source layer was used.

The `max_*`, `q90_*` and `std_*` fields are present for **multi-seeding** scenarios only. They are
statistics **across the seedings**, cell by cell, of the per-seeding passage maps: maximum, 90th
percentile and standard deviation; the density raster (no prefix) is their mean and is always
present. This differs from the PMAR library's `get_indicators()`, which computes SUM / MAX / Q90
over the **time** axis of a single run; the across-seedings reading is the one the interface
mock-up asks for ("available because the simulation uses multi seeding") and is to be confirmed
with the PMAR authors. SUM is no longer returned.

`colorbar_b64` uses white text (for dark map theme); `colorbar_light_b64` uses dark text (for light map theme). Both are always returned for the density raster and for each indicator.

### Spatial domains

Three nested spatial domains govern the workflow:

| Domain | Definition | Purpose |
|---|---|---|
| Seeding area | User-drawn polygon / shapefile / T4MSP area | Where particles are released |
| CMEMS domain | Seeding bbox ± `cmems_margin` (default 5°) | Ocean current data coverage |
| Study area | Seeding bbox ± `margin` (default 1°) | PMAR output raster extent |

Setting `cmems_margin` large enough to cover expected particle drift is important: particles that exit the CMEMS domain lose forcing data. Setting `margin` controls how wide the output heatmap is.

### Heatmap rendering

- Colormap `Spectral_r` with `LogNorm`
- vmin = 2nd percentile of positive values, vmax = 98th percentile (auto-adaptive per run)
- Transparent cells for value ≤ 0 or NaN
- Rendered as a canvas overlay in the browser (not a server-side PNG)
- Hovering over a cell shows its value, coordinates, and a stable **cell ID** in the format `{lon}E_{lat}N` (rounded to grid resolution) — useful for cross-run comparisons
- The legend is drawn by the frontend, not from the `colorbar_b64` PNGs (still returned for API clients): see *Interactive legend* below

### GeoTIFF structure

Single float32 band. Cell value = raw particle passage counts (or weighted density). `nodata = 0.0`, CRS EPSG:4326, LZW compression.

### Download filename format

```
pmar_<pressure>_<YYYYMMDD>-<YYYYMMDD>_p<pnum>[_<use_source>].tif
```

### PROJ note

`pmar.py` hardcodes `PROJ_LIB` to a conda path at import time, corrupting PROJ for pyproj and rasterio. PMARProcess.py removes both `PROJ_LIB` and `PROJ_DATA` from the environment after importing PMAR, allowing each library to find its own data directory.

## Connectivity process

**Endpoint:** `POST /processes/connectivity/execution`  
**Execution mode:** asynchronous (`Prefer: respond-async`)

Builds a connectivity matrix between areas from the Lagrangian trajectories of a precomputed
scenario, and derives its graph metrics. The metrics are **not**
reimplemented here: they come from the PMAR library (`get_cm`, `get_particles_by_cell`,
`connectivity_analysis`, `get_network`, `export_network`), which this process drives and whose
output it packages for the map.

### Inputs

| Parameter | Description |
|---|---|
| `scenario_id` | Precomputed scenario to read trajectories from (required) |
| `shapefile_b64` | Base64-encoded ZIP of the polygons used as network nodes |
| `geojson` | Polygons as GeoJSON (alternative to the shapefile) |
| `node_source` | `seeding_area` uses the polygons of the scenario's own seeding area (at least 2); otherwise inferred from the other inputs |
| `grid_res` | Builds the nodes as a regular grid of ocean cells instead: any resolution between 0.05 and 5 degrees (at most 300 sea cells) |
| `bbox` | `[lon_min, lat_min, lon_max, lat_max]` for the grid, widened to multiples of `grid_res`; defaults to the scenario's seeding area |
| `mode` | `passage` (default) or `transition`; `transit`, the former name of `passage`, is still accepted |
| `t_days` | Time horizon in days; defaults to the scenario duration |
| `node_label_field` | Shapefile attribute used to label the nodes |
| `self_loops` | Whether i→i counts toward the metrics (default `false`) |
| `margin` | Degrees added around the nodes when defining the study area (default 1.0) |

`node_source: seeding_area` wins; otherwise polygons (`shapefile_b64` / `geojson`) or `grid_res`
must be provided, and polygons win if both are given. The grid box is aligned to multiples of
`grid_res` exactly as the Markov grid is, so a transition matrix on a generated grid and a Markov
forecast with the same `res`, `bbox` and Δt share their cells (verified: identical matrices on the
common cells).

### Output

```json
{
  "type": "connectivity",
  "mode": "passage",
  "node_source": "grid",
  "grid_res": 0.5,
  "grid_bbox": [11.5, 42.0, 16.5, 46.0],
  "t_days": 30,
  "polygons_geojson": { "type": "FeatureCollection", "features": [] },
  "edges_geojson":    { "type": "FeatureCollection", "features": [] },
  "matrix": [[0.95, 0.04], [0.01, 0.97]],
  "node_ids": [0, 1],
  "node_labels": ["r0c3", "r0c4"],
  "n_released": [412, 388],
  "min_particles": 30,
  "metric_ranges": { "in_strength": [0.0, 1.9] },
  "bounds": [[42.49, 11.89], [45.68, 16.42]],
  "warnings": []
}
```

Each polygon feature carries `node_id`, `node_label`, `in_strength`, `out_strength`,
`betweenness`, `n_released` and `reliable`. Each edge feature — the curve **and** the arrowhead
drawn at its end — carries `source`, `target` and `p`, which is what lets the frontend isolate
one node's connections without asking the backend again.

`warnings` holds objects, not sentences, so that the frontend can phrase them in the user's
language: a `code`, the numbers it needs, and an English `message` for API clients that do not
know the codes.

| `code` | Extra fields | When |
|---|---|---|
| `edges_trimmed` | `drawn`, `total` | The network exceeded `MAX_EDGE_FEATURES` and was thinned for drawing |
| `weak_polygons` | `count`, `total`, `min_particles`, `labels` | Some nodes hold fewer than `MIN_PARTICLES` particles at time 0 |

### Limits and guards

| Limit | Value | Why |
|---|---|---|
| `MAX_POLYGONS` | 300 | The matrix is dense and travels whole through Redis and into the browser |
| `MIN_PARTICLES` | 30 | Below this a row is reported as unreliable rather than shown as a result |
| `MAX_TIME_PASSES` | 180 | Passage repeats a point-in-polygon pass per timestep; beyond this the time axis is subsampled |
| `MAX_EDGE_FEATURES` | 1500 | Drawing limit only — the matrix stays complete |

When the network exceeds the drawing limit it is thinned **fairly**, in rounds: each round every
node gives up its strongest remaining outgoing edge. Keeping the globally strongest edges instead
concentrates the drawing on a few corridor cells, and clicking any other cell then shows nothing
at all despite a matrix full of values.

### Notes

- The *passage* matrix (formerly called *transit*) is built by `_passage_matrix()` in this process: it reproduces
  `get_cm_within_range`, which the public PMAR removed as unused, on top of
  `get_particles_by_cell`. Unlike `get_cm` it does not set `self.cm`, while
  `connectivity_analysis()` requires it — the process assigns it explicitly.
- `get_network()` is called **without** `node_names`: with them, `export_network` writes the
  labels into the edges' `source`/`target`, while the frontend filters edges by comparing those
  with the integer `node_id`. Labels travel separately in `node_labels`.
- With multi-seeding scenarios the matrices of the individual runs are averaged here;
  `PMARmulti.get_cm` only averages *transition* matrices.
- The grid is built once with `make_grid` + `make_vector_grid` and then passed as `cm_grid`, so
  the two node sources share the whole downstream path. `make_grid` masks land using Natural
  Earth ocean polygons, downloaded on first use inside the container.

## Markov process

**Endpoint:** `POST /processes/markov/execution` (async, default Celery queue)

A statistical forecast of tracer dispersal with Markov chains:

- From the trajectories of a pre-computed scenario, a **transition matrix** between the cells of a
  regular grid is estimated: pᵢⱼ = Nᵢⱼ / Nᵢ, the share of the particles in cell i at t₀ that are in
  cell j after Δt.
- A tracer release is then propagated step by step:
  - **single** release: q·Mᵏ;
  - **continuous** release (the same release every Δt): Σₖ₌₁ⁿ q·Mᵏ.
- Frames can go **beyond the simulation length**. While they stay within it, every frame is
  compared with what the particles actually do.

| Input | Description |
|---|---|
| `scenario_id` | Pre-computed scenario |
| `res` | Grid resolution, 0.05–5 degrees (default 0.25) |
| `bbox` | `[lon_min, lat_min, lon_max, lat_max]` of the grid; defaults to the seeding area |
| `dt_days` | Transition interval Δt, from one time step to the simulation length |
| `steps` | Number of Δt steps, 1–100 (default 100); the horizon is `steps × Δt` and may exceed the simulation. `horizon_days` is still accepted when `steps` is absent |
| `release` | `single` or `continuous` |
| `source` | `uniform`, `windfarms`, `offshore_installations`, `msp_zones`, `geotiff`, `area` |
| `geotiff_b64`, `area_geojson` | The emission raster or the drawn release area, when the source needs them |

**How it is computed** (`processes/markov_core.py`, numpy and scipy only):

- **Grid.** A regular grid aligned to multiples of `res` over the seeding area. Particles are
  assigned to cells arithmetically (`floor((lon − lon₀) / res)`), not by point-in-polygon. The
  matrix equals `PMAR.get_cm` on the same cells, verified to 0.0; the only difference is a
  particle lying exactly on a cell edge, which shapely's `within` drops and the arithmetic keeps.
- **Domain.** The cells holding at least one particle at t₀. Mass moving anywhere else, or
  particles without a position (stranded, or outside the forcing: OpenDrift writes NaN), counts as
  **left the domain**. This is an absorbing "outside" state. Without it, a cell with no
  departing particles would swallow the mass that reaches it.
- **Multi-seeding.** Pooled estimate Σₛ Nᵢⱼ / Σₛ Nᵢ. It equals the mean of the per-seeding matrices
  (M̄) when every seeding releases the same particles in the same cells, as OpenDrift's
  fixed seeding grid does.
- **Initial state.**
  - `uniform`: 1 in every domain cell, giving relative concentration (1 = initial);
  - other sources: rasterized on the same grid with the PMAR helpers (`_gdf_to_use_raster`,
    `_geotiff_to_use_raster`), then normalised so that each release sums to 1 (fraction of the
    release).
- **Validation.** Each particle carries q₀(cell at t₀)/Nᵢ, and the reference map is the weighted
  histogram of the particles at kΔt. For a continuous release it is Σᵢ₌₁ᵏ of those maps.
  Per frame the process returns the difference (Markov − simulation), the signed maximum error, the
  mean absolute error, and the mass that left the domain in both.
  - At k = 1 the chain matches the simulation **exactly**, by construction. This is the method's
    built-in check, verified at 0.0 together with mass conservation.

**Warnings** (`warnings`, with a code the UI translates):

- `weak_cells`: cells with fewer than 30 particles per seeding at t₀;
- `dt_short`: half of the cells keep more than 90% of their particles after Δt, so Δt is too
  short for the grid and transport is underestimated;
- `beyond_simulation`: frames after this day have no reference;
- `source_outside`: part of the source lies outside the domain.

**Payload limit.** The frames travel whole to the browser, so `cells × (steps + 1)` must stay
within 400 000 values; beyond it the process answers 400 with the number of steps that would fit.

**Output:**
- `grid`, `grid_bbox` and `cells`, the domain as flat row × nx + col indices, row 0 to the south;
- `steps`, the number of Δt steps computed;
- `frames`: `[{k, day, values, mass_in, mass_out, released, ref: {values, emax, mae, mass_out} | null}]`;
- `vmin` / `vmax`, common to all frames so colours stay comparable along the slider;
- `diff_max` for the symmetric difference scale;
- `source_geojson`, the parameters and `bounds`.

The frontend rebuilds the PMAR raster of any frame and layer (`frontend/src/markov/frames.js`). So
the heatmap, legend and analysis tools work on the frame shown, except on the difference map,
whose values are signed.

**Beaching.** Markov chains need a conservative tracer (no beaching). A stranded particle has
no position afterwards (OpenDrift writes NaN), so it falls in no cell and in no buffer: with
`get_cm(buffer=…)` its row would no longer sum to 1. Here it counts as having left the domain, so
mass is still accounted for. For forecasts, pre-compute the scenario with
*No beaching (for Propagate)* (`beaching: false`); the Propagate section warns when the selected scenario has
beaching on, and the card then labels the lost mass "left or beached".

**Data requirement.** About 50 particles per cell are recommended. With the 10 000 particles of most
existing scenarios, cells at 0.25° hold fewer than 30, and the forecast diffuses more than the
simulation: it loses more mass from the domain and spreads more. For meaningful forecasts, use a
scenario seeded uniformly over the area with as many particles as possible (up to 100 000) and a
coarse grid.

## Anthropogenic layers

All layers query the [EMODnet Human Activities WFS](https://ows.emodnet-humanactivities.eu/wfs) and cache results as pickle files (7-day TTL) in `cache/emodnet/`. Each layer tries a primary WFS type name first and falls back to alternates if it is unavailable.

| `use_source` | Data source (primary → fallbacks) | Coverage note |
|---|---|---|
| `windfarms` | `emodnet:windfarmspoly` → `emodnet:windfarms` (polygons) | North Sea, Atlantic, Baltic |
| `offshore_installations` | `emodnet:offshorefacilities` → `emodnet:offshore_installations` → `emodnet:platforms` (points) | European waters |
| `msp_zones` | `emodnet:mspzoningpoly`, filtered to Italy + aquaculture via `CQL_FILTER` (polygons) | Italian waters only |

When a layer is active as `use_source`, its features are rasterized onto the simulation grid and used as PMAR weights. Features are returned in the response as GeoJSON for display on the map.

A fourth EMODnet process, **Natura 2000** protected areas (`emodnet:natura2000areas` → `emodnet:marineprotectedareas`), is still registered but no longer used by the interface: the *Additional layers* box was removed in the redesign.

### Preview processes

Lightweight processes allow the frontend to preview layer coverage before running an analysis:

- `POST /processes/windfarms/execution`
- `POST /processes/offshore_installations/execution`
- `POST /processes/msp_zones/execution`
- `POST /processes/natura2000/execution` (not used by the UI)

All four accept `lon_min`, `lat_min`, `lon_max`, `lat_max` as inputs.

### Shapefile columns

`POST /processes/shapefile_fields/execution` (synchronous) reads an uploaded shapefile
(`shapefile_b64`) and returns its columns, so that *Polygon label* can offer them:

```json
{ "columns": [{ "name": "name", "samples": ["A1", "B2", "C2"], "unique": true }], "n_features": 4, "n_polygons": 4 }
```

## CMEMS data

Ocean currents, wind, waves, temperature/salinity, and bathymetry are downloaded automatically from the Copernicus Marine Service and cached in `cache/`. All files are keyed on the seeding area bounding box, CMEMS margin, start date, and duration. The download bbox is `seeding_bounds ± cmems_margin`.

**Currents** (all models):

| Priority | Dataset | Coverage |
|---|---|---|
| 1 | `cmems_mod_med_phy-cur_anfc_0.042deg_PT1H-m` | Mediterranean, hourly |
| 2 | `cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m` | Global, daily |
| 3 | `cmems_mod_glo_phy_my_0.083deg_P1D-m` | Global, daily (reanalysis) |

**Wind** (`PlastDrift`, `OpenOil`):

| Priority | Dataset |
|---|---|
| 1 | `cmems_obs-wind_med_phy_nrt_l4_0.125deg_PT1H` |
| 2 | `cmems_obs-wind_glo_phy_nrt_l4_0.125deg_PT1H` |
| 3 | `cmems_obs-wind_glo_phy_my_l4_0.125deg_PT1H` |

**Waves — Stokes drift** (`PlastDrift`, `OpenOil`):

| Priority | Dataset |
|---|---|
| 1 | `cmems_mod_med_wav_anfc_4.2km_PT1H-i` |
| 2 | `cmems_mod_glo_wav_anfc_0.083deg_PT3H-i` |
| 3 | `cmems_mod_glo_wav_my_0.2deg_PT3H-i` |

**Temperature & salinity** (`OpenOil` weathering, `ChemicalDrift`):

| Priority | Dataset | Variables |
|---|---|---|
| 1 | `cmems_mod_glo_phy_anfc_0.083deg_P1D-m` | thetao, so |
| 2 | `cmems_mod_glo_phy_my_0.083deg_P1D-m` | thetao, so |
| 3–5 | Mediterranean / global temperature-only products | thetao |

**Mixed layer depth** (`ChemicalDrift`): `mlotst` from `cmems_mod_med_phy-mld_anfc_4.2km_P1D-m`,
then the global analysis and reanalysis (`CMEMS_MLD_DATASETS`); non-blocking, OpenDrift's fallback
(50 m) is used without it. `ChemicalDrift` also reads the cached bathymetry file as
`sea_floor_depth_below_sea_level`.

**Bathymetry** (`LarvalFish`, `OpenOil`, `ChemicalDrift` — models with vertical mixing):

The `deptho` (seafloor depth) field is downloaded once per geographic area from a static CMEMS dataset (`cmems_mod_med_phy_anfc_4.2km_static` or global equivalent) and permanently cached. `maximum_depth` for the currents download is set to `max(deptho) + 10 m` instead of a fixed value, ensuring full water-column coverage in deep areas and avoiding over-downloading in shallow ones. If the bathymetry download fails the fixed default is used as fallback.

Wind and waves downloads are non-blocking: if the dataset is unavailable the simulation continues with currents only (OpenDrift falls back to parametric Stokes drift from wind).

**ChemicalDrift.** The `chemical` tracer runs OpenDrift's `ChemicalDrift` with the settings of the
PMAR library (`pmar.py`): vertical mixing (`windspeed_Large1994`), sediment resuspension and
desorption, volatilisation and degradation (`OverallRateConstants`), then
`init_chemical_compound(compound)`, `init_species()` and `init_transfer_rates()`. Its readers are
added **without lazy loading**: `ChemicalDrift.prepare_run` reads `.variables` of every reader, which
initialises a lazy reader outside the environment, so the currents never enter the priority list
and every particle is deactivated at the first step with "Missing variables". In the
Mediterranean the temperature product has no salinity, so salinity uses OpenDrift's fallback (34).

## Frontend API client

Every request to the backend goes through `src/api/ogcProcesses.js`. The module depends on nothing
but the Fetch API, which keeps the backend contract in one place and makes it reusable outside this
SPA — from a test, a script, or another framework.

| Function | Purpose |
|---|---|
| `executeSync(processId, inputs)` | Runs a fast, read-only process and returns its unwrapped output |
| `executeAsync(processId, inputs)` | Submits a process to the Celery worker, returns the job id |
| `fetchJobStatus(jobId)` | Reads a job document once, for callers driving their own polling |
| `waitForJob(jobId)` | Polls until the job reaches a terminal state |
| `fetchJobResults(jobId)` | Fetches the results of a finished job |
| `dismissJob(jobId)` | Asks the backend to revoke a running job (STOP button) |
| `fetchFeatureLayer(processId, bounds)` | Runs an overlay process, returns the FeatureCollection or `null` if the bbox is empty |

Exported alongside them: the `Process`, `ErrorCode` and `JobOutcome` constants, and the `OgcError`
class.

Three conventions are worth knowing before extending it:

- **Errors carry a code, not a sentence.** `OgcError` exposes `code`, `httpStatus` and `detail`
  (whatever the backend explained, or `null` when it said nothing useful). The wording — and the
  language — is chosen by the caller, so the same failure can read differently in different parts
  of the UI.
- **A stopped job is an outcome, not a failure.** `waitForJob` resolves with
  `{ outcome: 'dismissed' }` when the user presses STOP; only a job that genuinely failed throws.
- **Synchronous output is unwrapped, job results are not.** pygeoapi wraps synchronous output in a
  `result` key, uniformly; job results instead have a different shape per process (OpenDrift returns
  `steps`/`times`, PMAR a raster payload, precompute a scenario id), so that shape is left to the
  caller.

### Tests

```bash
cd frontend
npm test        # node:test — no browser, no backend, no extra dependencies
```

The suite covers response unwrapping, the three HTTP error shapes, job success / dismissal /
failure, cancellation, tolerance to network errors and 5xx while polling, empty overlays, the
simulation states and transitions (`scenarios/lifecycle.test.js`), and how saved analyses are
read back (`storage/persistedState.test.js`).

## Frontend features

### OpenDrift tab

- Interactive seeding: draw a **circle**, a **rectangle**, or free **polygons** on the map (polygons are sent to this process as their bounding rectangle)
- Animated particle trajectories with play/pause, time slider, and speed control
- Stranded particles highlighted in red
- Toggle seeding area overlay

### Main panel (left)

- Header *PMAR — Particle-based Modelling and Analysis for MARine Decision Support*; the book icon
  opens **About PMAR**: credits (CNR-ISMAR, University of Padova, University of Venice Ca'
  Foscari), how to cite, data and software
  links (OpenDrift, CMEMS, EMODnet, PMAR, this interface)
- Two tabs, **Simulation** and **Analysis**; the font is IBM Plex Sans, as in the mock-up

**Simulation**

- Existing simulations in a dropdown with their state; selecting one shows a summary and
  highlights its seeding area on the map
- **Simulations in progress** box: running (seeding n/N, minutes since start, progress bar),
  queued (position) and failed (reason) simulations, with **Stop** and **Remove** for users with
  full access. The state comes from the server, so it survives reloads and is the same on every
  device; a notification announces each simulation that becomes ready or fails
- *New simulation*: title, description, seeding area (Draw — circle, rectangle, polygons —,
  Shapefile, Pre-defined area), seeding area name, **Tracer type** (dropdown, with *Chemical
  compound* for Chemical), *Timing & particles*, **Particle distribution** (Evenly / Per polygon,
  with the resulting total), **Advanced** (multi seeding, CMEMS margin, no beaching), the
  estimated NetCDF size, and *Pre-compute simulation* in the fixed bar at the bottom

**Analysis**: the three sections described in [Tab 2 — Analysis](#tab-2--analysis).

Every analysis is **saved in this browser** (IndexedDB), up to **10**: a page reload restores the
panel as it was — titles, visibility, opacity and view settings, active layer. An analysis still
running when the page is reloaded is **resumed**. **Clear all**, with confirmation, empties the
panel, e.g. on a shared laptop at a conference stand. The analyses are not sent to the server. At
10 the Run buttons are disabled with a message until one is deleted.

### Layers panel (right)

| Section | Contents |
|---|---|
| Base layers | *Seeding area* (of the selected simulation, or of the active layer), *Study area* (seeding box ± CMEMS margin: the simulation domain), *Source layer* (only when a non-uniform source is shown: the active layer's, or the one chosen in the form), *Connectivity grid* (outline of the nodes of the active connectivity layer, or of the latest one of the same simulation). Each has an eye; the grid starts hidden |
| Analyses layers | One card per layer, newest first: title, (i) for the summary (SIMULATION and ANALYSIS blocks), rename, show/hide, delete, **Opacity** slider (80 % by default) and **Download raster**. Clicking a card makes it **active** (blue border): legend, cell tooltip and analysis tools follow it |

Per-type extras on the card: connectivity layers have the metric (in-strength, out-strength,
betweenness), the arrows switch, the selected node with incoming / outgoing / both, and the
**Matrix** button; Propagate layers show the step on display ("Showing step k× Δt = N days").

*Download raster* writes, named after the layer title:

| Layer | File |
|---|---|
| Dispersal | The backend's GeoTIFF for the indicator shown (`_ppi`, `_max`, `_q90`, `_std`) |
| Propagate | The frame and level shown (forecast, simulation or difference), written in the browser |
| Connectivity on a generated grid | The selected metric, one cell per node |
| Connectivity on polygons | *Download GeoJSON*: the polygons with their metrics (not a raster) |

The browser-side GeoTIFFs come from `src/export/geotiff.js`: single Float32 band, uncompressed,
EPSG:4326 (ModelPixelScale, ModelTiepoint, GeoKeys), GDAL nodata 0 (none for the difference map).

**Analysis tools** sit in their own box below the Layers panel, shown once there is a layer.

### Map

- **Theme and language bar** (top left, next to the main panel; the map zoom control sits below it): light/dark theme toggle (switches CartoDB basemap and all panel colours) and IT/EN language switch. Copernicus Marine credentials are configured server-side via environment variables (see `.env`).
- **Propagate forward · Markov steps** (bottom, next to the legend), shown when the active layer
  is a Propagate one: the step slider (0 to the number of steps, with play), the label
  `k× Δt = N days`, the *Forecast / Simulation / Difference* choice (the last two disabled beyond
  the simulation), the share that left the domain and the error of the frame
- **Interactive legend** (bottom left, next to the main panel): sections for the **active analysis** — heatmap (6 log classes between `vmin` and `vmax`), connectivity polygons (5 linear classes of the active metric, plus unreliable polygons) and arrows (probability bands 0–1, 1–5, 5–10, 10–25, 25–50, 50–100 %). Each row shows its colour, range and count. Clicking rows switches classes on and off: on the map the chosen classes keep their colours and everything else is dimmed, and the arrow and node-selection filters combine. The × resets a section; a new result or indicator resets it too. Colours come from `src/legend/classes.js`, the same module the layers use, so legend and map cannot drift apart. When a new section appears the older ones collapse.
- **Analysis tools** (bottom right, below the Layers panel): *PMAR heatmap* tools — Histogram, Statistics, Profile, Threshold, CSV, Compare — on the active Dispersal or Propagate layer; disabled with a hint otherwise. "Close all (n)" appears when analysis windows are open. The connectivity matrix opens from its layer card.

  Every PMAR tool downloads a **CSV**, never an image. Each file starts with `#` metadata lines —
  tool, analysis title, scenario (label, start, duration, particles, seedings), source layer,
  value (PPI or indicator, and whether it is weighted), grid resolution, the selection and the
  export time — followed by the table. Read it with `pandas.read_csv(f, comment='#')` or
  `read.csv(f, comment.char='#')`. Labels in the files are always in English.

  | Tool | Columns | Notes |
  |---|---|---|
  | Histogram | `bin, lower, upper, count, fraction` | 20 log10 bins between vmin and vmax; the first bin starts at 0 and the last ends at `inf`, because values outside the range are counted there (as on the map) |
  | Statistics | `stat, value` | Cells > 0 in the rectangle; population std; quantiles by linear interpolation, the numpy / pandas / R default |
  | Profile | `sample, distance_km, lat, lon, cell_id, value` | Points evenly spaced along the line, each with the cell it falls in |
  | Threshold | `threshold, cells_above, area_km2, pct_cells` | Exceedance curve over 50 log10 thresholds; areas are real cell areas (cos(lat)) |
  | CSV | `row, col, cell_id, lat, lon, cell_area_km2, value` | Every cell of the rectangle, zeros included; lat/lon are cell centres |
  | Compare | `area, bin, lower, upper, count, fraction` | Long format, one block of histogram bins per area; each area described in the header |

  `cell_id` (`{lon}E_{lat}N`) is the same identifier shown by the map tooltip. The builders live in
  `frontend/src/export/pmarTools.js` and are unit-tested.

## Logging

All processes write to **stdout**, which Docker captures via `docker logs`. Use `docker logs dto-pmar-backend-1` (or `dto-pmar-celery-worker-1` for analyses, `dto-pmar-simulation-worker-1` for simulations) to stream logs in real time.
