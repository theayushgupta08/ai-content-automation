.PHONY: help setup up down dev demo test lint typecheck gen-contracts clean

help:
	@echo "Targets:"
	@echo "  setup          install JS and Python dependencies, generate contracts and Prisma client"
	@echo "  up / down      start / stop the local stack with docker compose"
	@echo "  migrate        apply Prisma migrations to DATABASE_URL"
	@echo "  dev            run api, web and workers with hot reload (requires 'make up')"
	@echo "  demo           run one job end to end against mock providers and print the MP4 path"
	@echo "  test           run all test suites"
	@echo "  lint           lint TypeScript and Python"
	@echo "  typecheck      typecheck TypeScript and Python"
	@echo "  gen-contracts  regenerate TS/Python types from packages/contracts/schemas"
	@echo "  clean          remove build outputs and local media"

setup:
	pnpm install
	cd workers && uv sync --all-extras
	pnpm gen:contracts
	pnpm --filter @avg/api prisma:generate

up:
	docker compose up -d --wait

down:
	docker compose down

migrate:
	pnpm --filter @avg/api prisma:migrate

dev:
	pnpm dev & \
	cd workers && uv run avg-worker --all; \
	wait

demo:
	bash scripts/demo.sh

test:
	pnpm test
	cd workers && uv run pytest -q

lint:
	pnpm lint
	cd workers && uv run ruff check . && uv run ruff format --check .

typecheck:
	pnpm typecheck
	cd workers && uv run mypy avg_workers

gen-contracts:
	pnpm gen:contracts

clean:
	rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/*/dist packages/*/dist apps/web/.next .turbo .local
	rm -rf workers/.venv workers/.pytest_cache workers/.mypy_cache workers/.ruff_cache
