# Python pipeline worker with FFmpeg. Build from the repo root:
#   docker build -f docker/worker.Dockerfile -t avg-worker .
# Ubuntu 24.04 ships FFmpeg 6.1 and Python 3.12, the exact versions CI runs the test suite on.
FROM ubuntu:24.04

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
  UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/bin/python3

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    python3 python3-pip ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages "uv>=0.8,<0.9"

WORKDIR /app/workers
COPY workers/pyproject.toml workers/uv.lock* ./
RUN uv sync --no-dev --no-install-project

COPY workers/ ./
RUN uv sync --no-dev

RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

ENV PATH="/app/workers/.venv/bin:$PATH" MEDIA_BACKEND=s3 MEDIA_CACHE_DIR=/tmp/avg-media-cache
ENTRYPOINT ["avg-worker"]
CMD ["--all"]
