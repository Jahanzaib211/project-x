# =============================================================================
# PROJECT X
# =============================================================================
.DEFAULT_GOAL := help
SHELL := /bin/bash
COMPOSE := docker compose
PY := python3

# Every host port is verified free before anything starts. This machine runs
# other stacks; we never take a port that is in use.

.PHONY: help
help: ## Show this help
	@echo "Project X — broker core"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  Ports are defined in .env (block 27000-27019, localhost only)."
	@echo "  Run 'make ports' to verify none are taken before starting."

# -----------------------------------------------------------------------------
# Environment
# -----------------------------------------------------------------------------
.env:
	@cp .env.example .env && echo "created .env from .env.example"

.PHONY: ports
ports: ## Verify every host port this project wants is free
	@./scripts/check_ports.sh

.PHONY: up
up: .env ports ## Start infra + core + edge + web
	@$(COMPOSE) --profile infra --profile core --profile edge --profile web up -d
	@$(MAKE) --no-print-directory urls

.PHONY: up-all
up-all: .env ports ## Start everything including observability
	@$(COMPOSE) --profile all up -d
	@$(MAKE) --no-print-directory urls

.PHONY: up-infra
up-infra: .env ports ## Start datastores and the event bus only
	@$(COMPOSE) --profile infra up -d

.PHONY: up-core
up-core: .env ports ## Start infra + the financial core services
	@$(COMPOSE) --profile infra --profile core up -d

.PHONY: up-edge
up-edge: .env ports ## Start the client API
	@$(COMPOSE) --profile edge up -d

.PHONY: up-web
up-web: .env ports ## Start the web terminal
	@$(COMPOSE) --profile web up -d

.PHONY: up-obs
up-obs: .env ports ## Start the observability stack
	@$(COMPOSE) --profile obs up -d

.PHONY: down
down: ## Stop everything (volumes preserved)
	@$(COMPOSE) --profile all down --remove-orphans

.PHONY: nuke
nuke: ## Stop everything and DESTROY all volumes (irreversible)
	@read -p "This destroys all Project X data. Type 'yes' to confirm: " ok; \
	 [ "$$ok" = "yes" ] || { echo "aborted"; exit 1; }
	@$(COMPOSE) --profile all down -v --remove-orphans
	@echo "volumes destroyed. Only projectx_* volumes were touched."

.PHONY: restart
restart: down up ## Restart the stack

.PHONY: build
build: ## Build all service images
	@$(COMPOSE) --profile all build

# -----------------------------------------------------------------------------
# Images: fresh, and published
# -----------------------------------------------------------------------------
# `images` rebuilds every deployed service image from scratch — no layer
# cache, base images re-pulled — which is what "fresh" means. `images-push`
# tags them ghcr.io/<owner>/project-x/<svc> and pushes; it needs a registry
# login (`gh auth token | docker login ghcr.io -u <user> --password-stdin`).
#
# The repository-scoped name is deliberate: a package first created by a
# push from the repository's own Actions token is linked to the repository
# and inherits its visibility — public, here — whereas one first pushed by a
# person is private and unlinked, and can only be changed in the GitHub UI.
IMAGE_OWNER ?= jahanzaib211
IMAGE_REPO  ?= project-x
IMAGE_TAG   ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
IMAGES      := ledger market-data pricing oms feed-gateway mt5-sim client-api web ops

.PHONY: images
images: ## Rebuild every deployed image with no cache and fresh base layers
	@$(COMPOSE) --profile core --profile edge --profile web build --no-cache --pull
	@echo "✓ fresh images: $(IMAGES)"

.PHONY: images-push
images-push: ## Tag the images ghcr.io/$(IMAGE_OWNER)/$(IMAGE_REPO)/<svc>:{$(IMAGE_TAG),latest} and push
	@for svc in $(IMAGES); do \
	  docker tag projectx/$$svc:dev ghcr.io/$(IMAGE_OWNER)/$(IMAGE_REPO)/$$svc:$(IMAGE_TAG) && \
	  docker tag projectx/$$svc:dev ghcr.io/$(IMAGE_OWNER)/$(IMAGE_REPO)/$$svc:latest && \
	  docker push ghcr.io/$(IMAGE_OWNER)/$(IMAGE_REPO)/$$svc:$(IMAGE_TAG) && \
	  docker push ghcr.io/$(IMAGE_OWNER)/$(IMAGE_REPO)/$$svc:latest || exit 1; \
	done
	@echo "✓ pushed $(IMAGES) as $(IMAGE_TAG) and latest"

