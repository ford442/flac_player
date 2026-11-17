#!/usr/bin/env bash
# Third-party headers compiled into public/dsp-chain.wasm (src/sdl/dsp_stretch.h).
# Source it from a build script, then pass "${DSP_THIRD_PARTY_INCLUDES[@]}" to em++
# (DSP_THIRD_PARTY_DIRS holds the bare directories, for CMake):
#
#   PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/dsp-third-party.sh"
#   dsp_third_party_fetch
#
# Both are MIT, header-only, pinned by release tarball SHA-256 (the SpeexDSP
# pattern in build-resampler-wasm.sh) and unpacked under .build/dsp-third-party/.
# This file is part of the dsp-chain source hash (scripts/dsp-source-hash.sh), so a
# pin change is a stale artifact until public/dsp-chain.* is rebuilt.
#
#   Signalsmith Stretch 1.4.0  time / pitch stretch (signalsmith-stretch.h)
#   Signalsmith Linear 0.6.4   its FFT / STFT; the version Stretch 1.4.0's CMakeLists fetches
#
# Rubber Band is deliberately not here: it is GPL (or commercial), and the WASM
# binary would inherit that.

SIGNALSMITH_STRETCH_VERSION="1.4.0"
SIGNALSMITH_STRETCH_URL="https://github.com/Signalsmith-Audio/signalsmith-stretch/archive/refs/tags/${SIGNALSMITH_STRETCH_VERSION}.tar.gz"
SIGNALSMITH_STRETCH_SHA256="077235709ecf2a358545e3ca7bdf32859f70f5c9afb4493e078bd753c9aff284"

SIGNALSMITH_LINEAR_VERSION="0.6.4"
SIGNALSMITH_LINEAR_URL="https://github.com/Signalsmith-Audio/linear/archive/refs/tags/${SIGNALSMITH_LINEAR_VERSION}.tar.gz"
SIGNALSMITH_LINEAR_SHA256="2cb10d84b96c626255ab46c4aa4c80f64ae532be487063cff6a08903c1445a56"

# _dsp_fetch <url> <sha256> <tarball name> <unpacked dir name> <dest dir>
_dsp_fetch() {
  local url="$1" sha="$2" name="$3" dir="$4" dest="$5"
  local tarball="$dest/$name"
  if [ ! -f "$tarball" ]; then
    echo "Downloading $url"
    curl -fsSL -o "$tarball.part" "$url"
    mv "$tarball.part" "$tarball"
  fi
  if ! echo "$sha  $tarball" | sha256sum -c --quiet -; then
    echo "Error: $tarball does not match its pinned SHA-256 ($sha); delete it to re-download." >&2
    return 1
  fi
  if [ ! -f "$dest/$dir/.unpacked-$sha" ]; then
    rm -rf "${dest:?}/$dir"
    tar -xzf "$tarball" -C "$dest"
    touch "$dest/$dir/.unpacked-$sha"
  fi
}

dsp_third_party_fetch() {
  local root="${PROJECT_ROOT:?PROJECT_ROOT must be set before sourcing dsp-third-party.sh}"
  local dest="$root/.build/dsp-third-party"
  mkdir -p "$dest"
  _dsp_fetch "$SIGNALSMITH_STRETCH_URL" "$SIGNALSMITH_STRETCH_SHA256" \
    "signalsmith-stretch-${SIGNALSMITH_STRETCH_VERSION}.tar.gz" \
    "signalsmith-stretch-${SIGNALSMITH_STRETCH_VERSION}" "$dest" || return 1
  _dsp_fetch "$SIGNALSMITH_LINEAR_URL" "$SIGNALSMITH_LINEAR_SHA256" \
    "signalsmith-linear-${SIGNALSMITH_LINEAR_VERSION}.tar.gz" \
    "linear-${SIGNALSMITH_LINEAR_VERSION}" "$dest" || return 1
  DSP_THIRD_PARTY_DIRS=(
    "$dest/signalsmith-stretch-${SIGNALSMITH_STRETCH_VERSION}"
    "$dest/linear-${SIGNALSMITH_LINEAR_VERSION}/include"
  )
  DSP_THIRD_PARTY_INCLUDES=()
  local dir
  for dir in "${DSP_THIRD_PARTY_DIRS[@]}"; do DSP_THIRD_PARTY_INCLUDES+=(-I"$dir"); done
  echo "dsp third-party: signalsmith-stretch $SIGNALSMITH_STRETCH_VERSION, signalsmith-linear $SIGNALSMITH_LINEAR_VERSION"
}
