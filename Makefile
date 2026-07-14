# OmniRoute Websearch CLI - Makefile
# Targets for building, testing, and installing the CLI

.PHONY: help build clean test install uninstall healthcheck search

# Default target
.DEFAULT_GOAL := help

# Variables
NODE ?= node
NPM ?= npm
API_KEY ?= $(OMNIROUTE_API_KEY)
CLI_PATH := dist/index.js

# ============================================================
# HELP
# ============================================================
help: ## Show available commands
	@echo "OmniRoute Websearch CLI - Available Commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Usage: make <command>"
	@echo ""
	@echo "Configuration:"
	@echo "  Export OMNIROUTE_CUSTOM_WEBSEARCH_URL and OMNIROUTE_API_KEY (env-only)."
	@echo ""

# ============================================================
# BUILD
# ============================================================
build: ## Build TypeScript to dist/
	$(NPM) run build

clean: ## Remove build artifacts
	rm -rf dist/

# ============================================================
# TEST
# ============================================================
test: build ## Run unit tests
	$(NODE) --test dist/**/*.test.js

# ============================================================
# INSTALL
# ============================================================
install: build ## Install CLI globally (npm link)
	$(NPM) link

uninstall: ## Uninstall global CLI link
	$(NPM) unlink -g omniroute-websearch-cli

# ============================================================
# CONVENIENCE
# ============================================================
healthcheck: build ## Run healthcheck locally
	$(NODE) $(CLI_PATH) healthcheck

search: build ## Run search (usage: make search Q="query")
ifdef Q
	$(NODE) $(CLI_PATH) search "$(Q)"
else
	@echo "Usage: make search Q=\"your query\""
endif

# ============================================================
# DEVELOPMENT
# ============================================================
dev: ## Watch and rebuild on changes
	$(NPM) run dev

.PHONY: all
all: clean build