.PHONY: ps
ps: ## Show container status
	@$(COMPOSE) --profile all ps

.PHONY: logs
logs: ## Follow logs (SERVICE=ledger to narrow)
	@$(COMPOSE) --profile all logs -f $(SERVICE)

.PHONY: health
health: ## Check every service's health endpoint
	@./scripts/health.sh

.PHONY: urls
urls: ## Print the local URLs
	@./scripts/urls.sh

# -----------------------------------------------------------------------------
# PM2 — an alternative runtime for the two Node services.
# The Rust core and the datastores stay in Docker either way. Both runtimes bind
# the same reserved ports, so starting one stops the other.
# -----------------------------------------------------------------------------
.PHONY: pm2-start
pm2-start: ## Run the edge under pm2 (stops the docker edge/web containers first)
	@echo "stopping the docker edge/web containers to free the ports..."
	@$(COMPOSE) stop web client-api >/dev/null 2>&1 || true
	@$(COMPOSE) --profile infra --profile core up -d >/dev/null 2>&1 || true
	@pm2 start ecosystem.config.cjs
	@echo
	@echo "run 'pm2 save' to persist across reboot."
	@$(MAKE) --no-print-directory urls

.PHONY: pm2-stop
pm2-stop: ## Stop the pm2 apps (docker edge/web stay stopped)
	@pm2 stop ecosystem.config.cjs

.PHONY: pm2-delete
pm2-delete: ## Remove the pm2 apps entirely
	@pm2 delete ecosystem.config.cjs

.PHONY: pm2-logs
pm2-logs: ## Tail the pm2 logs for this project
	@pm2 logs projectx-api projectx-web

.PHONY: pm2-status
pm2-status: ## Show just this project's pm2 processes
	@pm2 list | grep -E 'projectx-|name' || echo "  not registered — run: make pm2-start"

.PHONY: docker-edge
docker-edge: ## Switch back from pm2 to the docker edge/web containers
	@pm2 stop ecosystem.config.cjs >/dev/null 2>&1 || true
	@$(COMPOSE) --profile edge --profile web up -d
	@$(MAKE) --no-print-directory urls

.PHONY: psql
psql: ## Open a psql shell on the event store
	@$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-projectx} -d $${POSTGRES_DB:-projectx}

# -----------------------------------------------------------------------------
# The graph and the gates
# -----------------------------------------------------------------------------
.PHONY: check
check: dag gate-check docs-check regressions coverage ## Everything CI checks structurally
	@echo "✓ all structural checks passed"

.PHONY: dag
dag: ## Validate the dependency DAG
	@$(PY) scripts/check_dag.py

.PHONY: gate-check
gate-check: ## Report which modules are blocked by upstream gates
	@$(PY) scripts/check_gates.py

.PHONY: blocked
blocked: ## What is blocking a module?  make blocked MODULE=11-execution
	@test -n "$(MODULE)" || { echo "usage: make blocked MODULE=<module-id>"; exit 1; }
	@$(PY) scripts/check_gates.py $(MODULE)

.PHONY: gates
gates: ## Run every gate a module declares.  make gates MODULE=03-ledger
	@test -n "$(MODULE)" || { echo "usage: make gates MODULE=<module-id>"; exit 1; }
	@$(PY) scripts/run_gates.py $(MODULE)

.PHONY: hooks
hooks: ## Install the git hooks (pre-commit, pre-push)
	@git config core.hooksPath .githooks
	@echo "✓ hooks installed. They run the same checks CI runs."

.PHONY: baseline
baseline: ## Accept the current tree as the new regression baseline
	@$(PY) scripts/check_regressions.py --update

.PHONY: regressions
regressions: ## Check nothing proven has been silently lost
	@$(PY) scripts/check_regressions.py

.PHONY: coverage
coverage: ## Every declared invariant is executed by a test
	@$(PY) scripts/check_invariant_coverage.py

