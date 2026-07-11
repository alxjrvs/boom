# boom — dev tasks (TypeScript on Bun). These lanes mirror CI.
.PHONY: all check lint fmt typecheck test build build-all

all: check

check: lint typecheck test ## CI parity: lint + format-check + typecheck + tests

lint: ## biome lint + format check
	bunx biome check .

fmt: ## biome lint + format, applying safe fixes
	bunx biome check --write .

typecheck: ## tsc --noEmit
	bunx tsc --noEmit

test: ## bun test
	bun test

build: ## compile a standalone binary for the host
	bun build src/index.ts --compile --outfile build/boom

build-all: ## cross-compile the release target matrix
	@for t in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64; do \
		echo "compiling $$t"; \
		bun build src/index.ts --compile --target=$$t --outfile build/boom-$$t; \
	done
