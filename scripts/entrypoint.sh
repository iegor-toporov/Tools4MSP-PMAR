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

# Se il primo argomento è "celery", avvia il worker invece di gunicorn
if [ "${1:-}" = "celery" ]; then
    # Rimuovi file NC parziali lasciati da simulazioni interrotte al crash precedente
    rm -f /app/out/precompute_*.nc
    shift
    exec celery "$@"
fi

# Generate OpenAPI spec from the fixed config (solo per il backend gunicorn)
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
