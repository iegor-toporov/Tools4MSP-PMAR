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

# roaring-landmask (OpenDrift dep) downloads ~40MB from GitHub at build time via reqwest.
# Pre-download with curl (better retry control) so the Rust build script finds it locally.
RUN curl -L --retry 5 --retry-delay 10 --max-time 300 \
    "https://github.com/gauteh/roaring-landmask/raw/main/assets/gshhg.wkb.xz" \
    -o /tmp/gshhg.wkb.xz
RUN GSHHG=/tmp/gshhg.wkb.xz pip install --no-cache-dir --timeout 300 roaring-landmask

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
