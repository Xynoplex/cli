#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
[[ $# -gt 0 ]] || { echo "Usage: $0 <go command> [args ...]" >&2; exit 2; }
bundle="$(bash "$ROOT/scripts/prepare-sdk-artifacts.sh")"
bundle_id="$(basename "$bundle")"
bundle_dir="$ROOT/.local/sdk-artifacts/$bundle_id"
mkdir -p "$bundle_dir"
cp -a "$bundle/." "$bundle_dir/"
relative_bundle=".local/sdk-artifacts/$bundle_id"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"
GO_IMAGE="${GO_IMAGE:-golang:1.27.4}"
"$CONTAINER_RUNTIME" run --rm -v "$ROOT:/source" -w /source \
  -e "GOPROXY=file:///source/$relative_bundle/go/go-proxy,https://proxy.golang.org" \
  -e GONOSUMDB=github.com/Xynoplex/sdk/go \
  "$GO_IMAGE" sh -euc 'go mod download github.com/Xynoplex/sdk/go && go "$@"' sh "$@"
