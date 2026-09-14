# Makefile for the Go DECX CLI (macOS and Linux; POSIX make + shell).
#
# The CLI embeds the QuickJS plugin engine (github.com/buke/quickjs-go), which
# needs cgo, so the binary can only be built with a native C toolchain and
# cannot be cross-compiled. CI runs one native runner per target:
# linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64 and
# windows/arm64.
#
# Windows: make is not required (and this Makefile assumes a POSIX shell).
# From the decx/ directory, run:
#
#     go run ./cmd/pack
#
# which builds and packs the CLI archive for the host platform. Go must be able
# to find a C compiler: keep CGO_ENABLED=1 (the default) and set CC to a native
# compiler when the default does not fit, e.g. under msys2 CLANGARM64 for
# windows/arm64:
#
#     set CC=aarch64-w64-mingw32-gcc
#
# Environment:
#   CGO_ENABLED=1   mandatory: the embedded plugin engine needs cgo
#   CC              native C compiler (defaults per platform)
#   NPM, NODE       Node.js tooling for the ard-framework plugin (default: PATH)
#
# Targets: build, test, release, install, doctor, plugins, plugin-test, clean.

VERSION := $(shell cat ../version)

PLUGIN_DIR := ../plugins/ard-framework

NPM ?= npm
NODE ?= node

.PHONY: build test release install doctor check-tools clean plugins plugin-test

build: plugins
	go build -trimpath -ldflags '-X main.version=$(VERSION)' -o dist/decx ./cmd/decx

test: plugins plugin-test
	go test -race ./...
	go vet ./...

release:
	go run ./cmd/pack

install: plugins
	go install -ldflags '-X main.version=$(VERSION)' ./cmd/decx

# doctor reports the host platform and proves the native cgo build works. The
# embedded plugin engine cannot be cross-compiled, so each platform builds on
# its own host.
doctor:
	@command -v go >/dev/null 2>&1 || { echo "error: go not found on PATH; install Go 1.25+ from https://go.dev/dl/"; exit 1; }
	@printf 'host:      %s/%s\n' "$$(go env GOOS)" "$$(go env GOARCH)"
	@printf 'toolchain: %s\n' "$$(go version)"
	@printf 'cgo:       CGO_ENABLED=%s CC=%s\n' "$$(go env CGO_ENABLED)" "$$(go env CC)"
	@if [ "$$(go env CGO_ENABLED)" != "1" ]; then \
		echo "error: CGO_ENABLED is not 1; the embedded plugin engine needs cgo (try: CGO_ENABLED=1 make doctor)"; \
		exit 1; \
	fi
	@go build -o /dev/null ./cmd/decx
	@echo "ok: this host builds the decx CLI natively"

# The framework plugin is authored in TypeScript; the embedded runtime executes
# the compiled CommonJS output under plugins/ard-framework/dist. Fail with a
# clear message when the Node.js tooling is missing instead of inside npm.
check-tools:
	@command -v $(NPM) >/dev/null 2>&1 || { \
		echo "error: npm not found on PATH; Node.js 24+ is required for the ard-framework plugin bundle (https://nodejs.org)"; \
		exit 1; \
	}
	@command -v $(NODE) >/dev/null 2>&1 || { \
		echo "error: node not found on PATH; Node.js 24+ is required for the ard-framework plugin bundle (https://nodejs.org)"; \
		exit 1; \
	}

plugins: check-tools
	cd $(PLUGIN_DIR) && $(NPM) ci --no-audit --no-fund && $(NPM) run build

plugin-test: plugins
	cd $(PLUGIN_DIR) && $(NODE) --test "dist/tests/*.test.js"

clean:
	go clean
	rm -rf dist
