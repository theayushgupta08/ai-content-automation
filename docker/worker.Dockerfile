# Python pipeline worker with FFmpeg. Build from the repo root:
#   docker build -f docker/worker.Dockerfile -t avg-worker .
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /app/workers
COPY workers/pyproject.toml workers/uv.lock* ./
RUN uv sync --no-dev --no-install-project

COPY workers/ ./
RUN uv sync --no-dev

RUN useradd --create-home --uid 10001 worker && chown -R worker:worker /app
USER worker

ENV PATH="/app/workers/.venv/bin:$PATH"
ENTRYPOINT ["avg-worker"]
CMD ["--all"]
