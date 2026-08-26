# dsh-timeplus — dev + release automation for the two packages.
#
#   make help                # list targets
#   make proton-up test      # start Proton, run the suite
#   make release-query       # build + npm publish + scoped tag + GitHub release
#
# Release naming: each package tags/releases independently as
# `<npm-name>@<version>` (e.g. @timeplus/dsh-session-query@0.0.1), read from its
# package.json. GitHub Releases are per package with per-package notes and no
# "Latest" badge (a monorepo has no single latest). Requires: pnpm, npm (logged
# in for publish), gh (authenticated), docker.

SHELL       := /bin/bash
PERSIST_DIR := packages/session-persistence-timeplus
QUERY_DIR   := packages/session-query-timeplus
TIMEPLUS_URL ?= http://localhost:8123

# Version bump argument for `make bump-*` (patch | minor | major | X.Y.Z).
VER ?= patch

.DEFAULT_GOAL := help

.PHONY: help install build build-persistence build-query typecheck test \
        proton-up proton-down clean \
        bump-persistence bump-query \
        publish-persistence publish-query \
        tag-persistence tag-query \
        gh-release-persistence gh-release-query \
        release-persistence release-query \
        _publish _tag _ghrelease _release _guard-clean

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | sort | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

# ---- dev ----------------------------------------------------------------

install: ## Install workspace dependencies (pnpm)
	pnpm install

build: build-persistence build-query ## Build both packages to lib/

build-persistence: ## Build the persistence package
	cd $(PERSIST_DIR) && pnpm build

build-query: ## Build the query package
	cd $(QUERY_DIR) && pnpm build

typecheck: ## Type-check both packages against the upstream checkout
	pnpm typecheck

test: ## Run the full test suite (needs Proton at TIMEPLUS_URL)
	TIMEPLUS_URL=$(TIMEPLUS_URL) pnpm test

proton-up: ## Start the throwaway Proton container and wait until ready
	docker compose up -d
	@echo "waiting for Proton..."; \
	until curl -sf '$(TIMEPLUS_URL)/?query=SELECT%201' >/dev/null 2>&1; do sleep 1; done; \
	echo "Proton ready at $(TIMEPLUS_URL)"

proton-down: ## Stop and remove the Proton container
	docker compose down

clean: ## Remove build output
	rm -rf $(PERSIST_DIR)/lib $(QUERY_DIR)/lib

# ---- version bumps (edit package.json only; commit yourself) -------------

bump-persistence: ## Bump persistence version (VER=patch|minor|major|X.Y.Z)
	cd $(PERSIST_DIR) && npm version $(VER) --no-git-tag-version

bump-query: ## Bump query version (VER=patch|minor|major|X.Y.Z)
	cd $(QUERY_DIR) && npm version $(VER) --no-git-tag-version

# ---- release building blocks (named targets recurse into the generics) ---

publish-persistence: ## npm publish the persistence package
	@$(MAKE) _publish DIR=$(PERSIST_DIR)
publish-query: ## npm publish the query package
	@$(MAKE) _publish DIR=$(QUERY_DIR)

tag-persistence: ## Create + push the scoped git tag for the persistence version
	@$(MAKE) _tag DIR=$(PERSIST_DIR)
tag-query: ## Create + push the scoped git tag for the query version
	@$(MAKE) _tag DIR=$(QUERY_DIR)

gh-release-persistence: ## Create the GitHub release for the persistence tag
	@$(MAKE) _ghrelease DIR=$(PERSIST_DIR)
gh-release-query: ## Create the GitHub release for the query tag
	@$(MAKE) _ghrelease DIR=$(QUERY_DIR)

release-persistence: ## Full release: build, publish, tag, GitHub release (persistence)
	@$(MAKE) _release DIR=$(PERSIST_DIR)
release-query: ## Full release: build, publish, tag, GitHub release (query)
	@$(MAKE) _release DIR=$(QUERY_DIR)

# ---- generic internals (DIR=<package dir>) -------------------------------

# Refuse to release from a dirty tree unless ALLOW_DIRTY=1.
_guard-clean:
	@if [ "$(ALLOW_DIRTY)" != "1" ] && [ -n "$$(git status --porcelain)" ]; then \
	  echo "working tree is dirty; commit first or set ALLOW_DIRTY=1"; exit 1; fi

_publish:
	cd $(DIR) && npm publish

_tag:
	@name=$$(node -p "require('./$(DIR)/package.json').name"); \
	ver=$$(node -p "require('./$(DIR)/package.json').version"); \
	tag="$$name@$$ver"; \
	if git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; then \
	  echo "tag already exists: $$tag"; \
	else \
	  git tag -a "$$tag" -m "$$name $$ver" && git push origin "$$tag" && echo "tagged $$tag"; \
	fi

_ghrelease:
	@name=$$(node -p "require('./$(DIR)/package.json').name"); \
	ver=$$(node -p "require('./$(DIR)/package.json').version"); \
	tag="$$name@$$ver"; \
	short=$${name#@timeplus/dsh-}; \
	prev=$$(git tag -l "$$name@*" | grep -v "^$$tag$$" | sort -V | tail -1); \
	if gh release view "$$tag" >/dev/null 2>&1; then \
	  echo "release already exists: $$tag"; \
	elif [ -n "$$prev" ]; then \
	  gh release create "$$tag" --title "$$short $$ver" --latest=false --notes-start-tag "$$prev" --generate-notes; \
	else \
	  gh release create "$$tag" --title "$$short $$ver" --latest=false --generate-notes; \
	fi

# Full pipeline: clean tree -> build -> publish -> tag -> GitHub release.
_release: _guard-clean
	@name=$$(node -p "require('./$(DIR)/package.json').name"); \
	ver=$$(node -p "require('./$(DIR)/package.json').version"); \
	echo ">> Releasing $$name@$$ver from $(DIR)"
	cd $(DIR) && pnpm build && npm publish
	@$(MAKE) _tag DIR=$(DIR)
	@$(MAKE) _ghrelease DIR=$(DIR)
	@echo ">> Done."
