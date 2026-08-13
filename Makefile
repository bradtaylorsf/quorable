# quorable — Makefile
# Repo-level targets only (install/test). Project-level run targets (run-ask,
# run-persona P=, ...) live in each project's own Makefile, parent-style.

SHELL := /bin/zsh

# Load .env if it exists
ifneq (,$(wildcard .env))
  include .env
  export
endif

.PHONY: install
install: ## Install package and dev dependencies (uv-managed venv)
	uv sync --extra dev

.PHONY: test
test: ## Run unit/integration tests (no network)
	uv run pytest tests/ -q

.PHONY: test-live
test-live: ## Run tests including live OpenRouter integration tests
	RUN_LIVE_TESTS=1 uv run pytest tests/ -q

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*##' Makefile | sed 's/:.*## /\t/' | awk 'BEGIN {FS = "\t"}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
