.PHONY: all local build test vet clean help

SDK_REPO ?= ../sdk
SDK_ARTIFACTS ?=
CONTAINER_RUNTIME ?= container
GO_IMAGE ?= golang:1.27.4

HOST_OS := $(shell uname -s)
HOST_ARCH := $(shell uname -m)
ifeq ($(HOST_OS),Darwin)
HOST_GOOS := darwin
else ifeq ($(HOST_OS),Linux)
HOST_GOOS := linux
else ifneq (,$(filter MINGW% MSYS% CYGWIN%,$(HOST_OS)))
HOST_GOOS := windows
endif

ifeq ($(HOST_ARCH),arm64)
HOST_GOARCH := arm64
else ifeq ($(HOST_ARCH),aarch64)
HOST_GOARCH := arm64
else ifeq ($(HOST_ARCH),x86_64)
HOST_GOARCH := amd64
else ifeq ($(HOST_ARCH),AMD64)
HOST_GOARCH := amd64
endif

BUILD_TARGETS ?= darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64
HOST_TARGET := $(HOST_GOOS)/$(HOST_GOARCH)
HOST_EXTENSION := $(if $(filter windows,$(HOST_GOOS)),.exe)
export SDK_REPO SDK_ARTIFACTS CONTAINER_RUNTIME GO_IMAGE

all: local

help:
	@printf '%s\n' \
	  'Xynoplex CLI (xynaut)' \
	  '' \
	  'Build and verify:' \
	  '  make                  Build macOS, Linux, and Windows binaries (amd64 and arm64)' \
	  '  make local            Same as make' \
	  '  make build            Build the release architecture matrix into dist/' \
	  '  make test             Run the Go test suite' \
	  '  make vet              Run go vet across all packages' \
	  '' \
	  'Inputs:' \
	  '  SDK_REPO=<path>       SDK checkout used to resolve/build artifacts (default: ../sdk)' \
	  '  SDK_ARTIFACTS=<path>  Use and verify an existing SDK artifact bundle' \
	  '  CONTAINER_RUNTIME=<cmd> Select container, docker, or podman explicitly' \
	  '  GO_IMAGE=<image>      Go build container (default: golang:1.27.4)' \
	  '  BUILD_TARGETS="<os>/<arch> ..." Override the build matrix' \
	  '' \
	  'Clean:' \
	  '  make clean            Remove dist/, staged SDK artifacts, and coverage.out'

local: build

build:
	@mkdir -p dist
	CONTAINER_RUNTIME="$(CONTAINER_RUNTIME)" GO_IMAGE="$(GO_IMAGE)" \
	  bash scripts/run-go-with-sdk.sh build-matrix $(BUILD_TARGETS)
	@if [ -n "$(HOST_GOOS)" ] && [ -n "$(HOST_GOARCH)" ] && \
	  printf ' %s ' "$(BUILD_TARGETS)" | grep -Fq ' $(HOST_TARGET) '; then \
	  cp "dist/xynaut_$(HOST_GOOS)_$(HOST_GOARCH)$(HOST_EXTENSION)" "dist/xynaut$(HOST_EXTENSION)"; \
	  printf 'Host executable: %s\n' "$(CURDIR)/dist/xynaut$(HOST_EXTENSION)"; \
	fi
	@printf 'Release binaries are under: %s/dist\n' "$(CURDIR)"

test:
	@test -f protocol/specs/src/control/methods.json || { \
	  echo 'Protocol specs are missing. Clone with --recurse-submodules or run: git submodule update --init --recursive' >&2; \
	  exit 1; \
	}
	CONTAINER_RUNTIME="$(CONTAINER_RUNTIME)" GO_IMAGE="$(GO_IMAGE)" \
	  bash scripts/run-go-with-sdk.sh test ./...

vet:
	CONTAINER_RUNTIME="$(CONTAINER_RUNTIME)" GO_IMAGE="$(GO_IMAGE)" \
	  bash scripts/run-go-with-sdk.sh vet ./...

clean:
	rm -rf dist .local coverage.out
