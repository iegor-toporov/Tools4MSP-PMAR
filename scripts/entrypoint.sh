#!/bin/sh
set -e

# Create required directories
mkdir -p cache/emodnet out scenarios

# Fix hardcoded absolute paths in pygeoapi config (dev machine paths → /app)
CONFIG_SRC="${PYGEOAPI_CONFIG_SRC:-/app/pygeoapi-config.yml}"
CONFIG_OUT="${PYGEOAPI_CONFIG:-/tmp/pygeoapi-runtime.yml}"

sed 's|/Users/[^/]*/Documents/[^:]*DTO-PMAR|/app|g' "$CONFIG_SRC" > "$CONFIG_OUT"

export PYGEOAPI_CONFIG="$CONFIG_OUT"
export PYGEOAPI_OPENAPI="${PYGEOAPI_OPENAPI:-/tmp/pygeoapi-openapi.yml}"

# If the first argument is "celery", start the worker instead of gunicorn
if [ "${1:-}" = "celery" ]; then
    # Partial NetCDF files left by simulations interrupted by the previous crash. Only
    # the simulation worker writes them, and when it starts it has none running;
    # `out/` is shared, so if the analysis worker did this too, restarting it would
    # delete the file of the simulation that is running.
    if [ "${PMAR_SIMULATION_WORKER:-}" = "1" ]; then
        rm -f /app/out/precompute_*.nc /app/out/precompute_*.nc_tmp
    fi
    shift
    exec celery "$@"
fi

# CMEMS catalogue: refreshed and checked in the background, without delaying the start.
# Warnings in the log if a dataset of the registry disappears or is being retired.
python /app/scripts/check_cmems_catalog.py &

# Generate OpenAPI spec from the fixed config (only for the gunicorn backend)
pygeoapi openapi generate "$PYGEOAPI_CONFIG" --output-file "$PYGEOAPI_OPENAPI"

# Hand off to gunicorn with proper signal handling
exec gunicorn \
    --workers "${GUNICORN_WORKERS:-4}" \
    --worker-class gevent \
    --timeout 600 \
    --bind 0.0.0.0:5001 \
    --access-logfile - \
    --error-logfile - \
    pygeoapi.flask_app:APP
