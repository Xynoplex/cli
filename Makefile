.PHONY: all local build test vet

SDK_REPO ?= ../sdk
SDK_ARTIFACTS ?=
CONTAINER_RUNTIME ?= container
GO_IMAGE ?= golang:1.27.4
export SDK_REPO SDK_ARTIFACTS CONTAINER_RUNTIME GO_IMAGE

all: local

local: build

build:
	mkdir -p dist
	CONTAINER_RUNTIME="$(CONTAINER_RUNTIME)" GO_IMAGE="$(GO_IMAGE)" \
	  bash scripts/run-go-with-sdk.sh build -trimpath -o dist/xynaut ./cmd/xynaut

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
