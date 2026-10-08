#!/usr/bin/env bash
#
# Fetch the third-party ONNX models: the two the assistant's audio analysis
# needs, and the beat tracker behind the P2G mixer's pulse grid.
#
# They are not in the repository: together they are 97 MB of weights that
# belong to Google and to Descript, and redistributing them inside this GPLv3
# tree would be both a licensing mess and a heavy clone for every fork. The two
# small MLPs beside them (content_mlp.onnx, distortion_mlp.onnx) ARE in the
# repository — they were trained for this project and nothing public can
# reproduce them.
#
# Usage:  ./scripts/fetch-models.sh
#
# Override the source with MODELS_BASE_URL if you mirror the files internally.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/server/agents/assistantHost/audioAnalysis"
BASE_URL="${MODELS_BASE_URL:-https://github.com/amplify-project/Creative-Studio/releases/download/models-v1}"

# name  sha256  bytes  [directory, relative to the repo; default: the assistant's]
MODELS=(
  "yamnet_model.onnx b96e5ca9359eb99ba3e8e372729bd61ef24274c8aa0d53022bbbfb04388a4527 16093366"
  "dac_encoder.onnx  a1c803f21d3587f38ae97ed770eb553522e4946959fb2c42270e217d52c3b13a 86112298"
  "beat_this_small0.onnx 2cad8d23795432d66de48f2dccffa22448affb9886e1881f0662b76019c14653 11894174 scripts/models"
)

have() { command -v "$1" >/dev/null 2>&1; }

if ! have sha256sum && ! have shasum; then
  echo "error: need sha256sum or shasum to verify the downloads" >&2
  exit 1
fi

checksum() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$DEST"

for entry in "${MODELS[@]}"; do
  # shellcheck disable=SC2086
  set -- $entry
  name="$1"; want="$2"; size="$3"
  dir="$DEST"; [ -n "${4:-}" ] && dir="$ROOT/$4"
  mkdir -p "$dir"
  target="$dir/$name"

  if [ -f "$target" ] && [ "$(checksum "$target")" = "$want" ]; then
    echo "ok      $name (already present)"
    continue
  fi

  echo "fetch   $name ($(( size / 1048576 )) MB)"
  if have curl; then
    curl -fL --progress-bar -o "$target.part" "$BASE_URL/$name"
  elif have wget; then
    wget -q --show-progress -O "$target.part" "$BASE_URL/$name"
  else
    echo "error: need curl or wget" >&2
    exit 1
  fi

  got="$(checksum "$target.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$target.part"
    echo "error: checksum mismatch for $name" >&2
    echo "       expected $want" >&2
    echo "       got      $got" >&2
    echo "       Do NOT substitute your own export of these models: content_mlp" >&2
    echo "       and distortion_mlp were trained against the embeddings these" >&2
    echo "       exact files produce, and a different export shifts the" >&2
    echo "       embeddings without raising an error." >&2
    exit 1
  fi
  mv "$target.part" "$target"
  echo "ok      $name"
done

echo
echo "Models are in server/agents/assistantHost/audioAnalysis/ and scripts/models/."
echo "Licences: YAMNet is Apache-2.0 (Google), the DAC encoder is MIT (Descript),"
echo "Beat This! is MIT (JKU Linz). See each folder's README.md for provenance."
