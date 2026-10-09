# syntax=docker/dockerfile:1
FROM python:3.12-slim

# System libraries for geospatial stack
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        g++ \
        cmake \
        libgdal-dev \
        gdal-bin \
        libgeos-dev \
        libproj-dev \
        proj-bin \
        libhdf5-dev \
        libnetcdf-dev \
        libspatialindex-dev \
        curl \
        git \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Install Python dependencies before copying full source (layer cache)
COPY requirements.txt ./

# roaring-landmask (OpenDrift dep) downloads ~97MB of geo data (4 files) from GitHub at build
# time via its Rust build.rs, with no env-var override and no retry logic of its own.
# Pre-download all 4 assets with curl (retries survive flaky GitHub raw CDN), then build the
# package from a local source checkout so build.rs finds them already in place and skips
# the network entirely.
RUN mkdir -p /tmp/rl_assets && \
    for f in gshhg.wkb.xz gshhg_mask.tbmap.xz osm.wkb.xz osm_mask.tbmap.xz; do \
        curl -L --retry 8 --retry-delay 10 --retry-all-errors --max-time 300 \
            "https://github.com/gauteh/roaring-landmask/raw/main/assets/$f" \
            -o "/tmp/rl_assets/$f"; \
    done
RUN pip download --no-binary roaring-landmask --no-deps --no-cache-dir \
        -d /tmp/rl_src roaring-landmask && \
    cd /tmp/rl_src && \
    tar xzf *.tar.gz && \
    rm -f *.tar.gz && \
    RL_DIR=$(ls -d */) && \
    mkdir -p "${RL_DIR}assets" && \
    cp /tmp/rl_assets/*.xz "${RL_DIR}assets/" && \
    pip install --no-cache-dir --timeout 300 "/tmp/rl_src/${RL_DIR}" && \
    rm -rf /tmp/rl_assets /tmp/rl_src

RUN pip install --no-cache-dir --timeout 300 -r requirements.txt \
    && pip install --no-cache-dir --timeout 300 gevent gunicorn

# Install private PMAR package (token injected at build time, never stored in image)
RUN --mount=type=secret,id=git_token \
    if [ -f /run/secrets/git_token ]; then \
        TOKEN=$(tr -d '[:space:]' < /run/secrets/git_token) && \
        GIT_TERMINAL_PROMPT=0 pip install --no-cache-dir \
            "git+https://iegor-toporov:${TOKEN}@github.com/iegor-toporov/pmar.git@bugfix/fix-streaming"; \
    fi

# Copy application source
COPY data/ ./data/
COPY processes/ ./processes/
COPY pygeoapi-config.yml ./
COPY scripts/entrypoint.sh ./scripts/entrypoint.sh
RUN sed -i 's/\r$//' /app/scripts/entrypoint.sh && chmod +x /app/scripts/entrypoint.sh
COPY worker/ ./worker/

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:5001/ || exit 1

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