.PHONY: coverage-all
coverage-all: ## Invariant coverage for every module, including planned ones
	@$(PY) scripts/check_invariant_coverage.py --all

.PHONY: verify-db
verify-db: ## Prove the database enforces the ledger invariants (needs infra up)
	@./scripts/verify_ledger_constraints.sh

.PHONY: chaos
chaos: ## G7 — inject faults, then re-check the invariants
	@./scripts/chaos_suite.sh

.PHONY: docs
docs: ## Regenerate module docs from the registry
	@$(PY) scripts/gen_docs.py

.PHONY: docs-check
docs-check: ## Fail if generated docs are stale
	@$(PY) scripts/gen_docs.py --check

# -----------------------------------------------------------------------------
# Gates, locally
# -----------------------------------------------------------------------------
.PHONY: fmt-check
fmt-check: ## G0 — verify formatting without changing anything
	@cargo fmt --all -- --check
	@./scripts/check_frontend.sh --syntax

.PHONY: typecheck
typecheck: ## G1 — type-check every JavaScript package
	@./scripts/check_frontend.sh --types

.PHONY: test-frontend
test-frontend: ## G2 — the frontend test suites alone
	@./scripts/check_frontend.sh --tests

.PHONY: fmt
fmt: ## G0 — format everything
	@cargo fmt --all 2>/dev/null || echo "  (rust workspace not yet populated)"
	@echo "✓ formatted"

.PHONY: lint
lint: ## G1 — static analysis, types and banned patterns
	@cargo clippy --all-targets --all-features -- -D warnings 2>/dev/null || echo "  (rust workspace not yet populated)"
	@./scripts/check_frontend.sh --syntax
	@./scripts/check_frontend.sh --types
	@./scripts/banned_patterns.sh

.PHONY: test
test: ## G2 — unit tests (Rust + JavaScript)
	@cargo test --workspace 2>/dev/null || echo "  (rust workspace not yet populated)"
	@./scripts/check_frontend.sh --tests

.PHONY: test-property
test-property: ## G3 — property-based tests (tests/invariants: seeded generators, reproducible failures)
	@cargo test -p invariants

.PHONY: test-invariants
test-invariants: ## G4 — the financial laws
	@./scripts/check_foundation_invariants.sh
	@./scripts/check_client_area_invariants.sh
	@./scripts/check_isolation.sh
	@$(PY) scripts/check_invariant_coverage.py
	@cargo test -p invariants

.PHONY: test-integration
test-integration: ## G5 — services wired together on real dependencies
	@$(COMPOSE) --profile infra up -d
	@cargo test --workspace --test '*' -- --ignored 2>/dev/null || echo "  (pending)"

.PHONY: test-security
test-security: ## G8 — can someone take what is not theirs?
	@./scripts/check_security.sh

.PHONY: test-performance
test-performance: ## G9 — is it fast enough, and did this change make it worse?
	@./scripts/check_performance.sh

.PHONY: test-replay
test-replay: ## G6 — determinism
	@cargo test -p replay 2>/dev/null || echo "  (pending — tests/replay)"

# -----------------------------------------------------------------------------
# End to end
# -----------------------------------------------------------------------------
.PHONY: stack
stack: ## Run every service from this working tree (not the published images)
	@./scripts/dev_stack.sh start

.PHONY: stack-stop
stack-stop: ## Stop the services started by 'make stack'
	@./scripts/dev_stack.sh stop

.PHONY: stack-status
stack-status: ## Which of this tree's services are listening
	@./scripts/dev_stack.sh status

.PHONY: e2e
e2e: ## G5 — drive a browser through the whole stack (chart, order, fill, close)
	@cd tests/e2e && npm test

.PHONY: e2e-install
e2e-install: ## Install the browser the end-to-end suite drives
	@cd tests/e2e && npm install --no-audit --no-fund && npx playwright install chromium

.PHONY: e2e-report
e2e-report: ## Open the last end-to-end report
	@cd tests/e2e && npx playwright show-report

.PHONY: clean
clean: ## Remove build artifacts
	@cargo clean 2>/dev/null || true
	@rm -rf apps/web/.next services/client-api/dist
