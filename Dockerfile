# Spendy — server-authoritative build (see docs/API.md, docs/DEPLOY.md).
#
#   * Python 3.12 standard library ONLY. Nothing is installed with pip, ever.
#   * The BUILD needs internet (it downloads Chart.js + PapaParse once).
#     The RUNTIME does not — that is the whole point of vendoring them.
#   * Only Spendy.html, spendy.js, server/ and the two vendored libraries enter the image.
#     User data lives exclusively in the /data volume; see .dockerignore.

# ---------------------------------------------------------------------------
# Stage 1 — vendor the two CDN runtime dependencies
# ---------------------------------------------------------------------------
# Versions come straight out of Spendy.html:
#   <script src="https://cdn.jsdelivr.net/npm/chart.js@4">                      -> pinned to 4.5.1
#   <script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/...">   -> 5.4.1
# The HTML asks for the floating tag "@4"; a floating tag in an image build is a
# reproducibility hole, so it is pinned to the exact 4.x release that "@4" resolved to
# (4.5.1). Bump this line deliberately, never implicitly.
#
# ADD, not curl/wget: python:3.12-slim ships neither and we refuse to apt-install one.
FROM python:3.12-slim AS vendor

ADD https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js         /vendor/chart.umd.min.js
ADD https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js   /vendor/papaparse.min.js

# Integrity gate, run with the interpreter that is already here (no extra tooling).
# A truncated, error-page-instead-of-JS, or tampered download must fail the build —
# this image ends up on a machine that holds card numbers and CVVs.
# Remote ADD lands files as 0600 root; chmod so the non-root runtime user can read them.
RUN python -c "import hashlib,sys; exp={'/vendor/chart.umd.min.js':'48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a','/vendor/papaparse.min.js':'b8e870c5d2b29772f10c9fa9a693c8b896aac8540ed6701e3cc6304c683febdb'}; bad=[p for p,h in exp.items() if hashlib.sha256(open(p,'rb').read()).hexdigest()!=h]; sys.exit('VENDOR CHECKSUM MISMATCH: '+', '.join(bad)) if bad else print('vendor checksums OK')" \
 && chmod 0644 /vendor/*.js

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim

LABEL org.opencontainers.image.title="Spendy" \
      org.opencontainers.image.description="Spendy expense tracker — stdlib-only Python + SQLite server" \
      org.opencontainers.image.source="https://github.com/Zinjpq/Spendy"

# Fixed UID/GID so the host side of the bind mount can be chowned deterministically:
#     sudo chown -R 10001:10001 ./data
# A bind-mounted host directory keeps HOST ownership — the chown below only affects the
# image layer, so the host chown in docs/DEPLOY.md is mandatory, not optional.
ARG SPENDY_UID=10001
ARG SPENDY_GID=10001
RUN groupadd --gid "${SPENDY_GID}" spendy \
 && useradd --uid "${SPENDY_UID}" --gid "${SPENDY_GID}" \
            --home-dir /app --no-create-home --shell /usr/sbin/nologin spendy

WORKDIR /app

# Application only. Never the repo's data files — .dockerignore denies everything by
# default and re-allows exactly these three paths.
COPY --chown=spendy:spendy Spendy.html spendy.js /app/
COPY --chown=spendy:spendy server/ /app/server/
COPY --from=vendor --chown=spendy:spendy /vendor/ /app/vendor/

# SPENDY_APP_DIR is set explicitly rather than relying on "the directory containing
# Spendy.html", so static serving does not depend on how app.py resolves its own path.
# SPENDY_HOST=0.0.0.0 binds inside the container only; what the LAN can reach is decided
# by the host-side port binding in docker-compose.yml (default 127.0.0.1).
ENV SPENDY_DATA=/data \
    SPENDY_APP_DIR=/app \
    SPENDY_HOST=0.0.0.0 \
    SPENDY_PORT=8765 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Seed the layout + ownership. Relevant for a named/anonymous volume (Docker copies image
# content and ownership into it on first use) and harmless for a bind mount.
RUN mkdir -p /data/images /data/tmp && chown -R spendy:spendy /data
VOLUME ["/data"]

EXPOSE 8765
USER spendy

# No curl in slim images — urllib is right there. Non-2xx or a refused connection raises,
# the process exits non-zero, the container is marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('SPENDY_PORT','8765')+'/api/health', timeout=4).read(1)"]

# exec form: python is the container's main process, so the stop signal is delivered to it
# and not to an intermediate /bin/sh. Python as PID 1 still ignores SIGTERM's default action,
# which is why docker-compose.yml sets `init: true` (docker-init/tini becomes PID 1 and
# forwards the signal) — `docker stop` then returns immediately instead of waiting 10s.
STOPSIGNAL SIGTERM
CMD ["python", "/app/server/app.py"]
