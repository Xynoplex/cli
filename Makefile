.DEFAULT_GOAL := build

.PHONY: help build test vet clean

# `make help` prints the `##` lines below, in order (scripts/make-help.awk).
##@ Xynoplex CLI (xynolog): make [target] [VARIABLE=value ...]
##@ Variables
## CONTAINER_RUNTIME=name: container|docker|podman; else the first to respond
CONTAINER_RUNTIME ?=
## SDK_REPO=path: The SDK checkout that builds and resolves artifacts when SDK_ARTIFACTS is unset
SDK_REPO ?= ../sdk
## SDK_ARTIFACTS=path: Use and verify this SDK artifact bundle instead
SDK_ARTIFACTS ?=
## GO_IMAGE=image: The Go build container
GO_IMAGE ?= golang:1.27.4
## BUILD_TARGETS="os/arch ...": The platforms build compiles for
BUILD_TARGETS ?= darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64
export SDK_REPO SDK_ARTIFACTS CONTAINER_RUNTIME GO_IMAGE

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

HOST_TARGET := $(HOST_GOOS)/$(HOST_GOARCH)
HOST_EXTENSION := $(if $(filter windows,$(HOST_GOOS)),.exe)

help:
	@awk -f scripts/make-help.awk Makefile Makefile

##@ Build
## build: The release binaries for every BUILD_TARGETS platform into dist/, and the host's as dist/xynolog
build:
	@mkdir -p dist
	bash scripts/run-go-with-sdk.sh build-matrix $(BUILD_TARGETS)
	@if [ -n "$(HOST_GOOS)" ] && [ -n "$(HOST_GOARCH)" ] && \
	  printf ' %s ' "$(BUILD_TARGETS)" | grep -Fq ' $(HOST_TARGET) '; then \
	  cp "dist/xynolog_$(HOST_GOOS)_$(HOST_GOARCH)$(HOST_EXTENSION)" "dist/xynolog$(HOST_EXTENSION)"; \
	  printf 'Host executable: %s\n' "$(CURDIR)/dist/xynolog$(HOST_EXTENSION)"; \
	fi
	@printf 'Release binaries are under: %s/dist\n' "$(CURDIR)"

##@ Verify
## test: The Go test suite
test:
	@test -f protocol/specs/src/control/methods.json || { \
	  echo 'Protocol specs are missing. Clone with --recurse-submodules or run: git submodule update --init --recursive' >&2; \
	  exit 1; \
	}
	bash scripts/run-go-with-sdk.sh test ./...

## vet: go vet across every package
vet:
	bash scripts/run-go-with-sdk.sh vet ./...

##@ Clean
## clean: Remove dist/, staged SDK artifacts and coverage.out
clean:
	rm -rf dist .local coverage.out
