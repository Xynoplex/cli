#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
source "$ROOT/scripts/container-runtime.sh"
[[ $# -gt 0 ]] || { echo "Usage: $0 <go command> [args ...]" >&2; exit 2; }
bundle="$(bash "$ROOT/scripts/prepare-sdk-artifacts.sh")"
bundle_id="$(basename "$bundle")"
bundle_dir="$ROOT/.local/sdk-artifacts/$bundle_id"
mkdir -p "$bundle_dir"
cp -a "$bundle/." "$bundle_dir/"
relative_bundle=".local/sdk-artifacts/$bundle_id"
: "${GO_IMAGE:?Set GO_IMAGE to a Go container image.}"
RUNTIME="$(detect_container_runtime)"
"$RUNTIME" run --rm -v "$ROOT:/source" -w /source \
  -e "GOOS=${GOOS:-}" -e "GOARCH=${GOARCH:-}" -e "CGO_ENABLED=${CGO_ENABLED:-}" \
  -e "GOPROXY=file:///source/$relative_bundle/go/go-proxy,https://proxy.golang.org" \
  -e GONOSUMDB=github.com/Xynoplex/sdk/go \
  "$GO_IMAGE" sh -euc '
    run_go() {
      log="$(mktemp)"
      if go "$@" 2>"$log"; then
        sed "/^go: downloading /d" "$log" >&2
        rm -f "$log"
      else
        status=$?
        cat "$log" >&2
        rm -f "$log"
        return "$status"
      fi
    }

    run_go_target() {
      target_os="$1"
      target_arch="$2"
      shift 2
      log="$(mktemp)"
      if GOOS="$target_os" GOARCH="$target_arch" CGO_ENABLED=0 go "$@" 2>"$log"; then
        sed "/^go: downloading /d" "$log" >&2
        rm -f "$log"
      else
        status=$?
        cat "$log" >&2
        rm -f "$log"
        return "$status"
      fi
    }

    run_go mod download github.com/Xynoplex/sdk/go
    if [ "$1" = build-matrix ]; then
      shift
      [ "$#" -gt 0 ] || { echo "build-matrix requires at least one GOOS/GOARCH target" >&2; exit 2; }
      for target do
        case "$target" in
          darwin/amd64|darwin/arm64|linux/amd64|linux/arm64|windows/amd64|windows/arm64) ;;
          *) echo "Unsupported release target: $target" >&2; exit 2 ;;
        esac
        target_os="${target%/*}"
        target_arch="${target#*/}"
        suffix=
        [ "$target_os" != windows ] || suffix=.exe
        output="dist/xynolog_${target_os}_${target_arch}${suffix}"
        echo "Building Xynolog for $target -> $output"
        run_go_target "$target_os" "$target_arch" build -trimpath -o "$output" ./cmd/xynolog
      done
    else
      run_go "$@"
    fi
  ' sh "$@"
